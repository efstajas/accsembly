'use strict';

// The bootstrap ritual.
//
//   stage 0:  the JS chain assembles boot/{lexer,linker,writer}.asm
//   parity:   the bootstrapped chain must produce byte-identical output
//             to the JS chain on every example and stress program
//   fixed point: the bootstrapped chain reassembles its own three source
//             files; the output must equal the binaries it is running on.
//
// After this passes, the only things that ever computed are a CSS engine
// and x86 machine code the CSS engine assembled. (And Ken Thompson is
// somewhere, smiling.)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { lex } = require('../src/lexer');
const { assembleOn } = require('../src/assemble');
const { assembleBoot } = require('../src/bootchain');

const R = path.join(__dirname, '..');
const BOOT = path.join(R, 'boot');

const STRESS = `
; stress: the full grammar through the bootstrapped chain
org 256
DOS equ 0x21
K equ 300
start:
  mov ah, 9
  mov dx, msg
  int DOS
  lea bx, [msg+2]
  les di, [bx]
  lds si, [bp+2]
  inc byte [bx]
  dec word [bp]
  inc cl
  push word [bx]
  pop word [di]
  mov byte [si], 5
  mov word [bx+1], 0x1234
  add word [bx], 5
  xor byte [di], 0x80
  test byte [di], 0x80
  test [bx], ax
  not word [bx]
  shl word [bx], 1
  rol word [bp], 3
  xchg [bx], cx
  lock add [bx], ax
  mov ax, [es:bx]
  mov al, [cs:si+5]
  mov [ss:bp], dx
  in al, 0x40
  out dx, ax
  aam
  aad 7
  daa
loop1:
  loop loop1
  call work
  call bx
  jmp short fin
work:
  ret 2
  retf
fin:
  mov cx, K
  mov ax, 0x4c00
  int DOS
msg: db "stress, via a stylesheet and three DOS programs", 13, 10, 36, 'x', 0x7f
  dw 0x1234, msg, -2
`;

async function main() {
  const css = fs.readFileSync(path.join(R, 'assembler.css'), 'utf8');
  const browser = await chromium.launch();
  const jsPage = await browser.newPage();
  const bootPage = await browser.newPage();
  let failures = 0;

  const jsAssemble = async (src, name) => {
    const { items, errors } = lex(src);
    if (errors.length) throw new Error(`${name}: ${JSON.stringify(errors[0])}`);
    return (await assembleOn(jsPage, items, css, { sourceName: name })).code;
  };

  // ---- stage 0 -------------------------------------------------------------
  console.log('stage 0: JS chain assembles the boot programs');
  const stage0 = {};
  for (const p of ['lexer', 'linker', 'writer']) {
    const src = fs.readFileSync(path.join(BOOT, `${p}.asm`), 'utf8');
    stage0[p] = await jsAssemble(src, `${p}.asm`);
    fs.writeFileSync(path.join(BOOT, `${p}.com`), stage0[p]);
    console.log(`  ${p}.com: ${stage0[p].length} bytes`);
  }

  // ---- parity --------------------------------------------------------------
  const cases = [
    ...['hello', 'countdown', 'memory', 'boot'].map((n) => ({
      name: `examples/${n}.asm`,
      src: fs.readFileSync(path.join(R, 'examples', `${n}.asm`), 'utf8'),
    })),
    { name: 'stress fixture', src: STRESS },
  ];
  for (const c of cases) {
    const a = await jsAssemble(c.src, c.name);
    const b = (await assembleBoot(c.src, { sourceName: c.name, css, page: bootPage })).code;
    const ok = a.equals(b);
    console.log(`${ok ? '✓' : '✗'} parity: ${c.name} (${a.length} bytes)`);
    if (!ok) {
      failures++;
      let off = 0;
      while (off < Math.min(a.length, b.length) && a[off] === b[off]) off++;
      console.log(`   diverges at byte ${off}: js=${a[off]?.toString(16)} boot=${b[off]?.toString(16)} (lengths ${a.length}/${b.length})`);
    }
  }

  // ---- random parity -------------------------------------------------------
  const { buildProgram, mulberry32 } = require('./differential');
  const rnd = mulberry32(Number(process.argv[3] || 9));
  const count = Number(process.argv[2] || 20);
  let parityOk = 0;
  for (let k = 0; k < count; k++) {
    const prog = buildProgram(rnd).ours;
    const a = await jsAssemble(prog, `random ${k}`);
    const b = (await assembleBoot(prog, { sourceName: `random ${k}`, css, page: bootPage })).code;
    if (a.equals(b)) parityOk++;
    else {
      failures++;
      console.log(`✗ parity: random program ${k}\n${prog}`);
      if (failures >= 3) break;
    }
  }
  console.log(`✓ parity: ${parityOk}/${count} random programs byte-identical across chains`);

  // ---- the fixed point -----------------------------------------------------
  console.log('fixed point: the chain reassembles its own sources, using itself');
  for (const p of ['writer', 'linker', 'lexer']) {
    const src = fs.readFileSync(path.join(BOOT, `${p}.asm`), 'utf8');
    const again = (await assembleBoot(src, { sourceName: `${p}.asm`, css, page: bootPage })).code;
    const ok = again.equals(stage0[p]);
    console.log(`${ok ? '✓' : '✗'} ${p}.com ≡ boot-chain(${p}.asm) (${again.length} bytes)`);
    if (!ok) failures++;
  }

  await browser.close();
  if (failures) {
    console.log(`\nbootstrap: FAILED (${failures})`);
    process.exit(1);
  }
  console.log('\nbootstrap: the snake has eaten its tail and reports no indigestion');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
