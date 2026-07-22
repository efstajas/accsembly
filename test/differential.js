'use strict';

// Differential testing against NASM: generate random programs from the full
// accsembly grammar, assemble them with both the stylesheet and nasm -Ox
// (FULL size optimization), and demand byte-for-byte agreement on the SAME
// source text — no syntax adaptations. The stylesheet performs the same
// optimizations nasm does: 83 sign-extended immediates, accumulator short
// forms, compressed displacements, and jmp relaxation.
//
//   node test/differential.js [programs=200] [seed=1]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { lex } = require('../src/lexer');
const { assembleOn } = require('../src/assemble');

function hasNasm() {
  try { execFileSync('nasm', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; }
}

// deterministic PRNG so failures are reproducible by seed
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const SHIFT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'sal', 'shr', 'sar'];
const F7 = ['not', 'neg', 'mul', 'imul', 'div', 'idiv'];
const JCC = ['jo', 'jno', 'jc', 'jnc', 'jb', 'jae', 'je', 'jne', 'jbe', 'ja', 'js', 'jns',
  'jp', 'jnp', 'jl', 'jge', 'jle', 'jg', 'jz', 'jnz', 'jcxz', 'loop', 'loope', 'loopne'];
const NULLARY = ['ret', 'nop', 'hlt', 'pushf', 'popf', 'sahf', 'lahf', 'cbw', 'cwd', 'clc',
  'stc', 'cmc', 'cld', 'std', 'cli', 'sti', 'xlat', 'int3',
  'movsb', 'movsw', 'cmpsb', 'cmpsw', 'stosb', 'stosw', 'lodsb', 'lodsw', 'scasb', 'scasw'];
const REPS = [['rep', ['movsb', 'movsw', 'stosb', 'stosw']],
  ['repe', ['cmpsb', 'cmpsw', 'scasb', 'scasw']],
  ['repne', ['cmpsb', 'cmpsw', 'scasb', 'scasw']]];
const BASES = ['bx', 'bp', 'si', 'di', 'bx+si', 'bx+di', 'bp+si', 'bp+di'];
const SZ = ['byte', 'word'];

function makeGen(rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  // sometimes render a value in hex — nasm reads 0x too, so the twin text
  // stays identical while exercising the 64-selector digit decoder
  const lit = (v) => (rnd() < 0.3 ? (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16)) : String(v));
  const imm16 = () => lit(pick([int(0, 65535), int(-32768, -1), int(-128, 127), int(0, 255)]));
  const imm8 = () => lit(pick([int(0, 255), int(-128, -1)]));

  const mem = () => {
    if (rnd() < 0.3) {
      const direct = rnd() < 0.5 ? lit(int(0, 999)) : rnd() < 0.5 ? 'msg' : `msg+${int(1, 20)}`;
      return `[${direct}]`;
    }
    const base = pick(BASES);
    const d = rnd() < 0.3 ? 0 : pick([int(1, 900), int(1, 100), -int(1, 300)]);
    const suffix = d === 0 ? '' : d > 0 ? `+${lit(d)}` : lit(d);
    return `[${base}${suffix}]`;
  };
  // memory operand with a segment override (nasm keeps even redundant ones)
  const smem = () => {
    const inner = mem().slice(1, -1);
    return `[${pick(['es', 'cs', 'ss', 'ds'])}:${inner}]`;
  };
  const both = (s) => ({ o: s, n: s });

  const CHARS = 'ABCXYZabcxyz0189$#!.';
  const templates = [
    () => both(`mov ${pick(R16)}, ${imm16()}`),
    () => both(`mov ${pick(R8)}, ${imm8()}`),
    () => both(`mov ${pick(R8)}, '${pick(CHARS.split(''))}'`),
    () => both(`mov ${pick(R16)}, ${pick(R16)}`),
    () => both(`mov ${pick(R8)}, ${pick(R8)}`),
    () => both(`mov ${pick(R16)}, ${mem()}`),
    () => both(`mov ${mem()}, ${pick(R16)}`),
    () => both(`mov ${pick(R8)}, ${mem()}`),
    () => both(`mov ${mem()}, ${pick(R8)}`),
    () => both(`${pick(ALU)} ${pick(R16)}, ${pick(R16)}`),
    () => both(`${pick(ALU)} ${pick(R8)}, ${pick(R8)}`),
    () => both(`${pick(ALU)} ${pick(R16)}, ${imm16()}`),
    () => both(`${pick(ALU)} ${pick(R8)}, ${imm8()}`),
    () => both(`${pick(ALU)} ${pick(R16)}, ${mem()}`),
    () => both(`${pick(ALU)} ${pick(R8)}, ${mem()}`),
    () => both(`${pick(ALU)} ${mem()}, ${pick(R16)}`),
    () => both(`${pick(ALU)} ${mem()}, ${pick(R8)}`),
    () => both(`test ${pick(R16)}, ${pick(R16)}`),
    () => both(`test ${pick(R8)}, ${pick(R8)}`),
    () => both(`test ${pick(R16)}, ${imm16()}`),
    () => both(`test ${pick(R8)}, ${imm8()}`),
    () => both(`xchg ${pick(R16)}, ${pick(R16)}`),
    () => both(`xchg ${pick(R8)}, ${pick(R8)}`),
    () => both(`${pick(SHIFT)} ${pick(R16)}, ${pick(['1', 'cl', lit(int(2, 31))])}`),
    () => both(`${pick(SHIFT)} ${pick(R8)}, ${pick(['1', 'cl', lit(int(2, 31))])}`),
    () => both(`${pick(F7)} ${pick(R16)}`),
    () => both(`${pick(F7)} ${pick(R8)}`),
    () => both(`${pick(['inc', 'dec', 'push', 'pop'])} ${pick(R16)}`),
    () => both(`push ${pick(['es', 'cs', 'ss', 'ds'])}`),
    () => both(`pop ${pick(['es', 'ss', 'ds'])}`),
    () => both(`mov ${pick(['es', 'ss', 'ds'])}, ${pick(R16)}`),
    () => both(`mov ${pick(R16)}, ${pick(['es', 'cs', 'ss', 'ds'])}`),
    () => both(`int ${lit(int(0, 255))}`),
    () => both(pick(NULLARY)),
    () => { const [p, subs] = pick(REPS); return both(`${p} ${pick(subs)}`); },
    () => both(`mov ${pick(R16)}, ${pick(['konst0', 'konst1'])}`),
    () => both(`${pick(ALU)} ${pick(R16)}, ${pick(['konst0', 'konst1'])}`),
    () => both(`mov ${pick(R16)}, [${pick(['konst0', 'konst1'])}]`),
    // ---- full-8086 completion ----
    () => both(`lea ${pick(R16)}, ${mem()}`),
    () => both(`${pick(['les', 'lds'])} ${pick(R16)}, ${mem()}`),
    () => both(`${pick(['inc', 'dec'])} ${pick(R8)}`),
    () => both(`${pick(['inc', 'dec'])} ${pick(SZ)} ${mem()}`),
    () => both(`push word ${mem()}`),
    () => both(`pop word ${mem()}`),
    () => both(`mov byte ${mem()}, ${imm8()}`),
    () => both(`mov word ${mem()}, ${imm16()}`),
    () => both(`${pick(ALU)} byte ${mem()}, ${imm8()}`),
    () => both(`${pick(ALU)} word ${mem()}, ${imm16()}`),
    () => both(`test byte ${mem()}, ${imm8()}`),
    () => both(`test word ${mem()}, ${imm16()}`),
    () => both(`test ${mem()}, ${pick(R16)}`),
    () => both(`test ${mem()}, ${pick(R8)}`),
    () => both(`test ${pick(R16)}, ${mem()}`),
    () => both(`test ${pick(R8)}, ${mem()}`),
    () => both(`${pick(F7)} ${pick(SZ)} ${mem()}`),
    () => both(`${pick(SHIFT)} ${pick(SZ)} ${mem()}, ${pick(['1', 'cl', lit(int(2, 31))])}`),
    () => both(`xchg ${pick(R16)}, ${mem()}`),
    () => both(`xchg ${mem()}, ${pick(R16)}`),
    () => both(`xchg ${pick(R8)}, ${mem()}`),
    () => both(`xchg ${mem()}, ${pick(R8)}`),
    () => both(`mov ${mem()}, ${pick(['es', 'cs', 'ss', 'ds'])}`),
    () => both(`mov ${pick(['es', 'ss', 'ds'])}, ${mem()}`),
    () => both(`${pick(['call', 'jmp'])} ${pick(R16)}`),
    () => both(`${pick(['call', 'jmp'])} ${mem()}`),
    () => both(`${pick(['call', 'jmp'])} far ${mem()}`),
    () => both(`${pick(['call', 'jmp'])} ${lit(int(0, 65535))}:${lit(int(0, 65535))}`),
    () => both(`ret ${lit(int(0, 512))}`),
    () => both(pick(['retf', `retf ${lit(int(0, 512))}`])),
    () => both(`in ${pick(['al', 'ax'])}, ${lit(int(0, 255))}`),
    () => both(`in ${pick(['al', 'ax'])}, dx`),
    () => both(`out ${lit(int(0, 255))}, ${pick(['al', 'ax'])}`),
    () => both(`out dx, ${pick(['al', 'ax'])}`),
    () => both(pick(['aaa', 'aas', 'daa', 'das', 'into', 'wait', 'xlatb', 'aam', 'aad'])),
    () => both(`${pick(['aam', 'aad'])} ${lit(int(1, 255))}`),
    () => both(`mov ${pick(R16)}, ${smem()}`),
    () => both(`${pick(ALU)} ${smem()}, ${pick(R16)}`),
    () => both(`mov byte ${smem()}, ${imm8()}`),
    () => both(`lock ${pick(['add', 'sub', 'and', 'or', 'xor', 'adc', 'sbb'])} ${mem()}, ${pick(R16)}`),
    () => both(`lock ${pick(['inc', 'dec'])} ${pick(SZ)} ${smem()}`),
  ];

  return { pick, int, lit, templates };
}

function buildProgram(rnd) {
  const { pick, int, lit, templates } = makeGen(rnd);
  const equs = [`konst0 equ ${lit(int(0, 65535))}`, `konst1 equ ${lit(int(0, 999))}`];
  const ours = ['org 256', ...equs, 'start:'];
  const nasm = ['bits 16', 'org 256', ...equs, 'start:'];
  const n = int(4, 14);
  const labels = ['start'];
  for (let k = 0; k < n; k++) {
    if (rnd() < 0.15) {
      const name = `l${labels.length}`;
      labels.push(name);
      ours.push(`${name}:`);
      nasm.push(`${name}:`);
      continue;
    }
    if (rnd() < 0.12) {
      const target = pick(labels);
      const op = pick(['jmp', pick(JCC), 'call']);
      ours.push(`${op} ${target}`);
      nasm.push(`${op} ${target}`);
      continue;
    }
    const t = templates[Math.floor(rnd() * templates.length)]();
    ours.push(t.o);
    nasm.push(t.n);
  }
  // data tail: referenced by [msg] operands and dw
  const tail = `msg: db "Ab$", 1, 255, ${lit(int(0, 255))}`;
  ours.push('fin:', tail);
  nasm.push('fin:', tail);
  if (rnd() < 0.5) {
    const w = `dw ${lit(int(0, 65535))}, msg, ${int(-100, -1)}`;
    ours.push(w);
    nasm.push(w);
  }
  return { ours: ours.join('\n') + '\n', nasm: nasm.join('\n') + '\n' };
}

function nasmAssemble(dir, src) {
  const inFile = path.join(dir, 'p.asm');
  const outFile = path.join(dir, 'p.bin');
  fs.writeFileSync(inFile, src);
  execFileSync('nasm', ['-f', 'bin', '-Ox', '-w-all', inFile, '-o', outFile], { stdio: 'pipe' });
  return fs.readFileSync(outFile);
}

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

async function main() {
  if (!hasNasm()) {
    console.log('differential: nasm not found — skipping (brew install nasm to enable)');
    return;
  }
  const count = Number(process.argv[2] || 200);
  const seed = Number(process.argv[3] || 1);
  const rnd = mulberry32(seed);
  const css = fs.readFileSync(path.join(__dirname, '..', 'assembler.css'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accsembly-diff-'));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failures = 0;

  // fixed fixture: the boot sector, vs its nasm twin (times/hex spelled out)
  const bootOurs = fs.readFileSync(path.join(__dirname, '..', 'examples', 'boot.asm'), 'utf8');
  const bootNasm = fs.readFileSync(path.join(__dirname, 'boot.nasm.asm'), 'utf8');
  // relaxation fixture: a jmp that must widen (forward and backward)
  const farBody = ['start:', 'jmp fin', ...Array(180).fill('nop'), 'back: jmp start', 'fin: ret'].join('\n');
  const relax = { ours: `org 256\n${farBody}\n`, nasm: `bits 16\norg 256\n${farBody}\n` };
  const equBody = ['K equ 300', 'DOS equ 0x21', 'mov ax, K', 'add bx, K', 'mov cx, [K]', 'int DOS', 'ret'].join('\n');
  const equFix = { ours: `org 256\n${equBody}\n`, nasm: `bits 16\norg 256\n${equBody}\n` };
  const fixtures = [
    { name: 'examples/boot.asm', ours: bootOurs, nasm: bootNasm },
    { name: 'fixture:jmp-relaxation', ours: relax.ours, nasm: relax.nasm },
    { name: 'fixture:equ', ours: equFix.ours, nasm: equFix.nasm },
  ];

  for (let i = 0; i < count + fixtures.length; i++) {
    const fixture = i < fixtures.length ? fixtures[i] : null;
    const prog = fixture || buildProgram(rnd);
    let ourBytes, nasmBytes;
    try {
      const { items, errors } = lex(prog.ours);
      if (errors.length) throw new Error('lexer: ' + JSON.stringify(errors));
      ourBytes = (await assembleOn(page, items, css, { sourceName: 'diff.asm' })).code;
      nasmBytes = nasmAssemble(dir, prog.nasm);
    } catch (e) {
      failures++;
      console.log(`✗ program ${fixture ? fixture.name : i} crashed: ${e.message}\n--- ours ---\n${prog.ours}`);
      if (failures >= 5) break;
      continue;
    }
    if (!ourBytes.equals(nasmBytes)) {
      failures++;
      let off = 0;
      while (off < Math.min(ourBytes.length, nasmBytes.length) && ourBytes[off] === nasmBytes[off]) off++;
      console.log(`✗ ${fixture ? fixture.name : `program ${i} (seed ${seed})`} diverges at byte ${off}`);
      console.log(`--- ours ---\n${prog.ours}--- nasm ---\n${prog.nasm}`);
      console.log(`ours: ${hex(ourBytes)}\nnasm: ${hex(nasmBytes)}`);
      if (failures >= 5) break;
    } else if (fixture) {
      console.log(`✓ ${fixture.name}: byte-identical to nasm (${ourBytes.length} bytes)`);
    }
  }

  await browser.close();
  if (failures) {
    console.log(`\ndifferential: FAILED (${failures} divergence(s))`);
    process.exit(1);
  }
  console.log(`differential: ${count} random programs + ${fixtures.length} fixture(s), all byte-identical to nasm -Ox`);
}

if (require.main === module) main();

module.exports = { buildProgram, mulberry32 };
