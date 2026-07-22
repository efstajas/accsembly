'use strict';

// Drives the browser. Everything here is plumbing: measure boxes, copy
// numbers between attributes, read widths back. The arithmetic that turns
// mnemonics into machine code happens in the cascade.

const { chromium } = require('playwright');
const { buildPage } = require('./html');
const { NUM, IDENT } = require('./lexer');

// Known only so we can produce decent *error messages* (undefined symbols,
// jump range). Encoding stays in the stylesheet.
const REGS = new Set([
  'ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di',
  'al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh',
  'es', 'cs', 'ss', 'ds',
]);
const REL8_OPS = new Set([
  'je', 'jz', 'jne', 'jnz', 'jb', 'jae', 'jbe', 'ja',
  'jl', 'jge', 'jle', 'jg', 'loop',
  'jo', 'jno', 'jc', 'jnc', 'js', 'jns', 'jp', 'jpe', 'jnp', 'jpo',
  'jcxz', 'loope', 'loopz', 'loopne', 'loopnz',
]);
// mnemonics that appear in operand position (rep movsb) — not symbols
const OPERAND_KEYWORDS = new Set([
  'movsb', 'movsw', 'cmpsb', 'cmpsw', 'stosb', 'stosw', 'lodsb', 'lodsw', 'scasb', 'scasw',
]);

class AsmError extends Error {
  constructor(lineNo, msg) {
    super(lineNo ? `line ${lineNo}: ${msg}` : msg);
    this.lineNo = lineNo;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = (count, budgetMs) => Math.max(40, Math.min(300, Math.floor(budgetMs / Math.max(count, 1))));

async function assemble(items, css, opts = {}) {
  const browser = await chromium.launch({ headless: opts.headless ?? !opts.show });
  try {
    const page = await browser.newPage();
    return await assembleOn(page, items, css, opts);
  } finally {
    await browser.close();
  }
}

// core two-pass drive against an existing page (reusable across programs)
async function assembleOn(page, items, css, opts = {}) {
  // default origin: a .COM file loads at 0x100 — if the source doesn't say,
  // prepend the directive (the spacer element has to exist for layout to
  // start counting from the right place)
  if (!items.some((it) => it.kind === 'org')) {
    items = [{ kind: 'org', n: '256', lineNo: 0, src: 'org 256 (implicit)' }, ...items];
  }
  const orgIndex = items.findIndex((it) => it.kind === 'org');
  for (const [i, it] of items.entries()) {
    if (it.kind === 'org' && i !== orgIndex) throw new AsmError(it.lineNo, 'only one org, and it must come first');
    if (it.kind !== 'blank' && it.kind !== 'org' && it.kind !== 'equ' && i < orgIndex) {
      throw new AsmError(items[orgIndex].lineNo, 'org must come before any code');
    }
  }
  const pads = items.filter((it) => it.kind === 'pad');
  if (pads.length > 1) throw new AsmError(pads[1].lineNo, 'only one pad per program');

  const html = buildPage(items, css, opts.sourceName || 'source.asm');
  await page.setContent(html);
  {
    const setPhase = (p) => page.evaluate((ph) => document.body.setAttribute('phase', ph), p);
    if (opts.show) {
      await setPhase('pass1');
      await sleep(1400); // let the audience appreciate the unresolved state
    }

    // ---- pass 1: read the location counter off the layout ----------------
    const measureStrip = () =>
      page.$$eval('#strip .ln', (els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { i: +el.getAttribute('data-i'), x: Math.round(r.x), w: Math.round(r.width) };
        })
      );
    // equ constants: their value is the width of their out-of-flow box
    const constBoxes = await page.$$eval('#consts .ln', (els) =>
      els.map((el) => ({ i: +el.getAttribute('data-i'), w: Math.round(el.getBoundingClientRect().width) }))
    );

    // ---- pass 2: fixups — copy measured numbers into attributes ----------
    const computeFixups = (measured) => {
      const symtab = new Map();
      for (const cb of constBoxes) {
        const it = items[cb.i];
        if (symtab.has(it.name)) throw new AsmError(it.lineNo, `duplicate symbol '${it.name}'`);
        symtab.set(it.name, cb.w);
      }
      for (const b of measured) {
        const it = items[b.i];
        if (it.kind === 'lbl') {
          if (symtab.has(it.name)) throw new AsmError(it.lineNo, `duplicate label '${it.name}'`);
          symtab.set(it.name, b.x);
        }
      }
      const fixups = {};
      for (const b of measured) {
        const it = items[b.i];
        if (it.kind === 'org') continue;
        const f = { at: b.x };
        const symbols = new Set();
        // role decides which wire the fixup rides: toa/tob (operand slots),
        // tod (memory displacement), to (dw cells)
        const resolve = (name, role) => {
          if (!symtab.has(name)) throw new AsmError(it.lineNo, `undefined symbol '${name}'`);
          symbols.add(name);
          f.to = symtab.get(name);
          f.role = role;
        };
        if (it.kind === 'op') {
          if (it.am && it.bm) throw new AsmError(it.lineNo, 'at most one memory operand per instruction (x86 agrees)');
          for (const [role, operand] of [['a', it.a], ['b', it.b]]) {
            if (operand == null || NUM.test(operand)) continue;
            if (REGS.has(operand.toLowerCase()) || OPERAND_KEYWORDS.has(operand.toLowerCase())) continue;
            if (!IDENT.test(operand)) continue;
            resolve(operand, role);
          }
          for (const mo of [it.am, it.bm]) {
            if (!mo) continue;
            if (mo.w2 != null && !REGS.has(mo.w2.toLowerCase())) {
              throw new AsmError(it.lineNo, `unsupported memory operand '${mo.raw}' (base register first, index register second)`);
            }
            if (mo.w1 != null && !REGS.has(mo.w1.toLowerCase())) resolve(mo.w1, 'd');
          }
        }
        if (it.kind === 'dw') {
          for (const w of it.words) if (w.t === 's') resolve(w.v, 'w');
        }
        if (symbols.size > 1) {
          throw new AsmError(it.lineNo, `one symbol reference per line (the stylesheet has a single 'to' wire): ${[...symbols].join(', ')}`);
        }
        fixups[b.i] = f;
      }
      return { symtab, fixups };
    };
    // runs in the page: apply one fixup and move the highlight cursor there
    const applyOne = ([i, f, cursor]) => {
      document.querySelectorAll('.fixing').forEach((el) => el.classList.remove('fixing'));
      document.querySelectorAll(`[data-i="${i}"]`).forEach((el) => {
        el.setAttribute('at', f.at);
        if (f.to != null) el.setAttribute(f.role === 'w' ? 'to' : 'to' + f.role, f.to);
        if (cursor && (el.classList.contains('lrow') || el.classList.contains('tp'))) el.classList.add('fixing');
      });
    };

    // Relaxation: a jmp's width depends on its distance, and every distance
    // depends on widths. Assemble = re-render until the layout stops moving.
    let boxes;
    let symtab;
    let fixups;
    let prevSig = null;
    for (let iter = 0; iter < 12; iter++) {
      boxes = await measureStrip();
      ({ symtab, fixups } = computeFixups(boxes));
      const sig = JSON.stringify(fixups);
      if (sig === prevSig) break;
      prevSig = sig;
      if (opts.show && iter === 0) {
        await setPhase('pass2');
        const dt = pace(Object.keys(fixups).length, 4000);
        for (const [i, f] of Object.entries(fixups)) {
          await page.evaluate(applyOne, [i, f, true]);
          await sleep(dt);
        }
      } else {
        for (const [i, f] of Object.entries(fixups)) await page.evaluate(applyOne, [i, f, false]);
      }
    }
    const byIndex = new Map(boxes.map((b) => [b.i, b]));

    // range diagnostics (the stylesheet will happily wrap; we warn like adults)
    const checkRanges = (measured, fx) => {
      for (const b of measured) {
        const it = items[b.i];
        if (it.kind !== 'op' || !REL8_OPS.has(it.op.toLowerCase())) continue;
        const f = fx[b.i];
        const target = f.to != null ? f.to : NUM.test(it.a || '') ? +it.a : null;
        if (target == null) continue;
        const rel = target - (f.at + 2);
        if (rel < -128 || rel > 127) {
          throw new AsmError(it.lineNo, `jump target out of rel8 range (${rel} bytes away; max ±127)`);
        }
      }
    };
    checkRanges(boxes, fixups);

    // ---- read the machine code off the output bus ------------------------
    // runs in the page: measure one line's byte boxes, move the readout cursor
    const readOne = ([i, cursor]) => {
      if (cursor) {
        document.querySelectorAll('.reading').forEach((el) => el.classList.remove('reading'));
        document.querySelectorAll(`[data-i="${i}"]`).forEach((el) => {
          if (el.classList.contains('lrow') || el.classList.contains('tp')) el.classList.add('reading');
        });
      }
      const el = document.querySelector(`#bytes .ln[data-i="${i}"]`);
      return [...el.querySelectorAll('v,u,d,e')].map((s) => Math.round(s.getBoundingClientRect().width));
    };
    const rowIndices = boxes.map((b) => b.i);
    const rows = [];
    if (opts.show) {
      // Every line exists three times (strip, byte bus, listing). Mirror
      // devtools attribute edits across the copies so what the operator sees
      // is what gets read out. Plumbing, not computation: the cascade still
      // does all the encoding.
      await page.evaluate(() => {
        const ATTRS = ['op', 'a', 'b', 'n', 'c', 'at', 'to', 'toa', 'tob', 'tod', 'k'];
        const CONTENT_ATTRS = ['op', 'a', 'b', 'n', 'c'];
        new MutationObserver((muts) => {
          for (const m of muts) {
            const el = m.target;
            const name = m.attributeName;
            const val = el.getAttribute(name);
            const line = el.closest('[data-i]');
            if (!line) continue;
            if (CONTENT_ATTRS.includes(name)) line.classList.add('edited');
            const i = line.getAttribute('data-i');
            const cellIdx = el.tagName === 'D' ? [...line.querySelectorAll('d')].indexOf(el) : -1;
            document.querySelectorAll(`[data-i="${i}"]`).forEach((twinLine) => {
              const twin = cellIdx >= 0 ? twinLine.querySelectorAll('d')[cellIdx] : twinLine;
              if (!twin || twin === el || twin.getAttribute(name) === val) return;
              if (val == null) twin.removeAttribute(name);
              else twin.setAttribute(name, val);
            });
          }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ATTRS });
      });
      // hand the room over to the operator: clear the pass-2 cursor, go LIVE
      await page.evaluate(() => {
        document.querySelectorAll('.fixing').forEach((el) => el.classList.remove('fixing'));
      });
      await setPhase('live');
      // hand the operator the live compiler before committing bytes to disk
      if (opts.pause) await opts.pause(page);
      // relink: live surgery may have moved labels or resized instructions,
      // so rerun pass 1 + fixups from fresh measurements
      const fresh = await measureStrip();
      for (const b of fresh) byIndex.set(b.i, b);
      ({ symtab, fixups } = computeFixups(fresh));
      for (const [i, f] of Object.entries(fixups)) await page.evaluate(applyOne, [i, f, false]);
      checkRanges(fresh, fixups);
      await setPhase('readout');
      const dt = pace(rowIndices.length, 4000);
      for (const i of rowIndices) {
        rows.push({ i, widths: await page.evaluate(readOne, [i, true]) });
        await sleep(dt);
      }
    } else {
      for (const i of rowIndices) rows.push({ i, widths: await page.evaluate(readOne, [i, false]) });
    }

    const chunks = [];
    const listing = [];
    const orgIt = items.find((x) => x.kind === 'org');
    for (const row of rows) {
      const it = items[row.i];
      const box = byIndex.get(row.i);
      if (it.kind === 'pad') {
        // the flex layout solved (target - code) for us; sanity-check the fit
        const target = Number(orgIt.n) + Number(it.n);
        if (box.x + box.w !== target) {
          throw new AsmError(it.lineNo, `pad ${it.n}: code has already reached offset ${box.x - Number(orgIt.n)} (${box.x - target} bytes past the target)`);
        }
        chunks.push(Buffer.alloc(box.w));
        listing.push({ lineNo: it.lineNo, addr: box.x, bytes: [], note: `(${box.w} bytes of 00, courtesy of flex-grow)`, src: it.src });
        continue;
      }
      const bytes = [];
      for (const w of row.widths) {
        if (w === 0) continue; // inactive slot
        if (w < 1000 || w > 1255) throw new AsmError(it.lineNo, `garbage on the output bus (${w}px) — this line confused the stylesheet`);
        bytes.push(w - 1000);
      }
      const expected = it.kind === 'org' ? 0 : box.w;
      if (bytes.length !== expected || (it.kind === 'op' && expected === 0)) {
        throw new AsmError(
          it.lineNo,
          it.kind === 'op'
            ? `no encoding for '${(it.op + ' ' + [it.am ? it.am.raw : it.a, it.bm ? it.bm.raw : it.b].filter(Boolean).join(', ')).trim()}' — no CSS rule matched this instruction`
            : `cannot encode this line (a byte cell refused to have a width)`
        );
      }
      if (it.kind === 'op' || it.kind === 'db' || it.kind === 'dw') {
        chunks.push(Buffer.from(bytes));
        listing.push({ lineNo: it.lineNo, addr: box.x, bytes, src: it.src });
      } else if (it.kind === 'lbl') {
        listing.push({ lineNo: it.lineNo, addr: box.x, bytes: [], src: it.src });
      }
    }

    const code = Buffer.concat(chunks);

    await page.evaluate(() => {
      document.querySelectorAll('.fixing, .reading').forEach((el) => el.classList.remove('fixing', 'reading'));
      document.body.setAttribute('phase', 'done');
    });
    const keptHtml = opts.keepHtml ? await page.content() : null;
    if (opts.show) await sleep(1500); // hold the DONE banner before the window vanishes
    return { code, listing, symtab, html: keptHtml };
  }
}

module.exports = { assemble, assembleOn, AsmError };
