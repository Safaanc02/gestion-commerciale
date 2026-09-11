/**
 * A scanned barcode that is in no catalogue.
 *
 * The till offers to create the product on the spot and sell it in the same
 * gesture: new stock arrives every week and nobody enters it before selling
 * it. This covers the server half of that — the exact payload the modal sends,
 * who is allowed to send it, and the fact that the code resolves afterwards.
 * A create that succeeded but left the barcode unscannable would send the
 * cashier round the same loop on the very next customer.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pos-unknown-barcode.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-unknown-barcode-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as never);
};

process.env.JWT_SECRET = 'test-secret-unknown-barcode';

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCashierUser, seedCategory,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');
const { resolveScan } = require('../main/services/scan-resolver');

const SCANNED = '6111999999995';

async function main() {
  console.log('Unknown barcode → create and sell');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-unknown', 'Epicerie');

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  // Nothing matches it yet — the state the cashier is standing in.
  assertEqual(resolveScan(db, SCANNED).kind, 'unknown', 'an unheard-of code resolves to nothing');

  // Exactly what UnknownBarcodeModal posts, field for field.
  const created = await api(baseUrl, '/api/products', {
    method: 'POST',
    headers: authHeader,
    body: {
      name: 'Produit scanne',
      barcode: SCANNED,
      price: 12.5,
      category_id: null,
      is_active: true,
      track_inventory: false,
    },
  });
  assert(created.status === 200 || created.status === 201, `owner may create from the till (got ${created.status} ${JSON.stringify(created.data)})`);

  const product = created.data.product ?? created.data;
  assertEqual(product.barcode, SCANNED, 'the scanned code is stored on the product');
  assertEqual(Number(product.price), 12.5, 'the keyed price is stored');

  // The point of the whole feature: the next scan must resolve.
  const rescan = resolveScan(db, SCANNED);
  assertEqual(rescan.kind, 'product', 'the same code now resolves to a product');
  assertEqual(String(rescan.product?.barcode), SCANNED, 'and it is the product just created');

  // A cashier is refused, which is why the modal says so rather than showing a
  // generic failure they can do nothing about.
  const { authHeader: cashierHeader } = seedCashierUser(db);
  const refused = await api(baseUrl, '/api/products', {
    method: 'POST',
    headers: cashierHeader,
    body: { name: 'Interdit', barcode: '6111999999988', price: 5, is_active: true, track_inventory: false },
  });
  assertEqual(refused.status, 403, 'a cashier cannot add to the catalogue');

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  server.close();
  closeDatabase();
  if (failed > 0) { console.error('FAILED'); process.exit(1); }
  console.log('ALL PASSED');
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
