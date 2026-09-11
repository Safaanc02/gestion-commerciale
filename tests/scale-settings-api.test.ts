/**
 * Scale settings API — GET/PUT /api/settings/scale and the label preview.
 *
 * Writing goes through a dedicated route rather than the generic
 * PUT /settings/:key, because that handler whitelists the key but never looks
 * at the value: an incoherent layout would be stored happily and then break
 * every scan in the shop. These tests pin that validation down.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-scale-settings-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initTestDb, createApp, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { settingsRoutes } = require('../main/routes/settings');
const { getJWTSecret } = require('../main/routes/auth');
const { DEFAULT_SCALE_LABEL_FORMAT, isValidEan13, decodeScaleLabel } = require('../main/lib/scale-barcode');

function token(role: string) {
  return { Authorization: `Bearer ${jwt.sign({ userId: `u-${role}`, email: `${role}@t.test`, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

async function main() {
  console.log('Scale Settings API Tests');
  console.log('='.repeat(60));

  initTestDb();
  const owner = token('owner');
  const cashier = token('cashier');
  const app = createApp({ '/api/settings': settingsRoutes });

  // ── Reading ────────────────────────────────────────────────────────────
  const initial = await request(app).get('/api/settings/scale').set(owner);
  assertEqual(initial.status, 200, 'the scale settings are readable');
  assertEqual(initial.body.enabled, false,
    'decoding ships disabled — a mis-set layout bills a tenfold weight with a valid check digit');
  assertEqual(initial.body.format.itemCodeLength, DEFAULT_SCALE_LABEL_FORMAT.itemCodeLength, 'the default layout is returned');

  const asCashier = await request(app).get('/api/settings/scale').set(cashier);
  assertEqual(asCashier.status, 200, 'a cashier may read the layout — the till needs it to scan');

  // The named route must win over the /:key wildcard declared later.
  assert(typeof initial.body.format === 'object',
    'GET /settings/scale returns the parsed object, not a raw settings row — the wildcard did not swallow it');

  // ── Writing ────────────────────────────────────────────────────────────
  const cashierWrite = await request(app).put('/api/settings/scale').set(cashier).send({ enabled: true });
  assertEqual(cashierWrite.status, 403, 'a cashier may not change the layout');

  const enable = await request(app).put('/api/settings/scale').set(owner).send({ enabled: true });
  assertEqual(enable.status, 200, 'an owner can enable decoding');
  assertEqual(enable.body.enabled, true, 'the change is echoed back');
  assertEqual((await request(app).get('/api/settings/scale').set(owner)).body.enabled, true, 'and it persists');

  const twoDigit = {
    prefixes: ['20'], itemCodeStart: 2, itemCodeLength: 5,
    valueStart: 7, valueLength: 5, embeds: 'weight', divisor: 1000, verifyCheckDigit: true,
  };
  const changed = await request(app).put('/api/settings/scale').set(owner).send({ format: twoDigit });
  assertEqual(changed.status, 200, 'a valid two-digit-prefix layout is accepted');
  assertEqual(changed.body.format.prefixes[0], '20', 'the new layout is stored');
  assertEqual(changed.body.enabled, true, 'changing the layout alone leaves the enabled flag untouched');

  // ── Refusing layouts that would silently misbill ────────────────────────
  const overflowing = await request(app).put('/api/settings/scale').set(owner)
    .send({ format: { ...DEFAULT_SCALE_LABEL_FORMAT, valueStart: 11, valueLength: 5 } });
  assertEqual(overflowing.status, 400, 'a value field running past the 12 data digits is refused');

  const overlapping = await request(app).put('/api/settings/scale').set(owner)
    .send({ format: { ...DEFAULT_SCALE_LABEL_FORMAT, itemCodeStart: 1, itemCodeLength: 5, valueStart: 3, valueLength: 5 } });
  assertEqual(overlapping.status, 400, 'item and value fields that overlap are refused');

  const zeroLength = await request(app).put('/api/settings/scale').set(owner)
    .send({ format: { ...DEFAULT_SCALE_LABEL_FORMAT, itemCodeLength: 0 } });
  assertEqual(zeroLength.status, 400, 'an empty item field is refused');

  const badEnabled = await request(app).put('/api/settings/scale').set(owner).send({ enabled: 'yes' });
  assertEqual(badEnabled.status, 400, 'enabled must be a boolean');

  // A refused write must leave the previous layout in place.
  const after = await request(app).get('/api/settings/scale').set(owner);
  assertEqual(after.body.format.prefixes[0], '20', 'a rejected layout does not overwrite the working one');

  // ── The preview: the check that stands between the shop and a wrong bill ─
  await request(app).put('/api/settings/scale').set(owner).send({ format: DEFAULT_SCALE_LABEL_FORMAT });
  const preview = await request(app).post('/api/settings/scale/preview').set(owner)
    .send({ item_code: '02001', value: 734 });
  assertEqual(preview.status, 200, 'the preview builds a label');
  assert(isValidEan13(preview.body.barcode), 'the previewed barcode has a valid EAN-13 check digit');
  const decoded = decodeScaleLabel(preview.body.barcode, DEFAULT_SCALE_LABEL_FORMAT);
  assertEqual(decoded.status, 'ok', 'the previewed barcode decodes back');
  assertEqual(decoded.label.itemCode, '02001', 'round trip keeps the item code');
  assertEqual(decoded.label.weightKg, 0.734, 'round trip keeps the weight');

  const badPreview = await request(app).post('/api/settings/scale/preview').set(owner)
    .send({ item_code: '201', value: 734 });
  assertEqual(badPreview.status, 400, 'a preview with a wrong-width item code explains itself');

  const zeroPreview = await request(app).post('/api/settings/scale/preview').set(owner)
    .send({ item_code: '02001', value: 0 });
  assertEqual(zeroPreview.status, 400, 'a preview needs a positive value');

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
