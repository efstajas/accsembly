'use strict';

// The lexer is deliberately dumb. It splits text into tokens and validates
// token *shape* only. It does not know what an opcode, register, or
// instruction encoding is — that knowledge lives in assembler.css.

const NUM = /^-?\d+$/;
const IDENT = /^[A-Za-z_]\w*$/;
const HEX = /^-?0x[0-9a-fA-F]{1,4}$/;
const CHR = /^'(.)'$/;

// '-0x1f' -> { digits: '001f', neg: true }; the VALUE is computed by 64
// attribute selectors in assembler.css, we only deal the digits out
const hexDigits = (tok) => ({
  digits: tok.replace(/^-?0[xX]/, '').toLowerCase().padStart(4, '0'),
  neg: tok.startsWith('-'),
});

function parseDb(s, fail) {
  const bytes = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) return fail('unterminated string');
      for (const c of s.slice(i + 1, j)) bytes.push({ t: 'c', v: c });
      i = j + 1;
    } else if (ch === "'") {
      if (i + 2 >= n || s[i + 2] !== "'") return fail('bad character literal');
      bytes.push({ t: 'c', v: s[i + 1] });
      i += 3;
    } else {
      let j = i;
      while (j < n && s[j] !== ',') j++;
      const tok = s.slice(i, j).trim();
      if (HEX.test(tok)) bytes.push({ t: 'h', ...hexDigits(tok) });
      else if (NUM.test(tok)) bytes.push({ t: 'n', v: tok });
      else return fail(`bad db operand '${tok}' (decimal, hex, "string", or 'c')`);
      i = j;
    }
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i < n) {
      if (s[i] !== ',') return fail(`expected comma before '${s.slice(i)}'`);
      i++;
    }
  }
  if (!bytes.length) return fail('db needs at least one operand');
  return bytes;
}

// Memory operands: split '[bx+si+8]' into shape-classified parts. Which
// combinations mean what (and the entire ModRM table) is the stylesheet's
// business, not ours.
function parseOperand(tok, err) {
  // optional size keyword: 'byte [si]', 'word [bx]', 'far [bx]', 'short lbl'
  let sz = null;
  const szm = tok.match(/^(byte|word|short|near|far)\s+(\S[\s\S]*)$/i);
  if (szm) { sz = szm[1].toLowerCase(); tok = szm[2].trim(); }
  const m = tok.match(/^\[(.*)\]$/);
  if (!m) {
    if (HEX.test(tok)) return { kind: 'hex', v: tok, sz };
    const c = tok.match(CHR);
    if (c) return { kind: 'chr', v: c[1], raw: tok, sz };
    // far pointer seg:off, both halves decimal or hex
    const fp = tok.match(/^([^\s:]+):([^\s:]+)$/);
    if (fp && (NUM.test(fp[1]) || HEX.test(fp[1])) && (NUM.test(fp[2]) || HEX.test(fp[2]))) {
      return { kind: 'far', seg: fp[1], off: fp[2], sz };
    }
    if (!NUM.test(tok) && !IDENT.test(tok)) {
      return err(`bad operand '${tok}' (decimal, 0x hex, 'c', seg:off, or a name)`);
    }
    return { kind: 'plain', v: tok, sz };
  }
  // segment override: [es:bx+2]
  let inner = m[1];
  let seg = null;
  const sg = inner.match(/^\s*(es|cs|ss|ds)\s*:([\s\S]*)$/i);
  if (sg) { seg = sg[1].toLowerCase(); inner = sg[2]; }
  // '-0x' must survive the +/- split as one token
  const parts = inner.replace(/\s+/g, '').replace(/-/g, '+-').split('+').filter((s) => s !== '');
  const words = [];
  const nums = [];
  const hexes = [];
  for (const p of parts) {
    if (HEX.test(p)) hexes.push(p);
    else if (NUM.test(p)) nums.push(p);
    else if (IDENT.test(p)) words.push(p);
    else return err(`bad memory operand part '${p}'`);
  }
  if (!parts.length) return err('empty memory operand []');
  if (words.length > 2) return err(`too many terms in '${tok}'`);
  if (nums.length + hexes.length > 1) return err(`at most one displacement in '${tok}'`);
  // a hex displacement flows through the line's digit wires, but the mbd/mad
  // attribute must still exist as a marker (and 0 + hex sums correctly)
  return { kind: 'mem', raw: tok, w1: words[0], w2: words[1], disp: nums[0] ?? (hexes[0] ? '0' : undefined), hexDisp: hexes[0], seg, sz };
}

function lex(text) {
  const items = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const err = (msg) => { errors.push({ lineNo, msg }); return null; };

    // strip comment, but not inside a quoted string
    let code = raw;
    let quote = null;
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ';') { code = raw.slice(0, j); break; }
    }

    let rest = code.trim();
    let hadLabel = false;
    const lbl = rest.match(/^([A-Za-z_]\w*):/);
    if (lbl) {
      rest = rest.slice(lbl[0].length).trim();
      items.push({ kind: 'lbl', name: lbl[1], lineNo, src: rest ? `${lbl[1]}:` : raw });
      hadLabel = true;
    }
    if (!rest) {
      if (!hadLabel) items.push({ kind: 'blank', lineNo, src: raw });
      return;
    }

    // NAME equ VALUE — a constant, resolved by layout (its element's width)
    const eq = rest.match(/^([A-Za-z_]\w*)\s+equ\s+(\S+)$/i);
    if (eq) {
      const item = { kind: 'equ', name: eq[1], lineNo, src: raw };
      const v = eq[2];
      if (HEX.test(v)) item.lith = hexDigits(v);
      else if (CHR.test(v)) item.litc = v.match(CHR)[1];
      else if (NUM.test(v)) item.n = v;
      else return err(`equ needs a number, 0x hex, or 'c' (got '${v}')`);
      items.push(item);
      return;
    }

    const m = rest.match(/^(\S+)\s*(.*)$/);
    const op = m[1];
    const tail = m[2];
    const opl = op.toLowerCase();
    const src = hadLabel ? `    ${rest}` : raw;

    if (opl === 'db') {
      const bytes = parseDb(tail, err);
      if (bytes) items.push({ kind: 'db', bytes, lineNo, src });
    } else if (opl === 'dw') {
      const parts = tail.split(',').map((s) => s.trim());
      if (!tail.trim() || parts.some((p) => !p)) return err('dw needs comma-separated operands');
      const words = [];
      for (const p of parts) {
        if (HEX.test(p)) words.push({ t: 'h', ...hexDigits(p) });
        else if (NUM.test(p)) words.push({ t: 'n', v: p });
        else if (IDENT.test(p)) words.push({ t: 's', v: p });
        else return err(`bad dw operand '${p}' (decimal, hex, or label names)`);
      }
      items.push({ kind: 'dw', words, lineNo, src });
    } else if (opl === 'pad') {
      if (!NUM.test(tail.trim())) return err('pad needs a decimal target offset');
      items.push({ kind: 'pad', n: tail.trim(), lineNo, src });
    } else if (opl === 'org') {
      if (!NUM.test(tail.trim())) return err('org needs a decimal address');
      items.push({ kind: 'org', n: tail.trim(), lineNo, src });
    } else {
      // lock is a prefix riding in front of a real instruction
      let realOp = op;
      let realTail = tail;
      let lock = false;
      if (opl === 'lock') {
        lock = true;
        const lm = tail.match(/^(\S+)\s*(.*)$/);
        if (!lm) return err('lock needs an instruction to hold on to');
        realOp = lm[1];
        realTail = lm[2];
      }
      // split on commas, but not inside quotes: cmp al, ',' is one operand
      const splitOps = (s) => {
        const out = [];
        let cur = '';
        let q = null;
        for (const ch of s) {
          if (q) { cur += ch; if (ch === q) q = null; }
          else if (ch === "'" || ch === '"') { q = ch; cur += ch; }
          else if (ch === ',') { out.push(cur); cur = ''; }
          else cur += ch;
        }
        out.push(cur);
        return out;
      };
      const parts = realTail === '' ? [] : splitOps(realTail).map((s) => s.trim());
      if (parts.length > 2 || parts.some((p) => !p)) return err('expected at most two comma-separated operands');
      const ops = parts.map((p) => parseOperand(p, err));
      if (ops.some((o) => !o)) return;
      const item = { kind: 'op', op: realOp, lineNo, src };
      if (lock) item.lock = true;
      let chrs = 0;
      for (const [slot, o] of [['a', ops[0]], ['b', ops[1]]]) {
        if (!o) continue;
        if (o.sz) {
          if (item.sz && item.sz !== o.sz) return err('conflicting size keywords');
          item.sz = o.sz;
        }
        if (o.kind === 'mem') {
          item[slot + 'm'] = o;
          if (o.seg) item.mseg = o.seg;
          if (o.hexDisp) item.hd = hexDigits(o.hexDisp);
        } else if (o.kind === 'hex') {
          item[slot] = o.v;
          item['h' + slot] = hexDigits(o.v);
        } else if (o.kind === 'chr') {
          item[slot] = o.raw;
          item.litc = o.v;
          chrs++;
        } else if (o.kind === 'far') {
          item.fseg = o.seg;
          item.foff = o.off;
          if (HEX.test(o.seg)) item.ha = hexDigits(o.seg);
          if (HEX.test(o.off)) item.hb = hexDigits(o.off);
        } else item[slot] = o.v;
      }
      if (chrs > 1) return err('one character literal per line (the stylesheet has a single c wire)');
      items.push(item);
    }
  });
  return { items, errors };
}

module.exports = { lex, NUM, IDENT, HEX, CHR };
