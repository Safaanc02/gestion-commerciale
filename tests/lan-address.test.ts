/**
 * Which address the till announces to the scale station.
 *
 * The shop wires the two PCs into a switch. If that switch also reaches the
 * internet box, both machines get ordinary DHCP addresses and nothing here is
 * interesting. If it does NOT — two PCs, one switch, no router, which is a
 * perfectly normal way to link a scale station to a till — Windows self-assigns
 * a 169.254.x.x address instead.
 *
 * Before this, such an installation reported 127.0.0.1 as its own address, so
 * Settings showed the operator a URL that can only ever mean "this machine",
 * and the scale station had nothing valid to connect to.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lan-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { pickLanAddresses } = require('../main/server');
const { isPrivateLanUrl } = require('../main/station-role');

let passed = 0;
let failed = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`   ✓ ${label}`); passed++; }
  else { console.log(`   ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failed++; }
}

function withInterfaces(fake: Record<string, any[]>, run: (addresses: string[]) => void) {
  run(pickLanAddresses(fake));
}

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });

console.log('Till LAN address');
console.log('='.repeat(60));

console.log('\n1. Switch wired to the internet box — ordinary DHCP');
withInterfaces({ lo: [v4('127.0.0.1', true)], eth0: [v4('192.168.1.20')] }, (addresses) => {
  assertEqual(addresses[0], '192.168.1.20', 'the routed address is announced');
  assertEqual(addresses, ['192.168.1.20'], 'and it is the only one offered');
});

console.log('\n2. Two PCs and a switch, no router — Windows self-assigns');
withInterfaces({ lo: [v4('127.0.0.1', true)], eth0: [v4('169.254.12.7')] }, (addresses) => {
  assertEqual(addresses[0], '169.254.12.7',
    'the link-local address is announced rather than 127.0.0.1, which the scale station could never reach');
  assertEqual(addresses, ['169.254.12.7'], 'and it is offered in Settings');
  assertEqual(isPrivateLanUrl('http://169.254.12.7:3001'), true,
    'and the scale station is allowed to connect to it');
});

console.log('\n3. Both present — the routed address wins');
withInterfaces({
  lo: [v4('127.0.0.1', true)],
  eth0: [v4('169.254.12.7')],
  wlan0: [v4('192.168.1.20')],
}, (addresses) => {
  assertEqual(addresses[0], '192.168.1.20',
    'a self-assigned address is a fallback, never a preference');
  assertEqual(addresses, ['192.168.1.20'], 'the link-local one is not offered alongside it');
});

console.log('\n4. No network at all');
withInterfaces({ lo: [v4('127.0.0.1', true)] }, (addresses) => {
  assertEqual(addresses[0], '127.0.0.1', 'falls back to loopback');
  assertEqual(addresses, ['127.0.0.1'], 'and says so plainly');
});

console.log('\n' + '='.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
fs.rmSync(testDir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
