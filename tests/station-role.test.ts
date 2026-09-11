import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearStationConfig,
  isPrivateLanUrl,
  normaliseTillUrl,
  readStationConfig,
  scaleStationUrl,
  writeStationConfig,
} from '../main/station-role';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flo-station-'));
}

test('isPrivateLanUrl: accepts the addresses a shop LAN actually uses', () => {
  for (const url of [
    'http://192.168.1.12:3001',
    'http://10.0.0.5:3001',
    'http://172.16.4.9:3001',
    'http://172.31.255.1:3001',
    'http://flo.local:3001',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]) {
    assert.equal(isPrivateLanUrl(url), true, `${url} should be allowed`);
  }
});

test('isPrivateLanUrl: refuses anything off the local network', () => {
  // The station loads this origin with the application's own privileges, so a
  // public address must never be reachable — whether mistyped or suggested.
  for (const url of [
    'http://8.8.8.8:3001',
    'http://example.com:3001',
    'http://172.32.0.1:3001',   // just outside 172.16/12
    'http://192.169.1.1:3001',  // just outside 192.168/16
    'http://11.0.0.1:3001',     // just outside 10/8
    'https://192.168.1.12:3001', // https is not what the till serves
    'http://user:pass@192.168.1.12:3001',
    'ftp://192.168.1.12',
    'not a url',
    '',
  ]) {
    assert.equal(isPrivateLanUrl(url), false, `${url} should be refused`);
  }
});

test('isPrivateLanUrl: rejects malformed IPv4 octets', () => {
  assert.equal(isPrivateLanUrl('http://192.168.1.999:3001'), false);
  assert.equal(isPrivateLanUrl('http://10.300.0.1:3001'), false);
});

test('normaliseTillUrl: a shopkeeper types an address, not a URL', () => {
  // What someone actually keys in at the scale station.
  assert.equal(normaliseTillUrl('192.168.1.12'), 'http://192.168.1.12:3001');
  assert.equal(normaliseTillUrl('192.168.1.12:3001'), 'http://192.168.1.12:3001');
  assert.equal(normaliseTillUrl('  http://192.168.1.12:3001/  '), 'http://192.168.1.12:3001');
  assert.equal(normaliseTillUrl('flo.local'), 'http://flo.local:3001');
});

test('normaliseTillUrl: a path is dropped, only the origin is kept', () => {
  assert.equal(normaliseTillUrl('http://192.168.1.12:3001/scale-station'), 'http://192.168.1.12:3001');
});

test('normaliseTillUrl: refuses what isPrivateLanUrl refuses', () => {
  assert.equal(normaliseTillUrl('example.com'), null);
  assert.equal(normaliseTillUrl(''), null);
  assert.equal(normaliseTillUrl('   '), null);
});

test('config: a fresh machine has no role, so the chooser appears', () => {
  const dir = tmpDir();
  assert.equal(readStationConfig(dir), null);
});

test('config: a till round-trips', () => {
  const dir = tmpDir();
  writeStationConfig(dir, { role: 'till' });
  assert.deepEqual(readStationConfig(dir), { role: 'till' });
});

test('config: a scale station round-trips with its till address', () => {
  const dir = tmpDir();
  writeStationConfig(dir, { role: 'scale', tillUrl: 'http://192.168.1.12:3001' });
  assert.deepEqual(readStationConfig(dir), { role: 'scale', tillUrl: 'http://192.168.1.12:3001' });
});

test('config: a scale station without a till address falls back to the chooser', () => {
  // Opening a blank window would leave the operator with no way forward.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'station.json'), JSON.stringify({ role: 'scale' }));
  assert.equal(readStationConfig(dir), null);
});

test('config: a till address that is no longer allowed is not honoured', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'station.json'), JSON.stringify({ role: 'scale', tillUrl: 'http://evil.example.com' }));
  assert.equal(readStationConfig(dir), null, 'a hand-edited config cannot smuggle in a public host');
});

test('config: corrupt or unknown content asks again rather than guessing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'station.json'), '{ not json');
  assert.equal(readStationConfig(dir), null);
  fs.writeFileSync(path.join(dir, 'station.json'), JSON.stringify({ role: 'printer' }));
  assert.equal(readStationConfig(dir), null,
    'defaulting an unknown role to "till" would start writing sales into an empty database');
});

test('config: clearing sends the machine back to the chooser', () => {
  const dir = tmpDir();
  writeStationConfig(dir, { role: 'till' });
  clearStationConfig(dir);
  assert.equal(readStationConfig(dir), null);
  assert.doesNotThrow(() => clearStationConfig(dir), 'clearing twice is not an error');
});

test('scaleStationUrl: lands on the weighing screen, whatever the trailing slash', () => {
  assert.equal(scaleStationUrl('http://192.168.1.12:3001'), 'http://192.168.1.12:3001/scale-station');
  assert.equal(scaleStationUrl('http://192.168.1.12:3001/'), 'http://192.168.1.12:3001/scale-station');
});
