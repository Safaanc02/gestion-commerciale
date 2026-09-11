/**
 * Products API — measurement fields (unit_of_measure, quantity_precision,
 * plu_code, tare_default, max_quantity) added by migration v58.
 *
 * The regression this exists for above all others: GET /api/products uses an
 * explicit column list (to avoid pulling Base64 image blobs into memory), so a
 * new column that isn't added to it is invisible to the till — every product
 * silently reads back as countable, and weighed selling fails with no error
 * anywhere. That is asserted first.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-weighed-products-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initTestDb, createApp, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { productRoutes } = require('../main/routes/products');
const { getJWTSecret } = require('../main/routes/auth');

function makeToken(id: string, role: string, email: string) {
  return { Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

async function main() {
  console.log('Weighed Products API Tests');
  console.log('='.repeat(60));

  initTestDb();
  const auth = makeToken('owner-weighed-001', 'owner', 'owner@weighed.test');
  const app = createApp({ '/api/products': productRoutes });

  const post = (body: any) => request(app).post('/api/products').set(auth).send(body);
  const put = (id: string, body: any) => request(app).put(`/api/products/${id}`).set(auth).send(body);

  // ── Creating a weighed product ─────────────────────────────────────────
  const created = await post({
    name: 'Lentilles vertes vrac', price: 12.5,
    unit_of_measure: 'kg', quantity_precision: 3, plu_code: '02001', max_quantity: 25,
  });
  assertEqual(created.status, 201, 'a weighed product is created');
  assertEqual(created.body.product.unit_of_measure, 'kg', 'unit_of_measure is stored');
  assertEqual(created.body.product.quantity_precision, 3, 'quantity_precision is stored');
  assertEqual(created.body.product.plu_code, '02001', 'plu_code is stored');
  assertEqual(created.body.product.max_quantity, 25, 'max_quantity is stored');
  const lentilsId = created.body.product.id;

  // ── THE regression: the list endpoint must expose the new columns ───────
  const list = await request(app).get('/api/products').set(auth);
  assertEqual(list.status, 200, 'product list responds');
  const listed = list.body.products.find((p: any) => p.id === lentilsId);
  assert(!!listed, 'the weighed product appears in the list');
  assertEqual(listed.unit_of_measure, 'kg',
    'GET /products exposes unit_of_measure — omitting it from the explicit column list breaks weighed selling silently');
  assertEqual(listed.quantity_precision, 3, 'GET /products exposes quantity_precision');
  assertEqual(listed.plu_code, '02001', 'GET /products exposes plu_code');
  assertEqual(listed.max_quantity, 25, 'GET /products exposes max_quantity');
  assert('tare_default' in listed, 'GET /products exposes tare_default');

  // ── Defaults keep ordinary products countable ──────────────────────────
  const packaged = await post({ name: 'Thon a l huile', price: 8.5, barcode: '6111234567892' });
  assertEqual(packaged.status, 201, 'an ordinary product is created without measurement fields');
  assertEqual(packaged.body.product.unit_of_measure, 'unit', 'it defaults to countable');
  assertEqual(packaged.body.product.quantity_precision, 0, 'a countable product has no decimals');
  assertEqual(packaged.body.product.plu_code, null, 'a countable product has no scale item code');

  // ── Scale item code uniqueness ─────────────────────────────────────────
  const dup = await post({ name: 'Riz vrac', price: 18, unit_of_measure: 'kg', plu_code: '02001' });
  assertEqual(dup.status, 400, 'a duplicate scale item code is refused');
  assertEqual(dup.body.error, 'Another product already uses this scale item code', 'with an actionable message');

  // Reusing a code freed by a soft-deleted product must still work — the v58
  // index is partial on deleted_at for exactly this reason.
  await request(app).delete(`/api/products/${lentilsId}`).set(auth);
  const reuse = await post({ name: 'Lentilles corail', price: 14, unit_of_measure: 'kg', plu_code: '02001' });
  assertEqual(reuse.status, 201, 'a scale item code freed by deletion can be reused');
  const corailId = reuse.body.product.id;

  // ── Validation ─────────────────────────────────────────────────────────
  const badUom = await post({ name: 'X', price: 1, unit_of_measure: 'grammes' });
  assertEqual(badUom.status, 400, 'an unknown unit is refused');

  const pluOnCountable = await post({ name: 'Y', price: 1, unit_of_measure: 'unit', plu_code: '02009' });
  assertEqual(pluOnCountable.status, 400, 'a countable product cannot carry a scale item code');

  const shortPlu = await post({ name: 'Z', price: 1, unit_of_measure: 'kg', plu_code: '201' });
  assertEqual(shortPlu.status, 400, 'a scale item code of the wrong width is refused');

  const badPrecision = await post({ name: 'W', price: 1, unit_of_measure: 'kg', quantity_precision: 5 });
  assertEqual(badPrecision.status, 400, 'a precision finer than the label can carry is refused');

  const negativeMax = await post({ name: 'V', price: 1, unit_of_measure: 'kg', max_quantity: -2 });
  assertEqual(negativeMax.status, 400, 'a negative ceiling is refused');

  // ── The group is resolved together, not field by field ─────────────────
  // Switching a product to 'kg' without also sending quantity_precision must
  // not leave it at 0, or every weighing would round to a whole kilo.
  const switched = await put(packaged.body.product.id, { unit_of_measure: 'kg' });
  assertEqual(switched.status, 200, 'a countable product can be switched to weighed');
  assertEqual(switched.body.product.unit_of_measure, 'kg', 'the switch applies');
  assertEqual(switched.body.product.quantity_precision, 3,
    'switching to kg without sending a precision defaults to the gram, never 0');

  // And back: switching to countable clears what no longer applies.
  const back = await put(corailId, { unit_of_measure: 'unit' });
  assertEqual(back.status, 200, 'a weighed product can be switched back to countable');
  assertEqual(back.body.product.quantity_precision, 0, 'precision is reset to whole numbers');
  assertEqual(back.body.product.plu_code, null, 'the scale item code is cleared');

  // ── A partial update leaves the group alone ────────────────────────────
  const priced = await put(switched.body.product.id, { price: 9.9 });
  assertEqual(priced.status, 200, 'a price-only update succeeds');
  assertEqual(priced.body.product.price, 9.9, 'the price changed');
  assertEqual(priced.body.product.unit_of_measure, 'kg', 'a price-only update does not reset the unit');
  assertEqual(priced.body.product.quantity_precision, 3, 'a price-only update does not reset the precision');

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
