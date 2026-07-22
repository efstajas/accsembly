'use strict';

// Turns lexed lines into the DOM the stylesheet assembles. No encoding
// knowledge here either — just tokens copied into attributes.

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const hexAttrs = (lit) =>
  lit.digits.split('').map((d, idx) => ` h${idx + 1}="${d}"`).join('') + (lit.neg ? ' hneg=""' : '');

// line-level hex literals ride role-tagged wires: ha* (first operand),
// hb* (second operand), hd* (memory displacement)
const roleHexAttrs = (role, lit) =>
  lit.digits.split('').map((d, idx) => ` ${role}${idx + 1}="${d}"`).join('') +
  (lit.neg ? ` ${role}neg=""` : '');

function lineAttrs(item, i, cls) {
  let a = ` class="${cls}" data-i="${i}" k="${item.kind}"`;
  const mem = (prefix, mo) => {
    let s = '';
    if (mo.w1 != null) s += ` ${prefix}1="${esc(mo.w1)}"`;
    if (mo.w2 != null) s += ` ${prefix}2="${esc(mo.w2)}"`;
    if (mo.disp != null) s += ` ${prefix}d="${esc(mo.disp)}"`;
    return s;
  };
  if (item.kind === 'op') {
    a += ` op="${esc(item.op)}"`;
    if (item.a != null) a += ` a="${esc(item.a)}"`;
    if (item.b != null) a += ` b="${esc(item.b)}"`;
    if (item.am) a += mem('ma', item.am);
    if (item.bm) a += mem('mb', item.bm);
    if (item.sz != null) a += ` sz="${esc(item.sz)}"`;
    if (item.mseg != null) a += ` mseg="${esc(item.mseg)}"`;
    if (item.lock) a += ` lock=""`;
    if (item.fseg != null) a += ` fseg="${esc(item.fseg)}"`;
    if (item.foff != null) a += ` foff="${esc(item.foff)}"`;
  }
  if (item.kind === 'org') a += ` n="${esc(item.n)}"`;
  if (item.kind === 'lbl') a += ` name="${esc(item.name)}"`;
  if (item.kind === 'equ') {
    a += ` name="${esc(item.name)}"`;
    if (item.n != null) a += ` n="${esc(item.n)}"`;
  }
  if (item.lith) a += hexAttrs(item.lith);
  if (item.ha) a += roleHexAttrs('ha', item.ha);
  if (item.hb) a += roleHexAttrs('hb', item.hb);
  if (item.hd) a += roleHexAttrs('hd', item.hd);
  if (item.litc != null) a += ` c="${esc(item.litc)}"`;
  return a;
}

function dbCells(item) {
  return item.bytes
    .map((b) => {
      if (b.t === 'c') return `<d c="${esc(b.v)}"></d>`;
      if (b.t === 'h') return `<d${hexAttrs(b)}></d>`;
      return `<d n="${esc(b.v)}"></d>`;
    })
    .join('');
}

function dwCells(item) {
  return item.words
    .map((w) => {
      const inner = '<e></e><e></e>';
      if (w.t === 'h') return `<w${hexAttrs(w)}>${inner}</w>`;
      if (w.t === 's') return `<w s="${esc(w.v)}">${inner}</w>`;
      return `<w n="${esc(w.v)}">${inner}</w>`;
    })
    .join('');
}

function cells(item) {
  if (item.kind === 'db') return dbCells(item);
  if (item.kind === 'dw') return dwCells(item);
  if (item.kind === 'op') return SLOTS;
  return '';
}

// two prefix slots (segment override, lock) + six core byte slots
const SLOTS = '<v></v><v></v><u></u><u></u><u></u><u></u><u></u><u></u>';

function buildPage(items, css, sourceName) {
  const strip = [];
  const bytes = [];
  const tape = [];
  const list = [];

  let padPos = -1;
  let padItem = null;
  let orgItem = null;
  const consts = [];
  items.forEach((item, i) => {
    if (item.kind === 'equ') consts.push(`<i${lineAttrs(item, i, 'ln')}></i>`);
    if (item.kind !== 'blank' && item.kind !== 'equ') {
      const dataCells = item.kind === 'db' ? dbCells(item) : item.kind === 'dw' ? dwCells(item) : '';
      if (item.kind === 'pad') { padPos = strip.length; padItem = item; }
      if (item.kind === 'org') orgItem = item;
      strip.push(`<i${lineAttrs(item, i, 'ln')}>${dataCells}</i>`);
      bytes.push(`<i${lineAttrs(item, i, 'ln')}>${cells(item)}</i>`);
      tape.push(`<i${lineAttrs(item, i, 'ln tp')}>${dataCells}</i>`);
    }
    list.push(
      `<div${lineAttrs(item, i, 'ln lrow')}>` +
        `<span class="addr"></span>` +
        `<span class="hex">${cells(item)}</span>` +
        `<span class="src">${esc(item.src)}</span>` +
        `</div>`
    );
  });
  // pad: wrap [org .. pad] in a flex row whose width is org + target, so the
  // layout engine hands the pad line exactly the leftover pixels (= bytes)
  let stripHtml = strip.join('');
  if (padPos >= 0 && orgItem) {
    stripHtml =
      `<span class="padwrap" o="${esc(orgItem.n)}" n="${esc(padItem.n)}">` +
      strip.slice(0, padPos + 1).join('') +
      `</span>` +
      strip.slice(padPos + 1).join('');
  }

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>accsembly · ${esc(sourceName)}</title>` +
    `<style>${css}</style></head><body>` +
    `<div id="machine" aria-hidden="true">` +
    `<section id="strip">${stripHtml}</section>` +
    `<section id="bytes">${bytes.join('')}</section>` +
    `<section id="consts">${consts.join('')}</section>` +
    `</div>` +
    `<main id="list"><header>accsembly v0.1 — <b>${esc(sourceName)}</b>\n` +
    `assembled by a stylesheet; addresses and machine code below are rendered by CSS counters\n` +
    `<span id="phase"></span></header>` +
    `<section id="tape">${tape.join('')}</section>` +
    `${list.join('')}</main>` +
    `</body></html>`
  );
}

module.exports = { buildPage, esc };
