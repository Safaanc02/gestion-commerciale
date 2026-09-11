import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCALE_LABEL_FORMAT,
  decodeScaleLabel,
  ean13CheckDigit,
  encodeScaleLabel,
  isValidEan13,
  type ScaleLabelFormat,
} from '../main/lib/scale-barcode';

// 2 | 02001 | 0 | 00734 | 7  — item 02001 (lentils), 734 g, EAN-13 check 7.
const LENTILS_734G = '2020010007347';

test('ean13CheckDigit: known-good retail barcode', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1);
});

test('isValidEan13: accepts a correct code and rejects a mistyped one', () => {
  assert.equal(isValidEan13(LENTILS_734G), true);
  assert.equal(isValidEan13('2020010007345'), false);
});

test('isValidEan13: rejects wrong length and non-digits', () => {
  assert.equal(isValidEan13('202001000734'), false);
  assert.equal(isValidEan13('20200100073X7'), false);
});

test('decodeScaleLabel: reads item code and weight off a scale label', () => {
  const out = decodeScaleLabel(LENTILS_734G);
  assert.equal(out.status, 'ok');
  assert.equal(out.status === 'ok' && out.label.embeds, 'weight');
  assert.equal(out.status === 'ok' && out.label.itemCode, '02001');
  assert.equal(out.status === 'ok' && out.label.embeds === 'weight' && out.label.weightKg, 0.734);
});

test('decodeScaleLabel: weight is exact, with no floating-point tail', () => {
  // 734/1000 must round-trip as 0.734 — a tail here would print on the receipt.
  const out = decodeScaleLabel(LENTILS_734G);
  assert.equal(out.status === 'ok' && out.label.embeds === 'weight' && String(out.label.weightKg), '0.734');
});

test('decodeScaleLabel: an ordinary product barcode is not a scale label', () => {
  // Prefix 6 (Morocco's GS1 range starts 611) — must fall through to a normal lookup.
  assert.equal(decodeScaleLabel('6111234567892').status, 'not-scale-label');
});

test('decodeScaleLabel: non-numeric scans fall through rather than erroring', () => {
  assert.equal(decodeScaleLabel('ABC-123').status, 'not-scale-label');
  assert.equal(decodeScaleLabel('').status, 'not-scale-label');
});

test('decodeScaleLabel: a corrupt check digit is rejected, never charged', () => {
  // The scale prefix is present, so this is a damaged label — it must NOT fall
  // through to a normal barcode lookup, or a misread weight gets billed.
  const out = decodeScaleLabel('2020010007345');
  assert.equal(out.status, 'invalid');
  assert.equal(out.status === 'invalid' && out.reason, 'bad-check-digit');
});

test('decodeScaleLabel: truncated scan is reported as bad length', () => {
  const out = decodeScaleLabel('202001000734');
  assert.equal(out.status, 'invalid');
  assert.equal(out.status === 'invalid' && out.reason, 'bad-length');
});

test('decodeScaleLabel: zero weight is refused', () => {
  const zero = encodeScaleLabel('02001', 0);
  assert.ok(zero);
  const out = decodeScaleLabel(zero);
  assert.equal(out.status, 'invalid');
  assert.equal(out.status === 'invalid' && out.reason, 'bad-value');
});

test('decodeScaleLabel: price-embedded configuration', () => {
  const priceFormat: ScaleLabelFormat = {
    ...DEFAULT_SCALE_LABEL_FORMAT,
    embeds: 'price',
    divisor: 100,
  };
  // 01250 centimes -> 12.50 MAD
  const code = encodeScaleLabel('02001', 1250, priceFormat);
  assert.ok(code);
  const out = decodeScaleLabel(code, priceFormat);
  assert.equal(out.status, 'ok');
  assert.equal(out.status === 'ok' && out.label.embeds === 'price' && out.label.priceMajor, 12.5);
});

test('decodeScaleLabel: two-digit prefix layout (20 IIIII VVVVV K)', () => {
  const twoDigitPrefix: ScaleLabelFormat = {
    prefixes: ['20'],
    itemCodeStart: 2,
    itemCodeLength: 5,
    valueStart: 7,
    valueLength: 5,
    embeds: 'weight',
    divisor: 1000,
    verifyCheckDigit: true,
  };
  const code = encodeScaleLabel('01750', 1500, twoDigitPrefix);
  assert.ok(code);
  assert.equal(isValidEan13(code), true);
  const out = decodeScaleLabel(code, twoDigitPrefix);
  assert.equal(out.status, 'ok');
  assert.equal(out.status === 'ok' && out.label.itemCode, '01750');
  assert.equal(out.status === 'ok' && out.label.embeds === 'weight' && out.label.weightKg, 1.5);
});

test('decodeScaleLabel: a nonsense format config is reported, not silently applied', () => {
  const broken: ScaleLabelFormat = { ...DEFAULT_SCALE_LABEL_FORMAT, valueStart: 10, valueLength: 5 };
  const out = decodeScaleLabel(LENTILS_734G, broken);
  assert.equal(out.status, 'invalid');
  assert.equal(out.status === 'invalid' && out.reason, 'bad-format');
});

test('encodeScaleLabel: round-trips through decodeScaleLabel', () => {
  for (const grams of [1, 5, 250, 734, 1500, 99999]) {
    const code = encodeScaleLabel('02001', grams);
    assert.ok(code, `encode failed for ${grams} g`);
    assert.equal(isValidEan13(code), true, `bad check digit for ${grams} g`);
    const out = decodeScaleLabel(code);
    assert.equal(out.status, 'ok', `decode failed for ${grams} g`);
    assert.equal(
      out.status === 'ok' && out.label.embeds === 'weight' && out.label.weightKg,
      Number((grams / 1000).toFixed(3)),
    );
  }
});

test('encodeScaleLabel: rejects an item code of the wrong width', () => {
  assert.equal(encodeScaleLabel('201', 734), null);
  assert.equal(encodeScaleLabel('0200199', 734), null);
});
