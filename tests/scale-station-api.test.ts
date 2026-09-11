/**
 * Scale station: weigh, label, and then scan that label at the till.
 *
 * The closing assertion is the one that matters most in this whole feature —
 * the label the scale station prints is resolved by the till back to the same
 * product, the same weight and the same amount. Encoding and decoding live in
 * one shared module precisely so those two ends cannot drift apart, and this
 * test is what proves they haven't.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-scale-station-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initTestDb, createApp, assert, assertEqual, getResults, closeDatabase, now } = require('./helpers/test-setup');
const { scaleStationRoutes } = require('../main/routes/scale-station');
const { getJWTSecret } = require('../main/routes/auth');
const { resolveScan } = require('../main/services/scan-resolver');
const { getDatabase } = require('../main/db');
const { buildScaleLabel, scaleLabelBarcode } = require('../main/printers/scale-label');
const { DEFAULT_SCALE_LABEL_FORMAT, isValidEan13 } = require('../main/lib/scale-barcode');

function token(role: string) {
  return { Authorization: `Bearer ${jwt.sign({ userId: `u-${role}`, email: `${role}@t.test`, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

async function main() {
  console.log('Scale Station Tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  const auth = token('cashier');

  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'scale_labels_enabled'`).run();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency_symbol', 'MAD', ?)`).run(now());
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'MA', ?)`).run(now());

  const addProduct = db.prepare(`
    INSERT INTO products (id, name, price, unit_of_measure, quantity_precision, plu_code, max_quantity, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  addProduct.run('lentilles', 'Lentilles vertes', 12.5, 'kg', 3, '02001', null, now(), now());
  addProduct.run('riz', 'Riz basmati', 18, 'kg', 3, '02002', 5, now(), now());
  // Weighed but never given a scale item code: cannot be labelled, so it must
  // not appear on the station at all.
  addProduct.run('semoule', 'Semoule fine', 9, 'kg', 3, null, null, now(), now());
  addProduct.run('thon', 'Thon a l huile', 8.5, 'unit', 0, null, null, now(), now());

  const app = createApp({ '/api/scale-station': scaleStationRoutes });

  // ── The station only offers what it can actually label ──────────────────
  const list = await request(app).get('/api/scale-station/products').set(auth);
  assertEqual(list.status, 200, 'the station lists its products');
  const ids = list.body.products.map((p: any) => p.id).sort();
  assertEqual(JSON.stringify(ids), JSON.stringify(['lentilles', 'riz']),
    'only weighed products carrying a scale item code are offered');

  // ── Computing a label ───────────────────────────────────────────────────
  const preview = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'lentilles', quantity: 0.734, preview: true });
  assertEqual(preview.status, 200, 'a label can be computed');
  assertEqual(preview.body.total, 9.18, '0.734 kg x 12.50 MAD/kg = 9.18 MAD, rounded once');
  assert(isValidEan13(preview.body.barcode), 'the barcode carries a valid EAN-13 check digit');

  // ── Validation ──────────────────────────────────────────────────────────
  const noPlu = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'semoule', quantity: 1, preview: true });
  assertEqual(noPlu.status, 400, 'a product without a scale item code cannot be labelled');

  const countable = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'thon', quantity: 1, preview: true });
  assertEqual(countable.status, 404, 'a countable product is not weighable');

  const tooPrecise = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'lentilles', quantity: 0.73412, preview: true });
  assertEqual(tooPrecise.status, 400, 'a weight finer than the gram is refused');

  const overMax = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'riz', quantity: 7.34, preview: true });
  assertEqual(overMax.status, 400, 'a weight beyond the product ceiling is refused');

  const zero = await request(app).post('/api/scale-station/label').set(auth)
    .send({ product_id: 'lentilles', quantity: 0, preview: true });
  assertEqual(zero.status, 400, 'a zero weight is refused');

  // A weight the 5-digit label field cannot hold must be refused rather than
  // silently wrapping and billing a fraction of the real amount.
  const unencodable = scaleLabelBarcode('02001', 200, 2500, DEFAULT_SCALE_LABEL_FORMAT);
  assertEqual(unencodable, null, '200 kg exceeds the 5-digit gram field and is refused');

  // ── The printable sticker ───────────────────────────────────────────────
  const bytes = buildScaleLabel({
    productName: 'Lentilles vertes',
    quantityKg: 0.734, quantityPrecision: 3,
    pricePerKg: 12.5, total: 9.18,
    currencyPrefix: 'MAD', locale: 'fr-MA', pluCode: '02001',
  }, preview.body.barcode);
  const rendered = bytes.toString('latin1');
  assert(rendered.includes('Lentilles vertes'), 'the sticker names the product');
  assert(rendered.includes('0,734 kg'), 'the sticker shows the weight the customer can check');
  assert(/TOTAL\s+9,18 MAD/.test(rendered), 'the sticker shows the total');
  // GS k 67 — the printer draws the barcode itself, for crisp bars at any size.
  assert(rendered.includes(String.fromCharCode(0x1d, 0x6b, 67)), 'the sticker carries an ESC/POS EAN-13 command');

  const accented = buildScaleLabel({
    productName: 'Blé dur', quantityKg: 1, pricePerKg: 10, total: 10,
    currencyPrefix: 'MAD', locale: 'fr-MA', pluCode: '02001',
  }, preview.body.barcode).toString('latin1');
  assert(accented.includes('Ble dur'), 'an accented product name survives onto the sticker');

  // ── THE LOOP: what the station prints, the till reads back ──────────────
  const printed = preview.body.barcode;
  const outcome = resolveScan(getDatabase(), printed);
  assertEqual(outcome.kind, 'weighed', 'the till recognises the station\'s own label');
  assertEqual(outcome.product.id, 'lentilles', 'it resolves to the product that was weighed');
  assertEqual(outcome.measure.quantity, 0.734, 'it reads back the exact weight that was printed');
  assertEqual(outcome.measure.amount, preview.body.total,
    'and it bills exactly the amount the customer read on the sticker');

  // The same loop across the realistic weight range, so a rounding or padding
  // bug at one end cannot hide behind a single happy example.
  let loopOk = 0;
  for (const grams of [1, 55, 250, 734, 1500, 12345, 99999]) {
    const kg = grams / 1000;
    const label = scaleLabelBarcode('02001', kg, 0, DEFAULT_SCALE_LABEL_FORMAT);
    if (!label) continue;
    const back = resolveScan(getDatabase(), label);
    if (back.kind === 'weighed' && back.measure.quantity === Number(kg.toFixed(3))) loopOk++;
  }
  assertEqual(loopOk, 7, 'every weight from 1 g to 99.999 kg round-trips station -> till');

  closeDatabase();

  const results = getResults();
  console.log('='.repeat(60));
  console.log(`Summary: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
