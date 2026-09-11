/**
 * What this particular PC is: the till, or the scale station.
 *
 * The shop runs two machines. The till holds the database and serves the
 * application; the scale station is a thin client that loads the same
 * application from the till over the local network. That asymmetry is the
 * whole design — one catalogue, one set of prices, one place where a sale is
 * recorded. A scale station with its own database would drift the first time
 * a price changed.
 *
 * The role is stored per machine, in a plain JSON file next to the database,
 * because it is a property of the installation and not of the shop's data:
 * restoring a backup from the till onto the scale station must not turn it
 * into a second till.
 */
import * as fs from 'fs';
import * as path from 'path';

export type StationRole = 'till' | 'scale';

export interface StationConfig {
  role: StationRole;
  /** Origin of the till, e.g. "http://192.168.1.12:3001". Scale stations only. */
  tillUrl?: string;
}

const FILE_NAME = 'station.json';

/**
 * Hostnames and addresses a scale station may be pointed at.
 *
 * Deliberately restricted to the local network. The station loads a remote
 * origin into a window with the app's own privileges, so an operator who
 * mistypes — or is talked into typing — a public address must not be able to
 * hand that context to the internet.
 */
export function isPrivateLanUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // mDNS names, which is how the till advertises itself.
  if (host.endsWith('.local')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, Number(v4[2]), Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // link-local
    if (a === 127) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

/** Strip any path so only the origin is stored, and normalise the shape. */
export function normaliseTillUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.port) parsed.port = '3001';
  const origin = parsed.origin;
  return isPrivateLanUrl(origin) ? origin : null;
}

function configPath(userDataDir: string): string {
  return path.join(userDataDir, FILE_NAME);
}

/**
 * Read this machine's role.
 *
 * Returns null when the machine has not been set up yet, which is what makes
 * the first-run chooser appear. An unreadable or nonsensical file is treated
 * the same way: better to ask again than to boot a scale station as a till and
 * start writing sales into an empty database.
 */
export function readStationConfig(userDataDir: string): StationConfig | null {
  try {
    const raw = fs.readFileSync(configPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw) as StationConfig;
    if (parsed?.role === 'till') return { role: 'till' };
    if (parsed?.role === 'scale') {
      const url = parsed.tillUrl ? normaliseTillUrl(parsed.tillUrl) : null;
      // A scale station without a reachable till address cannot do anything,
      // so it goes back to the chooser rather than opening a blank window.
      return url ? { role: 'scale', tillUrl: url } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStationConfig(userDataDir: string, config: StationConfig): void {
  const payload: StationConfig = config.role === 'scale'
    ? { role: 'scale', tillUrl: config.tillUrl }
    : { role: 'till' };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(configPath(userDataDir), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function clearStationConfig(userDataDir: string): void {
  try {
    fs.unlinkSync(configPath(userDataDir));
  } catch {
    // Already absent — the next boot shows the chooser either way.
  }
}

/** The page a scale station opens on the till. */
export function scaleStationUrl(tillUrl: string): string {
  return `${tillUrl.replace(/\/+$/, '')}/scale-station`;
}
