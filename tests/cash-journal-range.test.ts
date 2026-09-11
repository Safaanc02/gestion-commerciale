/**
 * The date range behind the cash journal.
 *
 * A journal that quietly returned the wrong days would be filed and trusted,
 * so the range is checked at both edges and a malformed one is refused rather
 * than ignored — silently returning the whole history would print a hundred
 * pages and look like it worked.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cash-journal-range.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-journal-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as never);
};
process.env.JWT_SECRET = 'test-secret-journal';

const {
  initTestDb, createApp, startServer, seedOwnerUser,
  api, assert, assertEqual, getResults, closeDatabase, getDatabase,
} = require('./helpers/test-setup');
const { billRoutes } = require('../main/routes/bills');

function seedBill(db: any, id: number, number: string, createdAt: string, total: number) {
  db.prepare(`INSERT INTO orders (id, order_number, type, status, subtotal, total, created_at, updated_at)
              VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?)`).run(id, 'ORD-' + number, total, total, createdAt, createdAt);
  db.prepare(`INSERT INTO bills (id, bill_number, order_id, subtotal, tax_amount, discount_amount,
                total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, 0, ?, ?, 0, 'paid', ?, ?, ?)`)
    .run(id, number, id, total, total, total, JSON.stringify([{ method: 'cash', amount: total }]), createdAt, createdAt);
}

async function main() {
  console.log('Cash journal — date range');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  // One sale a day, and one at 23:58 — the edge a shopkeeper would put in the
  // same day and a naive local-time filter would push into the next.
  seedBill(db, 1, '0001', '2026-09-08 10:00:00', 100);
  seedBill(db, 2, '0002', '2026-09-09 10:00:00', 200);
  seedBill(db, 3, '0003', '2026-09-09 23:58:00', 300);
  seedBill(db, 4, '0004', '2026-09-10 10:00:00', 400);

  const app = createApp({ '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  const list = async (query: string) => api(baseUrl, `/api/bills?${query}&per_page=100`, { headers: authHeader });

  const oneDay = await list('from=2026-09-09&to=2026-09-09');
  assertEqual(oneDay.status, 200, 'a single day is accepted');
  const nums = (oneDay.data.bills ?? oneDay.data).map((b: any) => b.bill_number).sort();
  assertEqual(JSON.stringify(nums), JSON.stringify(['0002', '0003']), 'both of that day are returned, including 23:58');

  const range = await list('from=2026-09-08&to=2026-09-09');
  const rangeNums = (range.data.bills ?? range.data).map((b: any) => b.bill_number).sort();
  assertEqual(JSON.stringify(rangeNums), JSON.stringify(['0001', '0002', '0003']), 'a range covers both ends inclusively');

  const single = await list('from=2026-09-10');
  const singleNums = (single.data.bills ?? single.data).map((b: any) => b.bill_number);
  assertEqual(JSON.stringify(singleNums), JSON.stringify(['0004']), 'one bound alone means that day');

  const empty = await list('from=2026-09-01&to=2026-09-02');
  assertEqual((empty.data.bills ?? empty.data).length, 0, 'a period with no sales returns nothing, not everything');

  const bad = await list('from=hier&to=2026-09-09');
  assertEqual(bad.status, 400, 'a malformed date is refused');
  const inverted = await list('from=2026-09-10&to=2026-09-08');
  assertEqual(inverted.status, 400, 'a reversed range is refused');

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  server.close();
  closeDatabase();
  if (failed > 0) { console.error('FAILED'); process.exit(1); }
  console.log('ALL PASSED');
}

main().catch((err) => { console.error('Test crashed:', err); process.exit(1); });
