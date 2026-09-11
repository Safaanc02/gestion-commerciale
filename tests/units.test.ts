import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRECISION,
  defaultPrecision,
  formatQuantity,
  hasAllowedPrecision,
  isUom,
  isWeighed,
  roundMoney,
  roundQuantity,
  UOM_VALUES,
} from '../main/lib/units';

test('isUom / isWeighed: vocabulary guards', () => {
  assert.equal(isUom('kg'), true);
  assert.equal(isUom('unit'), true);
  assert.equal(isUom('g'), false);
  assert.equal(isUom(undefined), false);
  assert.equal(isWeighed('kg'), true);
  assert.equal(isWeighed('unit'), false);
  assert.deepEqual([...UOM_VALUES], ['unit', 'kg']);
  assert.equal(defaultPrecision('kg'), 3);
  assert.equal(defaultPrecision('unit'), 0);
  assert.equal(DEFAULT_PRECISION.kg, 3);
});

test('roundMoney: rounds the decimal the user meant, not its binary shadow', () => {
  // The whole reason this shares tax.ts's algorithm: toFixed would answer
  // "1.00" here, quietly losing a centime on every such line.
  assert.equal((1.005).toFixed(2), '1.00');
  assert.equal(roundMoney(1.005), 1.01);
});

test('roundMoney: a weighed line total', () => {
  // 0.734 kg x 12.50 MAD/kg = 9.175 -> 9.18 MAD
  assert.equal(roundMoney(0.734 * 12.5), 9.18);
  assert.equal(roundMoney(1.5 * 12.5), 18.75);
  assert.equal(roundMoney(0), 0);
});

test('roundMoney: already-round values are untouched', () => {
  assert.equal(roundMoney(12.5), 12.5);
  assert.equal(roundMoney(100), 100);
});

test('roundMoney: non-finite input degrades to 0 rather than NaN', () => {
  assert.equal(roundMoney(NaN), 0);
  assert.equal(roundMoney(Infinity), 0);
  assert.equal(roundMoney(undefined as unknown as number), 0);
});

test('roundQuantity: rounds to the product-declared precision', () => {
  assert.equal(roundQuantity(0.7344, 3), 0.734);
  assert.equal(roundQuantity(0.7346, 3), 0.735);
  assert.equal(roundQuantity(2.4, 0), 2);
  assert.equal(roundQuantity(0.734, 3), 0.734);
});

test('hasAllowedPrecision: accepts a gram, refuses finer', () => {
  assert.equal(hasAllowedPrecision(0.734, 3), true);
  assert.equal(hasAllowedPrecision(1.5, 3), true);
  assert.equal(hasAllowedPrecision(0.7341, 3), false);
});

test('hasAllowedPrecision: countable items must be whole', () => {
  assert.equal(hasAllowedPrecision(2, 0), true);
  assert.equal(hasAllowedPrecision(1.5, 0), false);
});

test('hasAllowedPrecision: binary representation error does not cause a false reject', () => {
  // Every gram value from a 5-digit scale field must pass; a naive
  // `value * 1000 % 1 === 0` fails on several of these.
  for (let g = 1; g <= 2000; g++) {
    const kg = g / 1000;
    assert.equal(hasAllowedPrecision(kg, 3), true, `${g} g wrongly rejected`);
  }
});

test('hasAllowedPrecision: rejects nonsense input instead of throwing', () => {
  assert.equal(hasAllowedPrecision(NaN, 3), false);
  assert.equal(hasAllowedPrecision(0.5, -1), false);
  assert.equal(hasAllowedPrecision(0.5, 1.5), false);
});

test('formatQuantity: weighed quantities keep the scale label wording', () => {
  assert.equal(formatQuantity(0.734, 'kg', 'fr-MA'), '0,734 kg');
  // Trailing zeros are deliberate: the label says "1,500 kg", so must the till.
  assert.equal(formatQuantity(1.5, 'kg', 'fr-MA'), '1,500 kg');
});

test('formatQuantity: countable quantities carry no unit and no decimals', () => {
  assert.equal(formatQuantity(2, 'unit', 'fr-MA'), '2');
  assert.equal(formatQuantity(12, 'unit', 'fr-MA'), '12');
});

test('formatQuantity: unknown locale falls back instead of throwing', () => {
  assert.equal(formatQuantity(0.734, 'kg', 'not-a-locale!!'), '0.734 kg');
});

test('formatQuantity: non-finite quantity renders as zero, never "NaN kg"', () => {
  assert.equal(formatQuantity(NaN, 'kg', 'fr-MA'), '0,000 kg');
});
