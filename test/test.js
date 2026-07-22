'use strict';

// Golden-byte tests: every expected sequence below is hand-assembled from
// the Intel SDM. If the stylesheet disagrees with Intel, the stylesheet
// is wrong (a sentence I did not expect to write either).

const fs = require('fs');
const path = require('path');
const { lex } = require('../src/lexer');
const { assemble } = require('../src/assemble');

const css = fs.readFileSync(path.join(__dirname, '..', 'assembler.css'), 'utf8');

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const CASES = [
  {
    name: 'hello world (mov r8/r16 imm, int, label as immediate, db string)',
    asm: `
org 256
mov ah, 9
mov dx, msg
int 33
mov ax, 19456
int 33
msg: db "hi$"
`,
    // 0100: b4 09 | 0102: ba 0c 01 (msg=0x10c) | 0105: cd 21
    // 0107: b8 00 4c | 010a: cd 21 | 010c: 68 69 24
    want: 'b4 09 ba 0c 01 cd 21 b8 00 4c cd 21 68 69 24',
  },
  {
    name: 'loops, alu, conditional jumps (backward rel8 via mod())',
    asm: `
org 256
mov cx, 5
mov ax, 0
top:
add ax, cx
dec cx
jne top
cmp ax, 15
je done
hlt
nop
done:
ret
`,
    // 0100: b9 05 00 | 0103: b8 00 00 | top=0106: 01 c8 | 0108: 49
    // 0109: 75 fb (rel8 = 0x106-0x10b = -5) | 010b: 83 f8 0f (sign-extended imm8)
    // 010e: 74 02 (done=0x112) | 0110: f4 | 0111: 90 | done=0112: c3
    want: 'b9 05 00 b8 00 00 01 c8 49 75 fb 83 f8 0f 74 02 f4 90 c3',
  },
  {
    name: 'mov r,r + xor + inc + push/pop + db numbers and chars',
    asm: `
org 256
xor ax, ax
mov bx, ax
inc bx
push bx
pop dx
mov dl, 65
db 1, 2, 'A', 255, -1
`,
    // 31 c0 | 89 c3 | 43 | 53 | 5a | b2 41 | 01 02 41 ff ff
    want: '31 c0 89 c3 43 53 5a b2 41 01 02 41 ff ff',
  },
  {
    name: 'call rel16 (forward), negative immediates wrap little-endian',
    asm: `
org 256
call fn
mov ax, -2
hlt
fn:
ret
`,
    // 0100: e8 04 00 (fn=0x107, rel16 = 0x107 - 0x103 = 4)
    // 0103: b8 fe ff | 0106: f4 | fn=0107: c3
    want: 'e8 04 00 b8 fe ff f4 c3',
  },
  {
    name: 'default org is 256 when omitted',
    asm: `
mov dx, msg
hlt
msg: db 36
`,
    // 0100: ba 04 01 (msg = 0x104) | 0103: f4 | 0104: 24
    want: 'ba 04 01 f4 24',
  },
  {
    name: 'memory operands: [bx], [bx+d], [label], [label+d], [bx+si+d]',
    asm: `
org 256
mov bx, msg
mov ax, [bx]
mov cx, [bx+2]
add ax, [msg]
mov [msg+2], ax
mov dl, [bx+si+1]
hlt
msg: db 1, 2, 3, 4
`,
    // 0100: bb 13 01 (msg=0x113) | 0103: 8b 07 ([bx] -> mod00, no disp!)
    // 0105: 8b 4f 02 (disp8) | 0108: 03 06 13 01 (direct keeps disp16)
    // 010c: a3 15 01 (acc store) | 010f: 8a 50 01 (disp8) | 0112: f4 | 0113: data
    want: 'bb 13 01 8b 07 8b 4f 02 03 06 13 01 a3 15 01 8a 50 01 f4 01 02 03 04',
  },
  {
    name: 'memory operands: [bp], [bp+si], [direct], store r8, negative disp',
    asm: `
org 256
mov ax, [bp]
mov ax, [bp+si]
mov ax, [256]
mov [di], al
sub cx, [si-2]
`,
    // 8b 46 00 ([bp] forces a zero disp8) | 8b 02 ([bp+si] needs none)
    // a1 00 01 (acc load) | 88 05 | 2b 4c fe (disp8 -2)
    want: '8b 46 00 8b 02 a1 00 01 88 05 2b 4c fe',
  },
  {
    name: 'dw: words little-endian, label values, negatives',
    asm: `
org 256
dw 65535, 1, msg
msg: db 1
`,
    // msg = 0x106: ff ff | 01 00 | 06 01 | 01
    want: 'ff ff 01 00 06 01 01',
  },
  {
    name: 'pad: flexbox emits the zeros, dw plants the signature',
    asm: `
org 256
nop
pad 6
dw 43605
`,
    // 90 | five 00s (offset 1 -> 6, solved by flex-grow) | 55 aa
    want: '90 00 00 00 00 00 55 aa',
  },
  {
    name: 'errors: pad target already passed',
    asm: `org 256\nmov ax, 1\npad 2\n`,
    wantError: /pad 2: code has already reached/,
  },
  {
    name: 'errors: [ax] is not a thing the ModRM table can say',
    asm: `org 256\nmov ax, [ax]\n`,
    wantError: /no encoding for 'mov ax, \[ax\]'/,
  },
  {
    name: 'errors: two memory operands',
    asm: `org 256\nx: mov [x], [x]\n`,
    wantError: /at most one memory operand/,
  },
  {
    name: 'errors: two distinct symbols on one line',
    asm: `org 256\na: nop\nb: nop\nmov [a], b\n`,
    wantError: /one symbol reference per line/,
  },
  {
    name: 'errors: unknown instruction is rejected by the opcode table (a stylesheet)',
    asm: `org 256\nfrobnicate ax, 5\n`,
    wantError: /no encoding for 'frobnicate ax, 5'/,
  },
  {
    name: 'errors: undefined symbol',
    asm: `org 256\njmp nowhere\n`,
    wantError: /undefined symbol 'nowhere'/,
  },
  {
    name: 'errors: conditional jump out of rel8 range (jcc cannot widen on 8086)',
    asm: `org 256\nje far_away\ndb ${Array(200).fill('0').join(', ')}\nfar_away: ret\n`,
    wantError: /out of rel8 range/,
  },
  {
    name: 'jmp widens itself to E9 rel16 when the target is far (relaxation)',
    asm: `org 256\njmp far_away\ndb ${Array(200).fill('0').join(', ')}\nfar_away: ret\nback: jmp back\n`,
    // e9 c8 00 (rel16 = 0x1cb - 0x103 = 200) | 200 zeros | c3 | eb fe (still short)
    want: 'e9 c8 00 ' + Array(200).fill('00').join(' ') + ' c3 eb fe',
  },
  {
    name: 'immediate size optimization: 83 vs 81 vs accumulator forms',
    asm: `
org 256
add cx, 5
add cx, 300
add cx, 65409
add ax, 5
add ax, 300
sub sp, 2
`,
    // 83 c1 05 | 81 c1 2c 01 | 83 c1 81 (0xff81 sign-extends) | 83 c0 05
    // 05 2c 01 (acc only when imm8 won't do) | 83 ec 02
    want: '83 c1 05 81 c1 2c 01 83 c1 81 83 c0 05 05 2c 01 83 ec 02',
  },
  {
    name: 'hex and char literals (parsed by sixty-four attribute selectors)',
    asm: `
org 256
mov ax, 0x1234
int 0x21
mov cl, 'A'
mov dx, [bx+0x10]
add cx, -0x5
db 0x41, 'B', 66
dw 0xaa55
`,
    // b8 34 12 | cd 21 | b1 41 | 8b 57 10 | 83 c1 fb | 41 42 42 | 55 aa
    want: 'b8 34 12 cd 21 b1 41 8b 57 10 83 c1 fb 41 42 42 55 aa',
  },
  {
    name: 'equ: constants whose value is the width of a box',
    asm: `
VALUE equ 258
DOS equ 0x21
org 256
mov ax, VALUE
mov cx, [VALUE]
int DOS
`,
    // b8 02 01 | 8b 0e 02 01 | cd 21
    want: 'b8 02 01 8b 0e 02 01 cd 21',
  },
];

const { runCom } = require('./run-com');

// end-to-end: assemble the shipped examples and *execute* the resulting
// x86 in the toy 8086 interpreter, asserting on what they print
const RUNS = [
  { file: 'hello.asm', want: 'hello from a cascading style sheet!\r\n' },
  { file: 'countdown.asm', want: '5 4 3 2 1 liftoff!\r\n' },
  { file: 'memory.asm', want: 'memory operands, in CSS' },
  { file: 'boot.asm', want: 'A cascading style sheet booted this computer.\r\n', org: 31744 },
];

(async () => {
  let failed = 0;
  for (const c of CASES) {
    const { items, errors } = lex(c.asm);
    if (errors.length) {
      console.log(`✗ ${c.name}\n    lexer errors: ${JSON.stringify(errors)}`);
      failed++;
      continue;
    }
    try {
      const { code } = await assemble(items, css, { sourceName: 'test.asm' });
      const got = hex(code);
      if (c.wantError) {
        console.log(`✗ ${c.name}\n    expected error ${c.wantError}, got bytes: ${got}`);
        failed++;
      } else if (got === c.want) {
        console.log(`✓ ${c.name}`);
      } else {
        console.log(`✗ ${c.name}\n    want: ${c.want}\n    got:  ${got}`);
        failed++;
      }
    } catch (e) {
      if (c.wantError && c.wantError.test(e.message)) {
        console.log(`✓ ${c.name}`);
      } else {
        console.log(`✗ ${c.name}\n    unexpected error: ${e.message}`);
        failed++;
      }
    }
  }
  for (const r of RUNS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'examples', r.file), 'utf8');
    try {
      const { items } = lex(src);
      const { code } = await assemble(items, css, { sourceName: r.file });
      let out = '';
      runCom(code, (s) => (out += s), r.org);
      if (out === r.want) console.log(`✓ ${r.file} assembles AND runs (prints ${JSON.stringify(r.want.trim())})`);
      else { console.log(`✗ ${r.file} ran but printed ${JSON.stringify(out)}`); failed++; }
    } catch (e) {
      console.log(`✗ ${r.file}: ${e.message}`);
      failed++;
    }
  }

  console.log(failed ? `\n${failed} test(s) failed` : '\nall green — Intel and the cascade agree');
  process.exit(failed ? 1 : 0);
})();
