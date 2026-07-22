'use strict';

// The bootstrapped chain. Every computing stage is x86 machine code that
// was itself assembled by assembler.css:
//
//   lexer.com  — tokenizes source text into DOM attribute records
//   (the stylesheet encodes the program as layout, in the browser)
//   linker.com — resolves symbols from measured boxes, decides convergence
//   writer.com — turns measured widths back into bytes, validates
//
// This file is the ribbon cable: it runs the CPU, splices strings into
// fixed templates, measures rectangles, copies attributes, and moves
// buffers. It parses framing, never content.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { runCom } = require('../test/run-com');

const BOOT = path.join(__dirname, '..', 'boot');
const SLOTS = '<v></v><v></v><u></u><u></u><u></u><u></u><u></u><u></u>';
const KIND = { o: 0, d: 1, w: 2, l: 3, g: 4, p: 5 };

const LNK_MSG = {
  1: (name) => `duplicate label '${name}'`,
  2: (name) => `duplicate symbol '${name}'`,
  3: (name) => `undefined symbol '${name}'`,
  4: (name, aux) => `jump target out of rel8 range (${aux} bytes away; max ±127)`,
};
const WRT_MSG = {
  1: 'garbage on the output bus — this line confused the stylesheet',
  2: 'no encoding — no CSS rule matched this instruction',
  3: 'pad target already passed',
  4: 'cannot encode this line (a byte cell refused to have a width)',
};

class BootError extends Error {
  constructor(lineNo, msg) {
    super(lineNo ? `line ${lineNo}: ${msg}` : msg);
    this.lineNo = lineNo;
  }
}

const runBytes = (com, input) => {
  const out = [];
  runCom(Buffer.concat([com, input]), (s) => {
    for (const c of s) out.push(c.charCodeAt(0) & 255);
  });
  return out;
};

const u16 = (n) => [n & 255, (n >> 8) & 255];
const nm = (s) => [s.length, ...Buffer.from(s, 'latin1')];

// ---- stage 1: the lexer --------------------------------------------------
function lexBoot(sourceText) {
  const com = fs.readFileSync(path.join(BOOT, 'lexer.com'));
  const raw = Buffer.from(
    runBytes(com, Buffer.concat([Buffer.from(sourceText, 'utf8'), Buffer.from([255])]))
  ).toString('utf8');
  const records = [];
  const errors = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const f = line.split('\x01');
    if (f[0] === 'E') errors.push({ lineNo: Number(f[1]), msg: f[2] });
    else if (f[0] === 'I') {
      records.push({
        idx: Number(f[1]), lineNo: Number(f[2]), kind: f[3], name: f[4], n: f[5],
        ref: f[6], refrole: f[7], r8: f[8] === '1', atarget: f[9],
        attrs: f[10], cells: f[11], src: f[12],
      });
    }
  }
  records.sort((a, b) => a.idx - b.idx);
  return { records, errors };
}

// ---- template stamping (verbatim splicing, no inspection) ----------------
function buildBootPage(records, css, sourceName) {
  const strip = [];
  const bytes = [];
  const tape = [];
  const list = [];
  const consts = [];
  let orgN = null;
  let padN = null;
  let padPos = -1;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  for (const r of records) {
    const bus = r.kind === 'o' ? SLOTS : r.cells;
    const open = (cls) => `<i class="${cls}" data-i="${r.idx}"${r.attrs}>`;
    if (r.kind === 'e') consts.push(`${open('ln')}</i>`);
    if (r.kind !== 'b' && r.kind !== 'e') {
      if (r.kind === 'p') { padPos = strip.length; padN = r.n; }
      if (r.kind === 'g') orgN = r.n;
      strip.push(`${open('ln')}${r.cells}</i>`);
      bytes.push(`${open('ln')}${bus}</i>`);
      tape.push(`${open('ln tp')}${r.cells}</i>`);
    }
    list.push(
      `<div class="ln lrow" data-i="${r.idx}"${r.attrs}>` +
        `<span class="addr"></span><span class="hex">${bus}</span>` +
        `<span class="src">${r.src}</span></div>`
    );
  }
  let stripHtml = strip.join('');
  if (padPos >= 0 && orgN != null) {
    stripHtml =
      `<span class="padwrap" o="${orgN}" n="${padN}">` +
      strip.slice(0, padPos + 1).join('') + `</span>` + strip.slice(padPos + 1).join('');
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>accsembly boot · ${esc(sourceName)}</title>` +
    `<style>${css}</style></head><body>` +
    `<div id="machine" aria-hidden="true">` +
    `<section id="strip">${stripHtml}</section>` +
    `<section id="bytes">${bytes.join('')}</section>` +
    `<section id="consts">${consts.join('')}</section>` +
    `</div>` +
    `<main id="list"><header>accsembly v0.2 — <b>${esc(sourceName)}</b> (bootstrapped chain)\n` +
    `lexed by lexer.com, linked by linker.com, written by writer.com — all assembled by this stylesheet\n` +
    `<span id="phase"></span></header>` +
    `<section id="tape">${tape.join('')}</section>` +
    `${list.join('')}</main></body></html>`
  );
}

// ---- the full chain ------------------------------------------------------
async function assembleBoot(sourceText, opts = {}) {
  const { records, errors } = lexBoot(sourceText);
  if (errors.length) {
    const e = errors[0];
    throw new BootError(e.lineNo, e.msg);
  }
  const css = opts.css || fs.readFileSync(path.join(__dirname, '..', 'assembler.css'), 'utf8');
  const linkerCom = fs.readFileSync(path.join(BOOT, 'linker.com'));
  const writerCom = fs.readFileSync(path.join(BOOT, 'writer.com'));
  const byIdx = new Map(records.map((r) => [r.idx, r]));

  const browser = opts.page ? null : await chromium.launch();
  const page = opts.page || (await browser.newPage());
  try {
    await page.setContent(buildBootPage(records, css, opts.sourceName || 'source.asm'));

    const measure = () =>
      page.evaluate(() => ({
        strip: [...document.querySelectorAll('#strip .ln')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            i: +el.getAttribute('data-i'),
            x: Math.round(r.x),
            w: Math.round(r.width),
            at: el.getAttribute('at'),
            toa: el.getAttribute('toa'),
            tob: el.getAttribute('tob'),
            tod: el.getAttribute('tod'),
            to: el.getAttribute('to'),
          };
        }),
        consts: [...document.querySelectorAll('#consts .ln')].map((el) => ({
          i: +el.getAttribute('data-i'),
          w: Math.round(el.getBoundingClientRect().width),
        })),
      }));

    // relaxation loop: the linker decides when the layout has settled
    let m;
    for (let iter = 0; iter < 12; iter++) {
      m = await measure();
      const rows = [];
      for (const b of m.strip) {
        const r = byIdx.get(b.i);
        const roleAttr = r.refrole === 'w' ? 'to' : 'to' + r.refrole;
        const prevat = b.at == null ? null : Number(b.at);
        const prevto = r.ref && b[roleAttr] != null ? Number(b[roleAttr]) : null;
        let flags = 0;
        if (r.r8) flags |= 1;
        if (r.atarget !== '') flags |= 2;
        if (prevat != null) flags |= 4;
        if (prevto != null) flags |= 8;
        rows.push([
          ...u16(b.i), ...u16(r.lineNo), KIND[r.kind], ...u16(b.x), ...u16(b.w), flags,
          ...u16(r.atarget === '' ? 0 : Math.min(65535, Math.max(-32768, Number(r.atarget))) & 0xffff),
          ...u16(prevat ?? 0), ...u16(prevto ?? 0),
          ...nm(r.kind === 'l' ? r.name : ''), ...nm(r.ref || ''),
        ]);
      }
      const consts = m.consts.map((c) => {
        const r = byIdx.get(c.i);
        return [...u16(r.lineNo), ...u16(c.w), ...nm(r.name)];
      });
      const input = Buffer.from([
        ...u16(m.strip.length), ...u16(consts.length), ...consts.flat(), ...rows.flat(),
      ]);
      const out = runBytes(linkerCom, input);

      // unpack frames, apply patches
      let i = 0;
      let verdict = null;
      const patches = [];
      while (i < out.length) {
        const t = out[i++];
        if (t === 2) {
          patches.push({ idx: out[i] | (out[i + 1] << 8), at: out[i + 2] | (out[i + 3] << 8), hasto: out[i + 4], to: out[i + 5] | (out[i + 6] << 8) });
          i += 7;
        } else if (t === 3) {
          const lineNo = out[i] | (out[i + 1] << 8);
          const code = out[i + 2];
          let aux = out[i + 3] | (out[i + 4] << 8);
          if (aux > 32767) aux -= 65536;
          const nl = out[i + 5];
          const name = Buffer.from(out.slice(i + 6, i + 6 + nl)).toString('latin1');
          throw new BootError(lineNo, LNK_MSG[code](name, aux));
        } else if (t === 4 || t === 5) { verdict = t; break; }
        else throw new BootError(0, `linker emitted unknown frame tag ${t}`);
      }
      await page.evaluate((ps) => {
        for (const p of ps) {
          document.querySelectorAll(`[data-i="${p.idx}"]`).forEach((el) => {
            el.setAttribute('at', p.at);
            if (p.roleAttr) el.setAttribute(p.roleAttr, p.to);
          });
        }
      }, patches.map((p) => ({
        ...p,
        roleAttr: p.hasto ? (byIdx.get(p.idx).refrole === 'w' ? 'to' : 'to' + byIdx.get(p.idx).refrole) : null,
      })));
      if (verdict === 4) break;
      if (iter === 11) throw new BootError(0, 'relaxation did not converge in 12 iterations');
    }

    // readout: measure the byte bus, hand the widths to writer.com
    m = await measure();
    const widthRows = await page.evaluate(() =>
      [...document.querySelectorAll('#strip .ln')].map((el) => {
        const i = el.getAttribute('data-i');
        const row = document.querySelector(`#bytes .ln[data-i="${i}"]`);
        return row ? [...row.querySelectorAll('v,u,d,e')].map((s) => Math.round(s.getBoundingClientRect().width)) : [];
      })
    );
    const orgRec = records.find((r) => r.kind === 'g');
    const padRec = records.find((r) => r.kind === 'p');
    const wrows = [];
    m.strip.forEach((b, k) => {
      const r = byIdx.get(b.i);
      const ws = widthRows[k];
      wrows.push([...u16(r.lineNo), KIND[r.kind], ...u16(b.x), ...u16(b.w), ...u16(ws.length), ...ws.flatMap(u16)]);
    });
    const winput = Buffer.from([
      ...u16(m.strip.length), ...u16(Number(orgRec.n)), ...u16(padRec ? Number(padRec.n) : 0),
      ...wrows.flat(),
    ]);
    const wout = runBytes(writerCom, winput);
    const chunks = [];
    let i = 0;
    let k = 0;
    while (i < wout.length) {
      const t = wout[i++];
      if (t === 2) {
        const n = wout[i] | (wout[i + 1] << 8);
        i += 2;
        chunks.push(Buffer.from(wout.slice(i, i + n)));
        i += n;
        k++;
      } else if (t === 3) {
        const lineNo = wout[i] | (wout[i + 1] << 8);
        const code = wout[i + 2];
        throw new BootError(lineNo, WRT_MSG[code]);
      } else if (t === 4) break;
      else throw new BootError(0, `writer emitted unknown frame tag ${t}`);
    }
    return { code: Buffer.concat(chunks) };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { assembleBoot, lexBoot, buildBootPage, BootError };
