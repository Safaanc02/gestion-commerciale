/**
 * PIN sign-in — the way staff actually get into this till.
 *
 * A shop counter is not a place to type an email address and a password
 * between customers, so setup asks for a PIN and login is a keypad. The user
 * row still carries an email and a password because the rest of the system
 * keys off them, but both are generated and the password is random: it must
 * never become a weaker second way in. That is asserted here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pin-login-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const { initTestDb, createApp, assert, assertEqual, getResults, closeDatabase } = require('./helpers/test-setup');
const { authRoutes } = require('../main/routes/auth');

async function main() {
  console.log('PIN Sign-in');
  console.log('='.repeat(60));

  const db = initTestDb();
  const app = createApp({ '/api/auth': authRoutes });

  // ── Setup with nothing but a PIN ────────────────────────────────────────
  const setup = await request(app).post('/api/auth/setup/initialize').send({
    owner_pin: '4321',
    business_type: 'retail',
    business_name: 'Superette Atlas',
    setup_profile: 'empty',
    service_model: 'qsr',
    terms_accepted: true,
    country: 'MA', currency: 'MAD', timezone: 'Africa/Casablanca', language: 'ar',
  });
  assertEqual(setup.status, 200, 'setup completes with a PIN and no account details');

  const owner = db.prepare(`SELECT name, email, pin_hash, password, role FROM users`).get() as any;
  assertEqual(owner.role, 'owner', 'an owner is created');
  assert(!!owner.pin_hash, 'the PIN is stored hashed');
  assert(owner.pin_hash !== '4321', 'the PIN is never stored in clear');
  assert(!!owner.password && owner.password.length > 20, 'a password exists only to satisfy the schema');

  // ── Signing in ──────────────────────────────────────────────────────────
  const ok = await request(app).post('/api/auth/login').send({ pin: '4321' });
  assertEqual(ok.status, 200, 'the right PIN signs in');
  assert(!!ok.body.access_token, 'a token is issued');
  assertEqual(ok.body.user.role, 'owner', 'with the owner role');
  assertEqual(ok.body.tenants[0].business_type, 'retail', 'and the shop is in retail mode');
  assertEqual(ok.body.tenants[0].currency, 'MAD', 'and its currency is the dirham');

  // ── A second PIN holder signs in as themselves ──────────────────────────
  const bcrypt = require('bcryptjs');
  const { now } = require('./helpers/test-setup');
  db.prepare(`
    INSERT INTO users (id, name, email, password, pin_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'cashier', 1, ?, ?)
  `).run('u-cashier', 'Fatima', 'fatima@local', bcrypt.hashSync('unused', 10),
    bcrypt.hashSync('8765', 10), now(), now());

  const cashier = await request(app).post('/api/auth/login').send({ pin: '8765' });
  assertEqual(cashier.status, 200, 'a second PIN holder can sign in');
  assertEqual(cashier.body.user.name, 'Fatima', 'and is identified as themselves');
  assertEqual(cashier.body.user.role, 'cashier', 'with their own role, not the owner\'s');

  // A staff member with no PIN must not be reachable through the keypad.
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'cashier', 1, ?, ?)
  `).run('u-nopin', 'Sans PIN', 'nopin@local', bcrypt.hashSync('x', 10), now(), now());
  const stillFine = await request(app).post('/api/auth/login').send({ pin: '4321' });
  assertEqual(stillFine.status, 200, 'a user without a PIN does not disturb the others');

  const wrong = await request(app).post('/api/auth/login').send({ pin: '0000' });
  assertEqual(wrong.status, 401, 'a wrong PIN is refused');

  const tooShort = await request(app).post('/api/auth/login').send({ pin: '12' });
  assertEqual(tooShort.status, 400, 'a too-short PIN is refused before any comparison is attempted');

  const notDigits = await request(app).post('/api/auth/login').send({ pin: 'abcd' });
  assertEqual(notDigits.status, 400, 'a non-numeric PIN is refused');

  // ── The generated password must not be a second way in ──────────────────
  for (const guess of ['password', 'Password1', '4321', 'admin', '']) {
    const attempt = await request(app).post('/api/auth/login')
      .send({ email: 'proprietaire@local', password: guess });
    assert(attempt.status !== 200, `the generated account does not accept "${guess}"`);
  }

  // The refusals above are counted per IP. After enough of them the address is
  // locked out entirely — which is what makes a 4-digit PIN acceptable on a
  // machine whose server listens on the local network.
  const locked = await request(app).post('/api/auth/login').send({ pin: '4321' });
  assertEqual(locked.status, 429, 'repeated failures lock the address out, even for the correct PIN');

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
