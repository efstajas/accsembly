#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { lex } = require('../src/lexer');
const { assemble, AsmError } = require('../src/assemble');

const USAGE = `accsembly — an x86-16 assembler implemented in HTML and CSS

usage: accsembly <input.asm> [options]

options:
  -o <file>      output binary (default: <input>.com)
  --html <file>  also save the assembled page (listing + machine fabric)
  --show         watch the compilation: opens a visible browser and stages
                 both assembler passes slowly enough for human eyes
  --boot         use the bootstrapped chain: tokenizing, symbol resolution
                 and byte extraction are done by DOS programs (boot/*.com)
                 that were themselves assembled by the stylesheet, executed
                 in the bundled 8086 interpreter. Node only moves bytes.
  -q             quiet: no listing on stdout

The CLI tokenizes and does I/O. All actual compilation — opcode lookup,
ModRM math, address assignment, jump resolution, hex rendering — is
performed by a Chromium layout engine interpreting assembler.css.`;

function fail(msg) {
  console.error(`accsembly: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { out: null, html: null, quiet: false, show: false, boot: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opts.out = argv[++i];
    else if (a === '--html') opts.html = argv[++i];
    else if (a === '--show') opts.show = true;
    else if (a === '--boot') opts.boot = true;
    else if (a === '-q') opts.quiet = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); return; }
    else if (a.startsWith('-')) fail(`unknown option '${a}'\n\n${USAGE}`);
    else positional.push(a);
  }
  if (positional.length !== 1) { console.log(USAGE); process.exit(positional.length ? 1 : 0); }

  const inputPath = positional[0];
  let source;
  try {
    source = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    fail(`cannot read ${inputPath}: ${e.message}`);
  }

  if (opts.boot) {
    const { assembleBoot, BootError } = require('../src/bootchain');
    let result;
    try {
      result = await assembleBoot(source, { sourceName: path.basename(inputPath) });
    } catch (e) {
      if (e instanceof BootError) fail(e.message);
      throw e;
    }
    const outPath = opts.out || inputPath.replace(/\.\w+$/, '').concat('.com');
    fs.writeFileSync(outPath, result.code);
    console.log(`accsembly: wrote ${outPath} (${result.code.length} bytes of x86 — lexed, linked and read out by CSS-assembled DOS programs)`);
    return;
  }

  const { items, errors } = lex(source);
  if (errors.length) {
    for (const e of errors) console.error(`accsembly: line ${e.lineNo}: ${e.msg}`);
    process.exit(1);
  }

  const css = fs.readFileSync(path.join(__dirname, '..', 'assembler.css'), 'utf8');
  const sourceName = path.basename(inputPath);

  const pause = () =>
    new Promise((resolve) => {
      process.stderr.write(
        '\naccsembly: the page you are looking at IS the compiler, mid-thought.\n' +
          '           open devtools, change an attribute (try b="76" on a mov), and watch the\n' +
          '           HEX column re-encode. (the source column never changes — that is what\n' +
          '           you wrote; the hex is what you now mean. edited rows turn gold.)\n' +
          '           press Enter here to run the readout and write the binary... '
      );
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.once('line', () => {
        rl.close();
        resolve();
      });
    });

  let result;
  try {
    result = await assemble(items, css, { sourceName, keepHtml: !!opts.html, show: opts.show, pause });
  } catch (e) {
    if (e instanceof AsmError) fail(e.message);
    throw e;
  }

  const outPath = opts.out || inputPath.replace(/\.\w+$/, '').concat('.com');
  fs.writeFileSync(outPath, result.code);
  if (opts.html) fs.writeFileSync(opts.html, result.html);

  if (!opts.quiet) {
    const hex = (n, w) => n.toString(16).padStart(w, '0');
    for (const l of result.listing) {
      const bytes = l.note || l.bytes.map((b) => hex(b, 2)).join(' ');
      console.log(`  ${hex(l.addr, 4)}  ${bytes.padEnd(12)}  ${l.src}`);
    }
    console.log('');
  }
  console.log(`accsembly: wrote ${outPath} (${result.code.length} bytes of x86, computed by a stylesheet)`);
  if (opts.html) console.log(`accsembly: kept assembled page at ${opts.html}`);
}

main().catch((e) => fail(e.stack || String(e)));
