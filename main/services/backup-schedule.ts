/**
 * Automatic backups, on a clock.
 *
 * Until this existed a backup was taken before a migration or when somebody
 * clicked, and nothing else. A shop that never clicks had no backup at all —
 * so an ordinary disk failure took the catalogue and every sale ever rung up.
 * That is the one failure this software could not recover from.
 *
 * Two destinations, because they answer different accidents. The managed
 * folder on the till's own disk rewinds a bad import or a mistaken deletion,
 * and is instant. A mirror somewhere else — the second PC, a USB stick, an
 * external disk — is the one that survives the disk itself dying, which is the
 * failure that actually ends a business.
 *
 * Every copy is opened and integrity-checked after writing. A backup nobody
 * has read is a guess, and the day it is needed is the wrong day to find out.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createBackup, getBackupDir, getDatabase, now } from '../db';

const DEFAULTS = {
  intervalMinutes: 60,
  keep: 30,
};

let timer: NodeJS.Timeout | null = null;
let running = false;

function setting(key: string, fallback: string): string {
  try {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function record(key: string, value: string): void {
  try {
    getDatabase().prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now());
  } catch {
    // A backup that cannot write its own bookkeeping is still a backup.
  }
}

/**
 * Confirm a written file is a database that opens and reads clean.
 *
 * A truncated copy — the disk filled, the stick was pulled — is the same size
 * on a listing as a good one.
 */
function verify(file: string): boolean {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      return row?.integrity_check === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Keep the newest `keep` files matching our naming, delete the rest. */
function rotate(dir: string, keep: number): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('flo-backup-') && f.endsWith('.db'))
    .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const stale of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, stale.f)); removed++; } catch { /* keep going */ }
  }
  return removed;
}

export async function runScheduledBackup(): Promise<{ ok: boolean; detail: string }> {
  if (running) return { ok: false, detail: 'already running' };
  running = true;
  try {
    const keep = Math.max(1, Number(setting('backup_keep', String(DEFAULTS.keep))) || DEFAULTS.keep);

    const { path: written } = await createBackup();
    if (!verify(written)) {
      // Do not keep a copy that does not open: it would sit in the list
      // looking like protection.
      try { fs.unlinkSync(written); } catch { /* nothing more to do */ }
      record('backup_last_error', 'the copy did not pass its integrity check');
      return { ok: false, detail: 'integrity check failed' };
    }
    rotate(getBackupDir(), keep);

    // The copy that survives the disk. Absent by default: a mirror onto the
    // same disk would be reassuring and useless.
    const mirror = setting('backup_mirror_path', '').trim();
    let mirrored = '';
    if (mirror) {
      try {
        fs.mkdirSync(mirror, { recursive: true });
        const target = path.join(mirror, path.basename(written));
        fs.copyFileSync(written, target);
        if (!verify(target)) throw new Error('mirror copy did not verify');
        rotate(mirror, keep);
        mirrored = target;
        record('backup_last_mirror_at', now());
        record('backup_last_mirror_error', '');
      } catch (err) {
        // A missing USB stick or an unreachable second PC must not lose the
        // local backup that already succeeded — it is recorded and reported,
        // not thrown away.
        record('backup_last_mirror_error', (err as Error).message || 'mirror failed');
      }
    }

    record('backup_last_at', now());
    record('backup_last_error', '');
    return { ok: true, detail: mirrored ? `${written} + ${mirrored}` : written };
  } catch (err) {
    record('backup_last_error', (err as Error).message || 'backup failed');
    return { ok: false, detail: (err as Error).message };
  } finally {
    running = false;
  }
}

export function startBackupSchedule(): void {
  stopBackupSchedule();
  if (setting('backup_auto_enabled', 'true') !== 'true') return;

  const minutes = Math.max(5, Number(setting('backup_interval_minutes', String(DEFAULTS.intervalMinutes))) || DEFAULTS.intervalMinutes);
  timer = setInterval(() => { void runScheduledBackup(); }, minutes * 60_000);
  // Do not hold the process open on quit for a backup that can wait.
  timer.unref?.();
  console.log(`[Backup] automatic backup every ${minutes} min`);
}

export function stopBackupSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
