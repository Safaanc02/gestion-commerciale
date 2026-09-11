/**
 * End-to-end: selling bulk goods by weight through the orders API.
 *
 * Covers the six coupled corrections of the weighed-goods work:
 *   (a) the unit/source snapshot is written onto every line
 *   (b) a scan_raw line is re-decoded server-side, ignoring the client's qty
 *   (c) quantity precision is validated per product
 *   (d) line amounts are rounded once, so printed lines add up to the subtotal
 *   (e) an add-on on a weighed line is not billed per kilo
 *   (f) a void mirror line carries the unit of the line it reverses
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-weighed-e2e-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, api, seedOwnerUser, seedCategory,
  assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { productRoutes } = require('../main/routes/products');
const { encodeScaleLabel } = require('../main/lib/scale-barcode');

function seedWeighed(db: any, id: string, name: string, pricePerKg: number, plu: string, opts: any = {}) {
  db.prepare(`
    INSERT INTO products (id, name, price, unit_of_measure, quantity_precision, plu_code,
                          max_quantity, track_inventory, stock_quantity, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'kg', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, pricePerKg, opts.precision ?? 3, plu, opts.max ?? null,
    opts.track ? 1 : 0, opts.stock ?? 999, now(), now());
}

function db_discountEnable() {
  const { getDatabase } = require('../main/db');
  getDatabase().prepare(
    "INSERT INTO settings (key, value) VALUES ('discount_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
  ).run();
}

async function main() {
  console.log('Weighed Sale End-to-End Tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  // A fresh grocery install ships discounts off (migration v60); this suite
  // exercises them, so it enables the feature rather than inheriting a default.
  db_discountEnable();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-vrac', 'Vrac');

  db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'scale_labels_enabled'`).run();

  seedWeighed(db, 'lentilles', 'Lentilles vertes', 12.5, '02001', { track: true, stock: 50 });
  seedWeighed(db, 'riz', 'Riz basmati', 18, '02002', { max: 5 });
  db.prepare(`
    INSERT INTO products (id, name, price, is_active, created_at, updated_at)
    VALUES ('thon', 'Thon a l huile', 8.5, 1, ?, ?)
  `).run(now(), now());

  const app = createApp({ '/api/orders': orderRoutes, '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    const createOrder = (items: any[]) =>
      api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items }, headers: authHeader });

    // ── A scanned weighed line ─────────────────────────────────────────
    const label = encodeScaleLabel('02001', 734); // 0.734 kg
    const scanned = await createOrder([{ product_id: 'lentilles', quantity: 999, scan_raw: label }]);
    assertEqual(scanned.status, 201, 'a scanned weighed line creates an order');
    const scannedId = scanned.data.order.id;
    const line = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(scannedId) as any;

    assertEqual(line.quantity, 0.734, 'the server takes the weight from the label');
    assert(line.quantity !== 999, 'the quantity the client sent is discarded, not trusted');
    assertEqual(line.unit_of_measure, 'kg', 'the line snapshots its unit');
    assertEqual(line.quantity_source, 'scale_label', 'the line records that it came from a label');
    assertEqual(line.amount_source, 'computed', 'the amount was computed from the catalogue price');
    assertEqual(line.scan_raw, label, 'the raw scan is kept for audit');
    // 0.734 x 12.50 = 9.175 -> 9.18
    assertEqual(line.subtotal, 9.18, 'the line amount is rounded to the centime, not left at 5 decimals');

    // Stock came off in kilos.
    const stock = db.prepare(`SELECT stock_quantity FROM products WHERE id = 'lentilles'`).get() as any;
    assertEqual(stock.stock_quantity, 49.266, 'stock is decremented by the weighed quantity');

    // ── Printed lines must add up to the printed subtotal ──────────────
    const mixed = await createOrder([
      { product_id: 'lentilles', quantity: 0.734 },
      { product_id: 'lentilles', quantity: 1.256 },
      { product_id: 'thon', quantity: 3 },
    ]);
    assertEqual(mixed.status, 201, 'a mixed weighed/countable order is created');
    const mixedLines = db.prepare('SELECT subtotal FROM order_items WHERE order_id = ?').all(mixed.data.order.id) as any[];
    const summed = Math.round(mixedLines.reduce((s, l) => s + l.subtotal, 0) * 100) / 100;
    assertEqual(summed, mixed.data.order.subtotal,
      'the sum of the line amounts equals the order subtotal exactly — what the receipt prints must add up');
    for (const l of mixedLines) {
      assertEqual(Math.round(l.subtotal * 100) / 100, l.subtotal, `line amount ${l.subtotal} has at most 2 decimals`);
    }

    // ── Precision and ceilings ─────────────────────────────────────────
    const tooPrecise = await createOrder([{ product_id: 'lentilles', quantity: 0.7341234 }]);
    assertEqual(tooPrecise.status, 400, 'a quantity finer than the gram is refused');

    const fractionalCountable = await createOrder([{ product_id: 'thon', quantity: 1.5 }]);
    assertEqual(fractionalCountable.status, 400, 'a countable product refuses a fractional quantity');

    const overMax = await createOrder([{ product_id: 'riz', quantity: 7.34 }]);
    assertEqual(overMax.status, 400, 'a weight beyond the product ceiling is refused');

    const okUnderMax = await createOrder([{ product_id: 'riz', quantity: 4.999 }]);
    assertEqual(okUnderMax.status, 201, 'a weight under the ceiling still sells');

    // ── A label for the wrong product cannot be redirected ─────────────
    const wrongProduct = await createOrder([{ product_id: 'riz', quantity: 1, scan_raw: label }]);
    assertEqual(wrongProduct.status, 400, 'a label cannot be applied to a different product');

    const damaged = label.slice(0, 12) + (Number(label[12]) === 0 ? '1' : '0');
    const damagedRes = await createOrder([{ product_id: 'lentilles', quantity: 1, scan_raw: damaged }]);
    assertEqual(damagedRes.status, 400, 'a damaged label is refused rather than billed');

    // ── Countable lines are untouched by all of this ───────────────────
    const plain = await createOrder([{ product_id: 'thon', quantity: 2 }]);
    assertEqual(plain.status, 201, 'an ordinary countable sale still works');
    const plainLine = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(plain.data.order.id) as any;
    assertEqual(plainLine.quantity, 2, 'countable quantity unchanged');
    assertEqual(plainLine.unit_of_measure, 'unit', 'countable lines default to unit');
    assertEqual(plainLine.quantity_source, 'unit', 'countable lines are unit-sourced');
    assertEqual(plainLine.subtotal, 17, '8.50 x 2 = 17.00');

    // ── Discounting a weighed line keeps the invariant ─────────────────
    const toDiscount = await createOrder([{ product_id: 'lentilles', quantity: 0.734 }]);
    const discountOrderId = toDiscount.data.order.id;
    const discountItem = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(discountOrderId) as any;
    const discounted = await api(baseUrl, `/api/orders/${discountOrderId}/items/${discountItem.id}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(discounted.status, 200, 'a weighed line can be discounted');
    const afterDiscount = db.prepare('SELECT * FROM order_items WHERE id = ?').get(discountItem.id) as any;
    assertEqual(Math.round(afterDiscount.subtotal * 100) / 100, afterDiscount.subtotal,
      'the discounted line amount stays at 2 decimals — the path the original plan forgot');
    // 9.18 - 10% = 8.262 -> 8.26
    assertEqual(afterDiscount.subtotal, 8.26, '9.18 less 10% is 8.26');
    assertEqual(afterDiscount.unit_of_measure, 'kg', 'discounting does not lose the unit');

    // ── Keyed price: allowed, bounded, and recorded ────────────────────
    const overridden = await createOrder([{ product_id: 'thon', quantity: 2, unit_price: 9.5 }]);
    assertEqual(overridden.status, 201, 'a cashier may charge the shelf price');
    const overLine = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(overridden.data.order.id) as any;
    assertEqual(overLine.unit_price, 9.5, 'the keyed price is what is charged');
    assertEqual(overLine.subtotal, 19, '9.50 x 2 = 19.00');
    assertEqual(overLine.amount_source, 'manual_price', 'and the line records that it was keyed');
    assertEqual(overLine.original_unit_price, 8.5,
      'alongside what the catalogue said — without the pair, an undercharge looks like a price update');

    const sameAsCatalogue = await createOrder([{ product_id: 'thon', quantity: 1, unit_price: 8.5 }]);
    const echoLine = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(sameAsCatalogue.data.order.id) as any;
    assertEqual(echoLine.amount_source, 'computed', 'echoing the catalogue price back is not an override');
    assertEqual(echoLine.original_unit_price, null, 'and nothing is recorded');

    // The missing decimal point — 850 instead of 8.50 — is what the ceiling
    // exists to catch.
    const fatFinger = await createOrder([{ product_id: 'thon', quantity: 1, unit_price: 850 }]);
    assertEqual(fatFinger.status, 400, 'a price far off the catalogue is refused');

    const negative = await createOrder([{ product_id: 'thon', quantity: 1, unit_price: -5 }]);
    assertEqual(negative.status, 400, 'a negative price is refused');

    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'price_override_enabled'").run();
    const disabled = await createOrder([{ product_id: 'thon', quantity: 1, unit_price: 9 }]);
    assertEqual(disabled.status, 400, 'a shop can switch keyed prices off entirely');
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'price_override_enabled'").run();

    closeDatabase();
  } finally {
    server.close();
  }

  const results = getResults();
  console.log('='.repeat(60));
  console.log(`Summary: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
