'use strict';

// A deliberately small 8086 interpreter covering exactly the subset the
// stylesheet can emit, so the test suite can *execute* its output.
// Flat 64K memory, segments stored but ignored. This is test harness,
// not compiler: the compiler is assembler.css.
//
//   node test/run-com.js program.com [org]

function runCom(code, write = (s) => process.stdout.write(s), org = 0x100) {
  const mem = new Uint8Array(65536);
  mem[0] = 0xcd; mem[1] = 0x20; // PSP:0000 -> int 20h (exit), like real DOS
  mem.set(code, org);

  const r = new Uint16Array(8); // ax cx dx bx sp bp si di
  const sregs = new Uint16Array(4);
  const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, SI = 6, DI = 7;
  r[SP] = 0xfffe;
  let ip = org;
  let zf = 0, sf = 0, cf = 0, of = 0, df = 0, pf = 1, af = 0;

  const get8 = (i) => (i < 4 ? r[i] & 0xff : r[i - 4] >> 8);
  const set8 = (i, v) => {
    v &= 0xff;
    if (i < 4) r[i] = (r[i] & 0xff00) | v;
    else r[i - 4] = (r[i - 4] & 0x00ff) | (v << 8);
  };
  const fetch = () => mem[ip++];
  const fetch16 = () => fetch() | (fetch() << 8);
  const parity = (v) => { let b = v & 0xff, p = 1; while (b) { p ^= b & 1; b >>= 1; } return p; };
  const setZSP = (v, hi) => { zf = v === 0 ? 1 : 0; sf = v & hi ? 1 : 0; pf = parity(v); };
  const push16 = (v) => { r[SP] -= 2; mem[r[SP]] = v & 0xff; mem[(r[SP] + 1) & 0xffff] = (v >> 8) & 0xff; };
  const pop16 = () => { const v = mem[r[SP]] | (mem[(r[SP] + 1) & 0xffff] << 8); r[SP] += 2; return v; };

  // full 16-bit ModRM decode: registers and memory operands
  const modrm = () => {
    const m = fetch();
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    if (mod === 3) return { reg, isReg: true, rm };
    let disp = 0, ea;
    if (mod === 0 && rm === 6) ea = fetch16();
    else {
      if (mod === 1) disp = fetch() << 24 >> 24;
      if (mod === 2) disp = (fetch16() << 16) >> 16;
      const base = [r[3] + r[6], r[3] + r[7], r[5] + r[6], r[5] + r[7], r[6], r[7], r[5], r[3]][rm];
      ea = (base + disp) & 0xffff;
    }
    return { reg, isReg: false, ea };
  };
  const rm16 = (o) => (o.isReg ? r[o.rm] : mem[o.ea] | (mem[(o.ea + 1) & 0xffff] << 8));
  const wrm16 = (o, v) => { if (o.isReg) r[o.rm] = v; else { mem[o.ea] = v & 0xff; mem[(o.ea + 1) & 0xffff] = (v >> 8) & 0xff; } };
  const rm8 = (o) => (o.isReg ? get8(o.rm) : mem[o.ea]);
  const wrm8 = (o, v) => { if (o.isReg) set8(o.rm, v); else mem[o.ea] = v & 0xff; };

  // ALU, both widths; op = the x86 /ext number
  const alu = (op, a, b, w) => {
    const MASK = w ? 0xffff : 0xff, HI = w ? 0x8000 : 0x80;
    let v;
    if (op === 0) { v = a + b; cf = v > MASK ? 1 : 0; of = (~(a ^ b) & (a ^ v) & HI) ? 1 : 0; af = ((a ^ b ^ v) >> 4) & 1; }
    else if (op === 1) { v = a | b; cf = of = 0; }
    else if (op === 2) { v = a + b + cf; cf = v > MASK ? 1 : 0; of = (~(a ^ b) & (a ^ v) & HI) ? 1 : 0; af = ((a ^ b ^ v) >> 4) & 1; }
    else if (op === 3) { v = a - b - cf; cf = (b + cf) > a ? 1 : 0; of = ((a ^ b) & (a ^ v) & HI) ? 1 : 0; af = ((a ^ b ^ v) >> 4) & 1; }
    else if (op === 4) { v = a & b; cf = of = 0; }
    else if (op === 5 || op === 7) { v = a - b; cf = a < b ? 1 : 0; of = ((a ^ b) & (a ^ v) & HI) ? 1 : 0; af = ((a ^ b ^ v) >> 4) & 1; }
    else if (op === 6) { v = a ^ b; cf = of = 0; }
    else throw new Error(`alu op ${op}?`);
    v &= MASK;
    setZSP(v, HI);
    return op === 7 ? a : v; // cmp discards
  };

  const shift = (ext, v, n, w) => {
    const BITS = w ? 16 : 8, MASK = w ? 0xffff : 0xff, HI = w ? 0x8000 : 0x80;
    n &= 31;
    for (let k = 0; k < n; k++) {
      if (ext === 0) { cf = v & HI ? 1 : 0; v = ((v << 1) | cf) & MASK; }                    // rol
      else if (ext === 1) { cf = v & 1; v = (v >> 1) | (cf ? HI : 0); }                       // ror
      else if (ext === 2) { const c = cf; cf = v & HI ? 1 : 0; v = ((v << 1) | c) & MASK; }   // rcl
      else if (ext === 3) { const c = cf; cf = v & 1; v = (v >> 1) | (c ? HI : 0); }          // rcr
      else if (ext === 4) { cf = v & HI ? 1 : 0; v = (v << 1) & MASK; }                        // shl
      else if (ext === 5) { cf = v & 1; v = v >> 1; }                                          // shr
      else if (ext === 7) { cf = v & 1; v = (v >> 1) | (v & HI); }                             // sar
      else throw new Error(`shift ext ${ext}?`);
    }
    if (n && ext >= 4) setZSP(v, HI);
    if (n === 1) of = ext === 4 ? ((v & HI ? 1 : 0) ^ cf) : 0;
    return v;
  };

  const strStep = (w) => (df ? -(w ? 2 : 1) : w ? 2 : 1);
  const doString = (op) => {
    const w = op & 1;
    const kind = op & 0xfe;
    const step = strStep(w);
    if (kind === 0xa4) { // movs
      mem[r[DI]] = mem[r[SI]];
      if (w) mem[(r[DI] + 1) & 0xffff] = mem[(r[SI] + 1) & 0xffff];
      r[SI] += step; r[DI] += step;
    } else if (kind === 0xa6) { // cmps
      const a = w ? mem[r[SI]] | (mem[(r[SI] + 1) & 0xffff] << 8) : mem[r[SI]];
      const b = w ? mem[r[DI]] | (mem[(r[DI] + 1) & 0xffff] << 8) : mem[r[DI]];
      alu(7, a, b, w);
      r[SI] += step; r[DI] += step;
    } else if (kind === 0xaa) { // stos
      mem[r[DI]] = r[AX] & 0xff;
      if (w) mem[(r[DI] + 1) & 0xffff] = r[AX] >> 8;
      r[DI] += step;
    } else if (kind === 0xac) { // lods
      if (w) r[AX] = mem[r[SI]] | (mem[(r[SI] + 1) & 0xffff] << 8);
      else set8(0, mem[r[SI]]);
      r[SI] += step;
    } else if (kind === 0xae) { // scas
      const b = w ? mem[r[DI]] | (mem[(r[DI] + 1) & 0xffff] << 8) : mem[r[DI]];
      alu(7, w ? r[AX] : r[AX] & 0xff, b, w);
      r[DI] += step;
    } else throw new Error(`string op ${op.toString(16)}?`);
  };

  const flagsWord = () => cf | 2 | (pf << 2) | (af << 4) | (zf << 6) | (sf << 7) | (df << 10) | (of << 11);
  const setFlagsWord = (v) => { cf = v & 1; pf = (v >> 2) & 1; af = (v >> 4) & 1; zf = (v >> 6) & 1; sf = (v >> 7) & 1; df = (v >> 10) & 1; of = (v >> 11) & 1; };

  for (let steps = 0; steps < 1e7; steps++) {
    let op = fetch();
    // flat 64K memory: segment overrides and lock are consumed, not obeyed
    while (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e || op === 0xf0) op = fetch();
    if (op >= 0xb8 && op <= 0xbf) r[op - 0xb8] = fetch16();
    else if (op >= 0xb0 && op <= 0xb7) set8(op - 0xb0, fetch());
    else if (op === 0x89) { const o = modrm(); wrm16(o, r[o.reg]); }
    else if (op === 0x8b) { const o = modrm(); r[o.reg] = rm16(o); }
    else if (op === 0x88) { const o = modrm(); wrm8(o, get8(o.reg)); }
    else if (op === 0x8a) { const o = modrm(); set8(o.reg, rm8(o)); }
    else if (op === 0xa0) set8(0, mem[fetch16()]);
    else if (op === 0xa1) { const a = fetch16(); r[AX] = mem[a] | (mem[(a + 1) & 0xffff] << 8); }
    else if (op === 0xa2) mem[fetch16()] = r[AX] & 0xff;
    else if (op === 0xa3) { const a = fetch16(); mem[a] = r[AX] & 0xff; mem[(a + 1) & 0xffff] = r[AX] >> 8; }
    else if (op < 0x40 && (op & 7) < 6 && ![0x0f, 0x26, 0x27, 0x2e, 0x2f, 0x36, 0x37, 0x3e, 0x3f].includes(op)) {
      // the 8086 ALU block: 00-3D, op = (opcode>>3)&7, form = opcode&7
      const ext = (op >> 3) & 7;
      const form = op & 7;
      if (form === 0) { const o = modrm(); wrm8(o, alu(ext, rm8(o), get8(o.reg), 0)); }
      else if (form === 1) { const o = modrm(); wrm16(o, alu(ext, rm16(o), r[o.reg], 1)); }
      else if (form === 2) { const o = modrm(); set8(o.reg, alu(ext, get8(o.reg), rm8(o), 0)); }
      else if (form === 3) { const o = modrm(); r[o.reg] = alu(ext, r[o.reg], rm16(o), 1); }
      else if (form === 4) set8(0, alu(ext, r[AX] & 0xff, fetch(), 0));
      else if (form === 5) r[AX] = alu(ext, r[AX], fetch16(), 1);
    } else if (op === 0x80) { const o = modrm(); wrm8(o, alu(o.reg, rm8(o), fetch(), 0)); }
    else if (op === 0x81) { const o = modrm(); wrm16(o, alu(o.reg, rm16(o), fetch16(), 1)); }
    else if (op === 0x83) { const o = modrm(); const imm = (fetch() << 24 >> 24) & 0xffff; wrm16(o, alu(o.reg, rm16(o), imm, 1)); }
    else if (op === 0x84) { const o = modrm(); alu(4, rm8(o), get8(o.reg), 0); }
    else if (op === 0x85) { const o = modrm(); alu(4, rm16(o), r[o.reg], 1); }
    else if (op === 0xa8) alu(4, r[AX] & 0xff, fetch(), 0);
    else if (op === 0xa9) alu(4, r[AX], fetch16(), 1);
    else if (op === 0x86) { const o = modrm(); const t = rm8(o); wrm8(o, get8(o.reg)); set8(o.reg, t); }
    else if (op === 0x87) { const o = modrm(); const t = rm16(o); wrm16(o, r[o.reg]); r[o.reg] = t; }
    else if (op > 0x90 && op <= 0x97) { const t = r[AX]; r[AX] = r[op - 0x90]; r[op - 0x90] = t; }
    else if (op >= 0x40 && op <= 0x47) { const c = cf; const v = alu(0, r[op - 0x40], 1, 1); cf = c; r[op - 0x40] = v; }
    else if (op >= 0x48 && op <= 0x4f) { const c = cf; const v = alu(5, r[op - 0x48], 1, 1); cf = c; r[op - 0x48] = v; }
    else if (op >= 0x50 && op <= 0x57) push16(r[op - 0x50]);
    else if (op >= 0x58 && op <= 0x5f) r[op - 0x58] = pop16();
    else if (op === 0x06 || op === 0x0e || op === 0x16 || op === 0x1e) push16(sregs[(op >> 3) & 3]);
    else if (op === 0x07 || op === 0x17 || op === 0x1f) sregs[(op >> 3) & 3] = pop16();
    else if (op === 0x8e) { const o = modrm(); sregs[o.reg & 3] = rm16(o); }
    else if (op === 0x8c) { const o = modrm(); wrm16(o, sregs[o.reg & 3]); }
    else if (op >= 0xd0 && op <= 0xd3) {
      const o = modrm();
      const w = op & 1;
      const n = op >= 0xd2 ? r[CX] & 0xff : 1;
      if (w) wrm16(o, shift(o.reg, rm16(o), n, 1)); else wrm8(o, shift(o.reg, rm8(o), n, 0));
    } else if (op === 0xc0 || op === 0xc1) {
      const o = modrm();
      const n = fetch();
      if (op & 1) wrm16(o, shift(o.reg, rm16(o), n, 1)); else wrm8(o, shift(o.reg, rm8(o), n, 0));
    } else if (op === 0xf6 || op === 0xf7) {
      const o = modrm();
      const w = op & 1;
      const v = w ? rm16(o) : rm8(o);
      const e = o.reg;
      if (e === 0) { w ? alu(4, v, fetch16(), 1) : alu(4, v, fetch(), 0); } // test
      else if (e === 2) { w ? wrm16(o, v ^ 0xffff) : wrm8(o, v ^ 0xff); }
      else if (e === 3) { w ? wrm16(o, alu(5, 0, v, 1)) : wrm8(o, alu(5, 0, v, 0)); }
      else if (e === 4) { // mul
        if (w) { const t = r[AX] * v; r[AX] = t & 0xffff; r[DX] = (t >>> 16) & 0xffff; cf = of = r[DX] ? 1 : 0; }
        else { r[AX] = (r[AX] & 0xff) * v; cf = of = r[AX] >> 8 ? 1 : 0; }
      } else if (e === 5) { // imul
        if (w) { const t = ((r[AX] << 16) >> 16) * ((v << 16) >> 16); r[AX] = t & 0xffff; r[DX] = (t >> 16) & 0xffff; cf = of = t < -32768 || t > 32767 ? 1 : 0; }
        else { const t = (((r[AX] & 0xff) << 24) >> 24) * ((v << 24) >> 24); r[AX] = t & 0xffff; cf = of = t < -128 || t > 127 ? 1 : 0; }
      } else if (e === 6) { // div
        if (!v) throw new Error('divide by zero');
        if (w) { const dv = (r[DX] << 16 >>> 0) + r[AX]; r[AX] = Math.floor(dv / v) & 0xffff; r[DX] = dv % v; }
        else { const dv = r[AX]; set8(0, Math.floor(dv / v)); set8(4, dv % v); }
      } else if (e === 7) { // idiv
        if (!v) throw new Error('divide by zero');
        if (w) { const dv = ((r[DX] << 16) | r[AX]) | 0; const sv = (v << 16) >> 16; r[AX] = (dv / sv | 0) & 0xffff; r[DX] = (dv % sv) & 0xffff; }
        else { const dv = (r[AX] << 16) >> 16; const sv = (v << 24) >> 24; set8(0, (dv / sv | 0) & 0xff); set8(4, (dv % sv) & 0xff); }
      } else throw new Error(`F${w ? 7 : 6} /${e} not in subset`);
    } else if (op === 0xeb) { const d = fetch(); ip = (ip + (d << 24 >> 24)) & 0xffff; }
    else if (op === 0xe9) { const d = fetch16(); ip = (ip + ((d << 16) >> 16)) & 0xffff; }
    else if (op >= 0x70 && op <= 0x7f) {
      const d = fetch() << 24 >> 24;
      const take = [of, !of, cf, !cf, zf, !zf, cf || zf, !cf && !zf, sf, !sf, pf, !pf,
        sf !== of, sf === of, zf || sf !== of, !zf && sf === of][op - 0x70];
      if (take) ip = (ip + d) & 0xffff;
    } else if (op === 0xe3) { const d = fetch() << 24 >> 24; if (!r[CX]) ip = (ip + d) & 0xffff; }
    else if (op === 0xe2) { const d = fetch() << 24 >> 24; r[CX] = (r[CX] - 1) & 0xffff; if (r[CX]) ip = (ip + d) & 0xffff; }
    else if (op === 0xe1) { const d = fetch() << 24 >> 24; r[CX] = (r[CX] - 1) & 0xffff; if (r[CX] && zf) ip = (ip + d) & 0xffff; }
    else if (op === 0xe0) { const d = fetch() << 24 >> 24; r[CX] = (r[CX] - 1) & 0xffff; if (r[CX] && !zf) ip = (ip + d) & 0xffff; }
    else if (op === 0xe8) { const d = fetch16(); push16(ip); ip = (ip + ((d << 16) >> 16)) & 0xffff; }
    else if (op === 0xc3) ip = pop16();
    else if (op === 0x90) { /* nop */ }
    else if (op === 0xf8) cf = 0;
    else if (op === 0xf9) cf = 1;
    else if (op === 0xf5) cf ^= 1;
    else if (op === 0xfc) df = 0;
    else if (op === 0xfd) df = 1;
    else if (op === 0xfa || op === 0xfb) { /* cli/sti: no interrupts here anyway */ }
    else if (op === 0x98) r[AX] = ((r[AX] << 24) >> 24) & 0xffff;
    else if (op === 0x99) r[DX] = r[AX] & 0x8000 ? 0xffff : 0;
    else if (op === 0x9c) push16(flagsWord());
    else if (op === 0x9d) setFlagsWord(pop16());
    else if (op === 0x9e) { const ah = r[AX] >> 8; sf = (ah >> 7) & 1; zf = (ah >> 6) & 1; pf = (ah >> 2) & 1; cf = ah & 1; }
    else if (op === 0x9f) set8(4, (sf << 7) | (zf << 6) | 2 | (pf << 2) | cf);
    else if (op === 0xd7) set8(0, mem[(r[BX] + (r[AX] & 0xff)) & 0xffff]);
    else if (op === 0xcc) { /* int3: a debugger would stop here; we shrug */ }
    else if (op === 0xcf) { ip = pop16(); pop16(); setFlagsWord(pop16()); }
    else if ((op & 0xfe) === 0xa4 || (op & 0xfe) === 0xa6 || (op & 0xfe) === 0xaa || (op & 0xfe) === 0xac || (op & 0xfe) === 0xae) doString(op);
    else if (op === 0xf3 || op === 0xf2) {
      const sub = fetch();
      const isCmp = (sub & 0xfe) === 0xa6 || (sub & 0xfe) === 0xae;
      while (r[CX]) {
        doString(sub);
        r[CX]--;
        if (isCmp && ((op === 0xf3 && !zf) || (op === 0xf2 && zf))) break;
      }
    } else if (op === 0x8d) { const o = modrm(); if (o.isReg) throw new Error('lea needs a memory operand'); r[o.reg] = o.ea; }
    else if (op === 0xc4 || op === 0xc5) { // les / lds
      const o = modrm();
      r[o.reg] = mem[o.ea] | (mem[(o.ea + 1) & 0xffff] << 8);
      sregs[op === 0xc4 ? 0 : 3] = mem[(o.ea + 2) & 0xffff] | (mem[(o.ea + 3) & 0xffff] << 8);
    } else if (op === 0xfe) { // inc/dec r/m8 (cf preserved)
      const o = modrm(); const c = cf;
      const v = alu(o.reg === 0 ? 0 : 5, rm8(o), 1, 0);
      cf = c; wrm8(o, v);
    } else if (op === 0xff) {
      const o = modrm(); const e = o.reg;
      if (e === 0 || e === 1) { const c = cf; const v = alu(e === 0 ? 0 : 5, rm16(o), 1, 1); cf = c; wrm16(o, v); }
      else if (e === 2) { const t = rm16(o); push16(ip); ip = t; }
      else if (e === 3) { const t = rm16(o); push16(sregs[1]); push16(ip); ip = t; sregs[1] = mem[(o.ea + 2) & 0xffff] | (mem[(o.ea + 3) & 0xffff] << 8); }
      else if (e === 4) ip = rm16(o);
      else if (e === 5) { const t = rm16(o); sregs[1] = mem[(o.ea + 2) & 0xffff] | (mem[(o.ea + 3) & 0xffff] << 8); ip = t; }
      else if (e === 6) push16(rm16(o));
      else throw new Error(`FF /${e} not in subset`);
    } else if (op === 0x8f) { const o = modrm(); wrm16(o, pop16()); }
    else if (op === 0xc6) { const o = modrm(); wrm8(o, fetch()); }
    else if (op === 0xc7) { const o = modrm(); wrm16(o, fetch16()); }
    else if (op === 0x9a) { const off = fetch16(); const seg = fetch16(); push16(sregs[1]); push16(ip); ip = off; sregs[1] = seg; }
    else if (op === 0xea) { const off = fetch16(); sregs[1] = fetch16(); ip = off; }
    else if (op === 0xc2) { const n = fetch16(); ip = pop16(); r[SP] += n; }
    else if (op === 0xcb) { ip = pop16(); sregs[1] = pop16(); }
    else if (op === 0xca) { const n = fetch16(); ip = pop16(); sregs[1] = pop16(); r[SP] += n; }
    else if (op === 0xce) { if (of) throw new Error('INTO with OF set'); }
    else if (op === 0x9b) { /* wait: no coprocessor to wait for */ }
    else if (op === 0xd4) { const b = fetch(); const al = r[AX] & 0xff; r[AX] = ((Math.floor(al / b) & 0xff) << 8) | (al % b); setZSP(r[AX] & 0xff, 0x80); }
    else if (op === 0xd5) { const b = fetch(); const v = ((r[AX] & 0xff) + (r[AX] >> 8) * b) & 0xff; r[AX] = v; setZSP(v, 0x80); }
    else if (op === 0x37) { // aaa
      if ((r[AX] & 0x0f) > 9 || af) { r[AX] = (r[AX] + 0x106) & 0xffff; af = 1; cf = 1; } else { af = 0; cf = 0; }
      r[AX] &= 0xff0f;
    } else if (op === 0x3f) { // aas
      if ((r[AX] & 0x0f) > 9 || af) { r[AX] = (r[AX] - 6) & 0xffff; r[AX] = (r[AX] - 0x100) & 0xffff; af = 1; cf = 1; } else { af = 0; cf = 0; }
      r[AX] &= 0xff0f;
    } else if (op === 0x27) { // daa
      let al = r[AX] & 0xff; const oal = al; const oc = cf; cf = 0;
      if ((al & 0x0f) > 9 || af) { al = (al + 6) & 0xff; af = 1; } else af = 0;
      if (oal > 0x99 || oc) { al = (al + 0x60) & 0xff; cf = 1; }
      set8(0, al); setZSP(al, 0x80);
    } else if (op === 0x2f) { // das
      let al = r[AX] & 0xff; const oal = al; const oc = cf; cf = 0;
      if ((al & 0x0f) > 9 || af) { cf = oc || oal < 6 ? oc : 0; al = (al - 6) & 0xff; af = 1; } else af = 0;
      if (oal > 0x99 || oc) { al = (al - 0x60) & 0xff; cf = 1; }
      set8(0, al); setZSP(al, 0x80);
    } else if (op === 0xe4) { fetch(); set8(0, 0); }        // in al, imm8: bus reads 0
    else if (op === 0xe5) { fetch(); r[AX] = 0; }
    else if (op === 0xec) set8(0, 0);
    else if (op === 0xed) r[AX] = 0;
    else if (op === 0xe6 || op === 0xe7) fetch();           // out imm8: into the void
    else if (op === 0xee || op === 0xef) { /* out dx */ }
    else if (op === 0xf4) return; // hlt: close enough to exit
    else if (op === 0xcd) {
      const n = fetch();
      if (n === 0x20) return;
      if (n === 0x10) {
        const ah = r[AX] >> 8;
        if (ah === 0x0e) write(String.fromCharCode(r[AX] & 0xff));
        else throw new Error(`int 10h ah=${ah.toString(16)} not in subset`);
      } else if (n === 0x21) {
        const ah = r[AX] >> 8;
        if (ah === 0x02) write(String.fromCharCode(r[DX] & 0xff));
        else if (ah === 0x09) { let p = r[DX]; let s = ''; while (mem[p] !== 0x24 && s.length < 65536) s += String.fromCharCode(mem[p++]); write(s); }
        else if (ah === 0x4c) return;
        else throw new Error(`int 21h ah=${ah.toString(16)} not in subset`);
      } else throw new Error(`int ${n.toString(16)} not in subset`);
    } else throw new Error(`opcode ${op.toString(16)} at ${(ip - 1).toString(16)} not in subset`);
  }
  throw new Error('did not halt (10M steps)');
}

if (require.main === module) {
  const fs = require('fs');
  runCom(fs.readFileSync(process.argv[2]), undefined, process.argv[3] ? Number(process.argv[3]) : 0x100);
  process.stdout.write('\n');
}

module.exports = { runCom };
