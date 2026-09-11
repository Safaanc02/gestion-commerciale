import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { encodeScaleLabel, DEFAULT_SCALE_LABEL_FORMAT, type ScaleLabelFormat } from '../main/lib/scale-barcode';
import { getScaleConfig, resolveScan, type ScanOutcome } from '../main/services/scan-resolver';

/**
 * scan-resolver takes its database as an argument, so these run against a
 * plain in-memory SQLite rather than the Electron-backed one — the resolution
 * policy is exercised directly, with no app bootstrap in the way.
 */
function makeDb(opts: { enabled?: boolean; format?: ScaleLabelFormat } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      barcode TEXT,
      plu_code TEXT,
      unit_of_measure TEXT NOT NULL DEFAULT 'unit',
      quantity_precision INTEGER NOT NULL DEFAULT 0,
      max_quantity REAL,
      is_active INTEGER DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  set.run('scale_labels_enabled', opts.enabled === false ? 'false' : 'true');
  set.run('scale_label_format', JSON.stringify(opts.format ?? DEFAULT_SCALE_LABEL_FORMAT));

  const add = db.prepare(`
    INSERT INTO products (id, name, price, barcode, plu_code, unit_of_measure, quantity_precision, max_quantity, is_active, deleted_at)
    VALUES (@id, @name, @price, @barcode, @plu_code, @uom, @precision, @max_quantity, @is_active, @deleted_at)
  `);
  const product = (p: Partial<Record<string, unknown>>) =>
    add.run({
      id: 'x', name: 'X', price: 0, barcode: null, plu_code: null,
      uom: 'unit', precision: 0, max_quantity: null, is_active: 1, deleted_at: null, ...p,
    });

  // Packaged goods: a real Moroccan GS1 code (611 prefix).
  product({ id: 'thon', name: 'Thon a l huile', price: 8.5, barcode: '6111234567892' });
  // Bulk goods, weighed at the scale station.
  product({ id: 'lentilles', name: 'Lentilles vertes', price: 12.5, plu_code: '02001', uom: 'kg', precision: 3 });
  product({ id: 'riz', name: 'Riz basmati', price: 18, plu_code: '02002', uom: 'kg', precision: 3, max_quantity: 5 });
  // A PLU wrongly attached to a countable product — a cataloguing mistake that
  // must be caught rather than billed.
  product({ id: 'sachets', name: 'Sachets', price: 1, plu_code: '02003', uom: 'unit' });

  return { db, product };
}

const LENTILS_734G = encodeScaleLabel('02001', 734)!;

test('decoding disabled: a scale label is simply not a known product', () => {
  const { db } = makeDb({ enabled: false });
  const out = resolveScan(db, LENTILS_734G);
  assert.equal(out.kind, 'unknown');
});

test('an ordinary packaged barcode resolves to its product', () => {
  const { db } = makeDb();
  const out = resolveScan(db, '6111234567892');
  assert.equal(out.kind, 'product');
  assert.equal(out.kind === 'product' && out.product.id, 'thon');
});

test('a valid scale label produces a weighed line with the right money', () => {
  const { db } = makeDb();
  const out = resolveScan(db, LENTILS_734G);
  assert.equal(out.kind, 'weighed');
  if (out.kind !== 'weighed') return;
  assert.equal(out.product.id, 'lentilles');
  assert.equal(out.measure.quantity, 0.734);
  assert.equal(out.measure.unit_of_measure, 'kg');
  assert.equal(out.measure.quantity_source, 'scale_label');
  assert.equal(out.measure.amount_source, 'computed');
  // 0.734 kg x 12.50 MAD/kg = 9.175 -> 9.18 MAD
  assert.equal(out.measure.amount, 9.18);
  assert.equal(out.measure.scan_raw, LENTILS_734G);
});

test('a scale label resolves on plu_code, never on barcode', () => {
  const { db } = makeDb();
  // Give another product the literal label digits as its barcode: resolution
  // must still go through plu_code, or every weighing would need its own
  // product row.
  db.prepare(`UPDATE products SET barcode = ? WHERE id = 'thon'`).run(LENTILS_734G);
  const out = resolveScan(db, LENTILS_734G);
  assert.equal(out.kind, 'weighed');
  assert.equal(out.kind === 'weighed' && out.product.id, 'lentilles');
});

test('a 12-digit product barcode starting with 2 stays scannable', () => {
  // THE regression this policy exists for. decodeScaleLabel checks the prefix
  // before the length, so an in-house or UPC-A code beginning with 2 comes
  // back as 'bad-length'. Treating every 'invalid' as fatal would make the
  // product impossible to sell.
  const { db, product } = makeDb();
  product({ id: 'interne', name: 'Pain maison', price: 3, barcode: '202001000734' });
  const out = resolveScan(db, '202001000734');
  assert.equal(out.kind, 'product');
  assert.equal(out.kind === 'product' && out.product.id, 'interne');
});

test('a truncated scale label with no product behind it is refused', () => {
  const { db } = makeDb();
  const out = resolveScan(db, '202001000734');
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'truncated-label');
});

test('a damaged check digit is refused and never falls back to a product', () => {
  const { db, product } = makeDb();
  const damaged = LENTILS_734G.slice(0, 12) + (Number(LENTILS_734G[12]) === 0 ? '1' : '0');
  // Even with a product carrying exactly those digits, a broken check digit
  // must not resolve: billing a misread weight is worse than a re-scan.
  product({ id: 'piege', name: 'Piege', price: 1, barcode: damaged });
  const out = resolveScan(db, damaged);
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'damaged-label');
});

test('an unknown item code is reported as such, not as an unknown barcode', () => {
  const { db } = makeDb();
  const out = resolveScan(db, encodeScaleLabel('09999', 500)!);
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'unknown-plu');
});

test('a PLU pointing at a countable product is caught', () => {
  const { db } = makeDb();
  const out = resolveScan(db, encodeScaleLabel('02003', 734)!);
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'not-sold-by-weight');
});

test('a weight past the product ceiling is refused', () => {
  // Riz caps at 5 kg. A shifted digit turns 0.734 kg into 7.34 kg — exactly
  // the failure the ceiling exists to catch.
  const { db } = makeDb();
  const out = resolveScan(db, encodeScaleLabel('02002', 7340)!);
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'over-max-quantity');
  // The same product just under the ceiling still sells.
  const ok = resolveScan(db, encodeScaleLabel('02002', 4999)!);
  assert.equal(ok.kind, 'weighed');
});

test('a weight rounding to nothing is refused rather than billed as zero', () => {
  const { db, product } = makeDb();
  product({ id: 'gros', name: 'Sac 25kg', price: 200, plu_code: '02010', uom: 'kg', precision: 0 });
  const out = resolveScan(db, encodeScaleLabel('02010', 400)!); // 0.4 kg at precision 0
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'zero-quantity');
});

test('price-embedded labels: the printed amount is authoritative', () => {
  const format: ScaleLabelFormat = { ...DEFAULT_SCALE_LABEL_FORMAT, embeds: 'price', divisor: 100 };
  const { db } = makeDb({ format });
  const out = resolveScan(db, encodeScaleLabel('02001', 734, format)!); // 7.34 MAD
  assert.equal(out.kind, 'weighed');
  if (out.kind !== 'weighed') return;
  assert.equal(out.measure.amount, 7.34, 'the amount is taken from the label, not recomputed');
  assert.equal(out.measure.amount_source, 'label_price');
  // 7.34 / 12.50 = 0.5872 -> 0.587 kg. Deliberately marked as derived: feeding
  // it back through the unit price gives 7.3375, not 7.34.
  assert.equal(out.measure.quantity, 0.587);
  assert.equal(out.measure.quantity_source, 'price_derived');
});

test('inactive and deleted products are not resolved', () => {
  const { db } = makeDb();
  db.prepare(`UPDATE products SET is_active = 0 WHERE id = 'thon'`).run();
  assert.equal(resolveScan(db, '6111234567892').kind, 'unknown');

  db.prepare(`UPDATE products SET deleted_at = '2026-01-01' WHERE id = 'lentilles'`).run();
  const out = resolveScan(db, LENTILS_734G);
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kind === 'rejected' && out.reason, 'unknown-plu');
});

test('non-numeric and empty scans are not errors', () => {
  const { db } = makeDb();
  const cases: ScanOutcome[] = [resolveScan(db, 'ABC-123'), resolveScan(db, ''), resolveScan(db, '   ')];
  for (const out of cases) assert.equal(out.kind, 'unknown');
});

test('getScaleConfig falls back when the settings row is missing or corrupt', () => {
  const { db } = makeDb();
  db.prepare(`DELETE FROM settings`).run();
  const missing = getScaleConfig(db);
  assert.equal(missing.enabled, false, 'absent setting must not silently enable decoding');
  assert.deepEqual(missing.format, DEFAULT_SCALE_LABEL_FORMAT);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('scale_label_format', '{not json')`).run();
  assert.deepEqual(getScaleConfig(db).format, DEFAULT_SCALE_LABEL_FORMAT, 'corrupt JSON falls back');
});

test('a corrupt format does not take the till down: ordinary scanning still works', () => {
  const { db } = makeDb();
  db.prepare(`UPDATE settings SET value = '{"prefixes":["2"],"valueStart":11,"valueLength":5}' WHERE key = 'scale_label_format'`).run();
  // Nonsense layout: a scale label is refused with a format reason...
  const bad = resolveScan(db, LENTILS_734G);
  assert.equal(bad.kind, 'rejected');
  assert.equal(bad.kind === 'rejected' && bad.reason, 'bad-format');
  // ...but packaged goods keep selling.
  assert.equal(resolveScan(db, '6111234567892').kind, 'product');
});
