import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, toVisualOrder, encode, renderLine, hasArabic, stripInvisible } from '../main/printers/arabic';
import { buildEscPos } from '../main/printers/thermal';

const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

test('shape: a word picks initial, medial and final glyphs from its neighbours', () => {
  // كتاب — kaf starts the word, teh sits between two joiners, alef only joins
  // to its right, and beh stands alone after it because alef never joins on.
  assert.equal(cp(shape('كتاب')), 'FEDB FE98 FE8E FE8F');
});

test('shape: a right-joining letter never connects to what follows it', () => {
  // Neither letter joins forward, so both stand alone: dal isolated (FEA9),
  // not final (FEAA), and the ra after it isolated too.
  assert.equal(cp(shape('در')), 'FEA9 FEAD');
  // With a joiner in front, the same dal does take its final form.
  assert.equal(cp(shape('بد')), 'FE91 FEAA');
});

test('shape: lam followed by alef becomes one ligature glyph, not two letters', () => {
  assert.equal(cp(shape('لا')), 'FEFB');
  // After a joining letter the ligature takes its final form.
  assert.equal(cp(shape('سلام')), 'FEB3 FEFC FEE1');
});

test('shape: a vowel mark between two letters does not break their join', () => {
  // Fatha over the beh must not turn the following noon into an initial form.
  const withMark = shape('بَن');
  assert.ok(withMark.includes('ﻦ'), 'noon stays final: ' + cp(withMark));
});

test('toVisualOrder: Arabic runs are reversed but digits keep reading order', () => {
  // "200غ" must not come out as "002غ" — the one error a customer would spot.
  assert.ok(toVisualOrder('شاي 200غ').includes('200'));
});

test('toVisualOrder: words inside one Arabic run swap places with their letters', () => {
  const visual = toVisualOrder('اب جد');
  // The second word now precedes the first.
  assert.equal(visual, 'دج با');
});

test('toVisualOrder: a Latin line is left exactly as it is', () => {
  assert.equal(toVisualOrder('Ble dur 1kg'), 'Ble dur 1kg');
});

test('encode: CP1256 carries base letters and drops nothing from a product name', () => {
  const out = encode('شاي الرابوز', 'cp1256');
  assert.equal(out.dropped.length, 0);
  assert.ok(out.bytes.length > 0);
});

test('encode: CP864 substitutes the shape it holds for one it does not', () => {
  // CP864 keeps two shapes per letter for most letters. Beh's final form is
  // absent, so it must be written with the isolated one rather than dropped.
  const out = encode(shape('كتاب'), 'cp864');
  assert.equal(out.dropped.length, 0, 'dropped: ' + out.dropped.join(''));
});

test('encode: ASCII passes through both code pages untouched', () => {
  for (const page of ['cp864', 'cp1256'] as const) {
    assert.equal(encode('Ble dur 1kg', page).bytes.toString('latin1'), 'Ble dur 1kg');
  }
});

test('renderLine: real catalogue names survive both code pages intact', () => {
  const names = ['شاي الرابوز 200غ', 'اسطا كراميل 200غ', 'جيل دوش خزامة 450مل', 'لانشون لحم الدجاج'];
  for (const page of ['cp864', 'cp1256'] as const) {
    for (const name of names) {
      const out = renderLine(name, page);
      assert.equal(out.dropped.length, 0, `${page} dropped ${out.dropped.join('')} from ${name}`);
      assert.ok(out.bytes.length >= name.replace(/\s/g, '').length / 2, `${page}: ${name} came out empty`);
    }
  }
});

test('stripInvisible: direction marks never reach the printer', () => {
  assert.equal(stripInvisible('‏شاي‎'), 'شاي');
  assert.equal(hasArabic('Ble dur'), false);
});

test('buildEscPos: without an Arabic code page the old ASCII fold still applies', () => {
  const out = buildEscPos(['شاي', 'Cafe'], false, { arabic: null });
  // The Arabic line drops out entirely, the Latin one survives — the previous
  // behaviour, unchanged for shops whose printer has no Arabic mode.
  assert.ok(out.includes(Buffer.from('Cafe')));
  assert.ok(!out.includes(Buffer.from([0x1b, 0x74])), 'no code page command expected');
});

test('buildEscPos: an Arabic line selects the code page and restores it after', () => {
  const out = buildEscPos(['شاي'], false, { arabic: { codepage: 'cp1256', charsetId: 50 } });
  assert.ok(out.includes(Buffer.from([0x1b, 0x74, 50])), 'ESC t 50 should select CP1256');
  assert.ok(out.includes(Buffer.from([0x1b, 0x74, 0x00])), 'the default table should be restored');
});

test('buildEscPos: a Latin line is untouched when Arabic printing is on', () => {
  const out = buildEscPos(['Cafe Creme'], false, { arabic: { codepage: 'cp864', charsetId: 22 } });
  assert.ok(out.includes(Buffer.from('Cafe Creme')));
  assert.ok(!out.includes(Buffer.from([0x1b, 0x74, 22])), 'no switch for a line with no Arabic');
});

test('buildEscPos: a mixed line keeps its Latin part readable', () => {
  const out = buildEscPos(['TOREN بيسكوي'], false, { arabic: { codepage: 'cp1256', charsetId: 50 } });
  assert.ok(out.includes(Buffer.from('TOREN')), 'the Latin brand must still print');
});
