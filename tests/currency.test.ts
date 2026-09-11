import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency, formatCurrencyForTenant } from '../main/countries';

test('formatCurrency: en-US / USD', () => {
  assert.equal(formatCurrency(1234.5, 'USD', 'en-US'), '$1,234.50');
});

test('formatCurrency: en-IN / INR has rupees symbol and grouping', () => {
  const out = formatCurrency(1234.5, 'INR', 'en-IN');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrency: es-AR / ARS uses comma decimal', () => {
  const out = formatCurrency(1234.5, 'ARS', 'es-AR');
  assert.match(out, /1\.234,50/);
});

test('formatCurrency: zero amount still formats', () => {
  assert.equal(formatCurrency(0, 'USD', 'en-US'), '$0.00');
});

test('formatCurrency: empty currency falls back to fixed', () => {
  assert.equal(formatCurrency(1234.5, '', 'en-US'), '1234.50');
});

test('formatCurrencyForTenant: IN tenant uses en-IN locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'IN', 'INR');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrencyForTenant: AR tenant uses es-AR locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'AR', 'ARS');
  assert.match(out, /1\.234,50/);
});

test('formatCurrencyForTenant: US tenant uses en-US locale', () => {
  assert.equal(formatCurrencyForTenant(1234.5, 'US', 'USD'), '$1,234.50');
});

test('formatCurrencyForTenant: unknown country falls back to en-US', () => {
  assert.equal(formatCurrencyForTenant(7, 'ZZ', 'USD'), '$7.00');
});

test('formatCurrencyForTenant: missing country defaults to IN', () => {
  const out = formatCurrencyForTenant(7, undefined, 'INR');
  assert.match(out, /7\.00/);
  assert.match(out, /₹/);
});

test('formatCurrency: Moroccan dirham shows DH, not the ISO code', () => {
  // CLDR has no short form for MAD, so every locale renders "MAD" — but no
  // price tag in Morocco says that. The override swaps the currency part only,
  // leaving the locale's grouping and decimal separator untouched.
  // \u00a0 is the non-breaking space fr-MA puts before the symbol — asserted
  // literally so a change to it fails here rather than on a printed receipt.
  assert.equal(formatCurrency(1234.5, 'MAD', 'fr-MA'), '1.234,50\u00a0DH');
  assert.equal(formatCurrency(12.5, 'MAD', 'fr-MA'), '12,50\u00a0DH');
});

test('formatCurrency: the override does not leak into other currencies', () => {
  assert.equal(formatCurrency(1234.5, 'USD', 'en-US'), '$1,234.50');
  assert.match(formatCurrency(1234.5, 'EUR', 'fr-FR'), /€/);
});

test('formatCurrencyForTenant: a Moroccan store gets DH', () => {
  assert.equal(formatCurrencyForTenant(9.18, 'MA', 'MAD'), '9,18\u00a0DH');
});

test('getCurrencySymbol: MAD is DH, and it fits the receipt column', () => {
  const { getCurrencySymbol } = require('../main/countries');
  assert.equal(getCurrencySymbol('MAD', 'fr-MA'), 'DH');
  // resolveCurrencyPrefix() in printers/thermal.ts pads to a two-character
  // slot; a three-character symbol pushes the amount column over the paper.
  assert.equal(getCurrencySymbol('MAD', 'fr-MA').length, 2);
});

test('the printed receipt keeps the amount readable', () => {
  // The non-breaking space is not ASCII, and the receipt encoder drops
  // characters an ESC/POS printer cannot draw. It must fold to a plain space
  // rather than be lost, or "9,18DH" runs together on every total.
  const { foldToPrinterAscii } = require('../main/printers/thermal');
  const folded = foldToPrinterAscii(formatCurrency(9.18, 'MAD', 'fr-MA'));
  assert.equal(folded.text, '9,18 DH');
  assert.equal(folded.lost, false, 'and it raises no "unsupported character" warning');
});
