import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Bonjour } from 'bonjour-service';
import { initDatabase, closeDatabase, SchemaVersionMismatchError } from './db';
import { startServer, stopServer, getLocalIP, isServerRunning } from './server';
import { cloudSync } from './services/cloud-sync';
import { startBackupSchedule } from './services/backup-schedule';
import { telemetry, sendEvent as sendTelemetryEvent } from './services/telemetry';
import { googleDrive } from './services/google-drive';
import { startKdsServer, stopKdsServer, getKdsPort, isKdsServerRunning } from './kds-server';
import { initPrinter, printReceipt, printKOT } from './printers/thermal';
import { registerIpcHandlers } from './ipc';
import { initFromDb as initWhatsAppFromDb, shutdown as shutdownWhatsApp } from './services/whatsapp';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { isAllowedLocalWindowUrl, isSafeExternalUrl } from './security/url-allowlist';
import {
  isPrivateLanUrl,
  normaliseTillUrl,
  readStationConfig,
  scaleStationUrl,
  writeStationConfig,
  type StationConfig,
} from './station-role';

// ── GPU compatibility ────────────────────────────────────────────────────────
// On Windows, some systems hit "GPU process exited unexpectedly" (exit code
// 0xC0000135 = STATUS_DLL_NOT_FOUND) because the GPU sandbox can't find
// required DLLs (outdated drivers, missing Vulkan, etc.).  Disabling the GPU
// sandbox lets the renderer fall back to software/Skia rendering which is
// slower but reliable.  This is a no-op on macOS/Linux.
//
// Trade-off: this removes Chromium's GPU isolation for ALL Windows users,
// not just those with the DLL crash.  For a local desktop POS app the attack
// surface is already large (server binds 0.0.0.0), so the practical risk is
// low.  A conditional approach (detect crash, store flag, re-launch with
// sandbox disabled) adds complexity for minimal security gain here.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// Mac App Store builds: Electron sets process.mas = true inside the MAS sandbox.
// MAS_BUILD=1 is the build-time fallback (dev/CI).
const isMasBuild =
  process.env.MAS_BUILD === '1' ||
  (process as NodeJS.Process & { mas?: boolean }).mas === true;

// Microsoft Store (MSIX) builds: Electron has no process.msix equivalent.
// MSIX apps are always installed under C:\Program Files\WindowsApps\ so
// checking the executable path is the most reliable runtime detection.
const isMsixBuild =
  process.platform === 'win32' &&
  process.execPath.toLowerCase().includes('windowsapps');

// Either store build: skip third-party auto-updater entirely.
const isStoreBuild = isMasBuild || isMsixBuild;

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
const logPath = log.transports.file.getFile().path.replace(/[^\/\\]+$/, '');
console.log('[Log] Log files location:', logPath);

let updateAvailable = false;
let updateDownloaded = false;

function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  // Downloading is harmless and lets the user see a ready-to-install build,
  // but installation must always be an explicit action. A POS may be closed
  // while a payment, printer job, or end-of-day workflow is still in flight.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Update] Checking for updates...');
    mainWindow?.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    // autoDownload is true, so electron-updater starts downloading right after
    // this fires on its own — no dialog, no manual download-update call needed.
    console.log('[Update] Update available, downloading silently:', info.version);
    updateAvailable = true;
    mainWindow?.webContents.send('update-status', {
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Update] No updates available');
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Update] Download progress: ${progress.percent.toFixed(1)}%`);
    mainWindow?.webContents.send('update-status', { 
      status: 'downloading',
      percent: progress.percent 
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // The renderer's update badge shows a "Restart Now" prompt. Because
    // autoInstallOnAppQuit is disabled, only that explicit action installs it.
    console.log('[Update] Download complete:', info.version);
    updateDownloaded = true;
    mainWindow?.webContents.send('update-status', {
      status: 'ready-to-install',
      version: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    // 404 means no release artifacts published yet — treat as "up to date", not an error.
    // ENOENT means app-update.yml is missing (e.g. running from unpacked dir) — also not an error.
    const isNonError =
      err.message?.includes('404') ||
      err.message?.includes('Cannot find latest') ||
      err.message?.includes('ENOENT');
    if (isNonError) {
      log.debug('[Update] Skipping update — no config or release artifacts:', err.message);
      mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
    } else {
      log.error('[Update] Error:', err);
      mainWindow?.webContents.send('update-status', { status: 'error', error: err.message });
    }
  });
}

function checkForUpdates(): void {
  // Linux: only AppImage supports self-update via electron-updater (it sets
  // the APPIMAGE env var at launch). deb/rpm/snap are managed by their
  // package manager / the snap daemon instead — electron-updater can't
  // update those, so tell the renderer and stop instead of letting
  // "Check for Updates" sit there doing nothing forever when clicked.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    mainWindow?.webContents.send('update-status', { status: 'linux-managed' });
    return;
  }

  if (isStoreBuild) {
    log.debug('[Update] Store build — updates handled by the platform store');
    mainWindow?.webContents.send('update-status', { status: 'store' });
    return;
  }

  // Unpacked dev builds (electron-builder --dir) don't ship app-update.yml.
  // app.isPackaged can still be true for unpacked builds, so check for the
  // file directly — if it's missing, skip the update check gracefully.
  const configPath = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(configPath)) {
    log.debug('[Update] app-update.yml not found at', configPath, '— skipping (unpacked build)');
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
    return;
  }

  if (!isDev) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Update] Check failed:', err);
    });
  } else {
    log.debug('[Update] Skipping update check in dev mode');
    mainWindow?.webContents.send('update-status', { status: 'dev-mode' });
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let isQuitting = false;
let hasCleanedUp = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const PORT = parseInt(process.env.PORT || '3001', 10);

let gotSingleInstanceLock = false;

// ── Single-instance lock ──────────────────────────────────────────────────────
// Prevent multiple instances of the app from running simultaneously.
// This is especially important on Linux where the AppImage can be launched
// multiple times without the OS preventing it.
if (process.platform === 'linux') {
  // Explicitly set app name and userData path to prevent Electron from
  // resolving them inside temporary mount paths (e.g. /tmp/.mount_FloXXXXXX)
  app.name = 'flo-desktop';
  app.setPath('userData', path.join(os.homedir(), '.config', 'flo-desktop'));
}

gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[Lock] Another instance is already running. Quitting.');
  app.quit();
  process.exit(0);
}

if (gotSingleInstanceLock) {
  // Focus the existing window if a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'linux') {
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setAlwaysOnTop(false);
        app.focus();
      }
    }
  });
}

/**
 * Ask this machine what it is, and don't proceed until it answers.
 *
 * Shown once per installation. Resolves with the chosen configuration; if the
 * operator closes the window instead of choosing, the application quits rather
 * than guessing — booting a scale station as a till would create a second,
 * empty database and split the shop's sales in two.
 */
function askForStationRole(): Promise<StationConfig | null> {
  return new Promise((resolve) => {
    let answered: StationConfig | null = null;

    const setupWindow = new BrowserWindow({
      width: 760,
      height: 620,
      resizable: false,
      title: 'Flo',
      webPreferences: {
        preload: path.join(__dirname, 'station-setup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    ipcMain.handle('station-discover-tills', async () => discoverTillsOnLan());

    ipcMain.handle('station-save-role', async (_event, raw: { role?: string; tillUrl?: string }) => {
      if (raw?.role === 'till') {
        answered = { role: 'till' };
      } else if (raw?.role === 'scale') {
        const url = normaliseTillUrl(String(raw.tillUrl ?? ''));
        if (!url) {
          return { ok: false, error: "Cette adresse n'est pas valide, ou n'est pas sur le réseau local." };
        }
        // Confirm something is actually answering before committing: an
        // operator who mistypes one digit would otherwise end up with a
        // permanently blank window and no idea why.
        const reachable = await isTillReachable(url);
        if (!reachable) {
          return { ok: false, error: "Aucune caisse ne répond à cette adresse. Vérifiez qu'elle est allumée et sur le même réseau." };
        }
        answered = { role: 'scale', tillUrl: url };
      } else {
        return { ok: false, error: 'Choisissez le rôle de ce poste.' };
      }

      try {
        writeStationConfig(app.getPath('userData'), answered);
      } catch (err: any) {
        answered = null;
        return { ok: false, error: `Enregistrement impossible : ${err?.message ?? err}` };
      }
      setupWindow.close();
      return { ok: true };
    });

    setupWindow.on('closed', () => {
      ipcMain.removeHandler('station-discover-tills');
      ipcMain.removeHandler('station-save-role');
      resolve(answered);
    });

    setupWindow.loadFile(path.join(__dirname, 'station-setup.html'));
  });
}

/** Tills advertising themselves over mDNS, as origins the operator can pick. */
function discoverTillsOnLan(): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    let scanner: InstanceType<typeof Bonjour> | null = null;
    let browser: { stop: () => void } | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { browser?.stop(); } catch { /* already stopped */ }
      // Destroy the scanner too, not just the browser: leaving it open holds a
      // multicast socket for the life of the process.
      try { scanner?.destroy(); } catch { /* already gone */ }
      resolve([...found]);
    };

    try {
      scanner = new Bonjour();
      browser = scanner.find({ type: 'http' }, (service: any) => {
        // A shop LAN is full of http advertisements — printers, routers, the
        // ISP box. Only tills answer to this name, which is what the till
        // publishes in startMdns().
        const name = String(service?.name ?? '');
        if (!/flo/i.test(name)) return;
        const port = service?.port ?? PORT;
        for (const address of [...(service?.addresses ?? []), service?.host].filter(Boolean)) {
          const host = String(address).replace(/\.$/, '');
          const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
          if (isPrivateLanUrl(url)) found.add(url);
        }
      }) as unknown as { stop: () => void };
    } catch (err) {
      console.warn('[Station] mDNS discovery unavailable:', err);
      finish();
      return;
    }

    // Bounded: the operator is standing in front of the machine waiting, and
    // can always type the address by hand.
    setTimeout(finish, 3000);
  });
}

/** Whether a till is answering at this origin. */
async function isTillReachable(origin: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${origin}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The scale station window: the same application, loaded from the till.
 *
 * No database and no server are started on this machine — it is a client of
 * the till, which is what keeps one catalogue and one set of prices.
 */
function createScaleStationWindow(tillUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Flo — Poste balance',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Navigation is pinned to the till's own origin: a compromised or mistyped
  // page must not be able to walk this window somewhere else.
  const tillOrigin = new URL(tillUrl).origin;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== tillOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(scaleStationUrl(tillUrl)).catch((err) => {
    console.error('[Station] Could not reach the till:', err);
  });

  mainWindow.webContents.on('did-fail-load', (_e, _code, description) => {
    // The till being switched off mid-shift is the ordinary case, so it gets a
    // readable page with a retry rather than Chromium's error screen.
    const message = String(description || 'connexion impossible').replace(/"/g, '');
    mainWindow?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <html lang="fr"><head><meta charset="utf-8"><title>Flo</title></head>
      <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#005A9E;color:#fff;
                   display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
        <div style="max-width:520px;padding:24px">
          <h1 style="font-size:24px;margin:0 0 10px">La caisse ne répond pas</h1>
          <p style="opacity:.85;line-height:1.55;margin:0 0 18px">
            Le poste balance n'arrive pas à joindre <b>${tillOrigin}</b>.<br>
            Vérifiez que la caisse est allumée et sur le même réseau.
          </p>
          <p style="opacity:.6;font-size:13px">${message}</p>
          <button onclick="location.href='${scaleStationUrl(tillUrl)}'"
                  style="margin-top:18px;padding:12px 22px;border:0;border-radius:10px;
                         background:#fff;color:#005A9E;font-size:15px;font-weight:600;cursor:pointer">
            Réessayer
          </button>
        </div>
      </body></html>`));
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Flo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Always load from the embedded Express server (serves static Next.js export).
  // This avoids file:// protocol issues and keeps dev/prod behaviour identical.
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Allow target="_blank" links to open new windows for local URLs (e.g. the KDS page).
  // External URLs are sent to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isLocal = isAllowedLocalWindowUrl(url, PORT, getLocalIP());
    if (isLocal) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 800,
          title: 'Flo - Kitchen Display',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => console.warn('[Flo] Failed to open external URL:', err?.message || err));
    } else {
      console.warn('[Flo] Blocked unsafe external URL scheme:', url);
    }
    return { action: 'deny' };
  });

  // Intercept all renderer downloads and show a save dialog instead of
  // auto-saving to Downloads — required for MAS sandbox compliance.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
    });
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('[Window] Renderer process gone:', details.reason);
    console.error('[Window] Renderer process gone:', details.reason);
    
    if (details.reason !== 'clean-exit') {
      dialog.showMessageBox({
        type: 'error',
        title: 'App Crashed',
        message: 'The app crashed and will restart.',
        detail: `Reason: ${details.reason}`,
        buttons: ['OK'],
      }).then(() => {
        mainWindow?.destroy();
        mainWindow = null;
        createWindow();
      });
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log.error('[Window] Failed to load:', errorCode, errorDescription);
    console.error('[Window] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Window] Window became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[Window] Window became responsive again');
  });
}

function createTray(): void {
  if (process.platform === 'linux') {
    // ── Linux system tray ────────────────────────────────────────────────────
    // On Linux the window close button hides the window (same as other
    // platforms), but there is no native macOS-style dock or Windows taskbar
    // integration to bring it back. A system-tray icon gives Linux users a
    // persistent, discoverable way to show the window or fully quit the app
    // (which triggers the existing quit handler that tears down DB, servers,
    // mDNS, etc.).
    const linuxIconPath = isDev
      ? path.join(__dirname, '../../assets/icon-512.png')
      : path.join(process.resourcesPath, 'assets/icon-512.png');

    try {
      const linuxIcon = nativeImage.createFromPath(linuxIconPath);
      tray = new Tray(linuxIcon.resize({ width: 22, height: 22 }));

      const linuxMenu = Menu.buildFromTemplate([
        {
          label: 'Show',
          click: () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            isQuitting = true;
            // On Debian/AppIndicator, quitting while the context menu is open
            // can cause a deadlock. Defer the teardown so the menu can close.
            setTimeout(() => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.destroy();
              }
              // Explicitly destroy tray to release the AppIndicator lock
              if (tray) {
                tray.destroy();
                tray = null;
              }
              app.quit();
              // Fallback: force exit if will-quit does not fire in time
              setTimeout(() => {
                console.log('[Tray] app.quit() hung, forcing exit');
                runCleanup();
                app.exit(0);
              }, 1000);
            }, 100);
          },
        },
      ]);

      tray.setToolTip('Flo Cafe');
      tray.setContextMenu(linuxMenu);
      // Single-click also shows the window on Linux (no double-click standard).
      tray.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });

      console.log('[Tray] Linux tray created');
    } catch {
      console.log('[Tray] Linux icon not found, skipping tray');
    }
    return;
  }

  // ── macOS / Windows tray ─────────────────────────────────────────────────
  const iconPath = isDev
    ? path.join(__dirname, '../../assets/icon.png')
    : path.join(process.resourcesPath, 'assets/icon.png');

  try {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open Flo', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);

    tray.setToolTip('Flo');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow?.show());
  } catch {
    console.log('[Tray] Icon not found, skipping tray');
  }
}

function startMdns(): void {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: 'Flo',
      type: 'http',
      port: PORT,
      host: 'flo',   // resolves as flo.local on the LAN
      txt: { version: app.getVersion(), kds: `/kds`, kds_port: String(getKdsPort()) },
    });
    const ip = getLocalIP();
    console.log(`[mDNS] Advertising flo.local:${PORT}  (IP fallback: http://${ip}:${PORT})`);
    console.log(`[mDNS] KDS available at http://flo.local:${getKdsPort()}  (IP fallback: http://${ip}:${getKdsPort()})`);
  } catch (err) {
    console.warn('[mDNS] Could not start Bonjour:', err);
  }
}

function stopMdns(): void {
  if (bonjour) {
    bonjour.unpublishAll(() => bonjour?.destroy());
    bonjour = null;
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.getName(),
      submenu: [
        { label: `About ${app.getName()}`, click: () => showAbout() },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Order', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('new-order') },
        { label: 'Quick Search', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('quick-search') },
        { type: 'separator' },
        { label: 'Backup Database', click: () => mainWindow?.webContents.send('backup-database') },
        { label: 'Restore Backup', click: () => mainWindow?.webContents.send('restore-backup') },
        { type: 'separator' },
        { label: 'Database Health Check', click: () => mainWindow?.webContents.send('menu-db-health-check') },
        { label: 'Initialize Database', click: () => mainWindow?.webContents.send('menu-db-initialize') },
        { label: 'Master PIN…', click: () => mainWindow?.webContents.send('menu-master-pin') },
        { type: 'separator' },
        { label: 'Exit', accelerator: process.platform === 'darwin' ? undefined : 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ],
    },
    {
      label: 'Orders',
      submenu: [
        { label: 'View All Orders', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('view-orders') },
      ],
    },
    {
      label: 'Reports',
      submenu: [
        { label: 'Daily Summary', click: () => mainWindow?.webContents.send('report-daily') },
        { label: 'Sales Report', click: () => mainWindow?.webContents.send('report-sales') },
        { label: 'X Report', click: () => mainWindow?.webContents.send('report-x') },
        { label: 'Z Report', click: () => mainWindow?.webContents.send('report-z') },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Business Settings', click: () => mainWindow?.webContents.send('settings-business') },
        { label: 'Tax Settings', click: () => mainWindow?.webContents.send('settings-tax') },
        { label: 'Printer Setup', click: () => mainWindow?.webContents.send('settings-printer') },
        { label: 'Kitchen Stations', click: () => mainWindow?.webContents.send('settings-kitchen') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Flo Cafe', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { role: 'minimize' },
        ...(process.platform === 'darwin' ? [
          { role: 'zoom' as const },
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...(process.platform !== 'darwin' ? [{ label: 'About Flo', click: () => showAbout() }] : []),
        ...(isStoreBuild
          ? []
          : [{ label: 'Check for Updates', click: () => checkForUpdates() }]),
        { label: 'Open Logs Folder', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
      ],
    },
  ];

  if (isDev) {
    template.push({
      label: 'Developer',
      submenu: [
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function showAbout(): void {
  const ip = getLocalIP();
  const kdsPort = getKdsPort();
  dialog.showMessageBox({
    type: 'info',
    title: 'About Flo',
    message: 'Flo Desktop',
    detail: [
      `Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      '',
      'A self-hosted, offline-first Point of Sale system.',
      'Your data stays yours.',
      '',
      `POS URL: http://flo.local:${PORT}`,
      `KDS URL: http://flo.local:${kdsPort}`,
      '',
      `KDS IP fallback: http://${ip}:${kdsPort}`,
    ].join('\n'),
  });
}

async function initialize(): Promise<void> {
  try {
    console.log('[Flo] Initializing...');

    // What this machine is decides almost everything below. A scale station
    // starts no database, no server and no background services: it is a client
    // of the till, which is what keeps one catalogue and one set of prices
    // across the shop.
    let station = readStationConfig(app.getPath('userData'));
    if (!station) {
      console.log('[Flo] No station role set — asking.');
      station = await askForStationRole();
      if (!station) {
        console.log('[Flo] No role chosen; quitting rather than guessing.');
        isQuitting = true;
        app.quit();
        return;
      }
    }
    console.log(`[Flo] Station role: ${station.role}`);

    if (station.role === 'scale') {
      createScaleStationWindow(station.tillUrl!);
      createTray();
      createMenu();
      return;
    }

    console.log('[Flo] Initializing database...');
    initDatabase();

    console.log('[Flo] Starting local server...');
    await startServer();

    cloudSync.start();
    telemetry.start();
    googleDrive.start();
    startBackupSchedule();

    console.log('[Flo] Starting KDS server on port 3002...');
    await startKdsServer();

    console.log('[Flo] Initializing WhatsApp service...');
    initWhatsAppFromDb();

    console.log('[Flo] Starting mDNS advertisement...');
    startMdns();

    console.log('[Flo] Initializing printer...');
    await initPrinter();

    console.log('[Flo] Registering IPC handlers...');
    registerIpcHandlers();

    ipcMain.handle('get-update-status', () => ({
      status: updateDownloaded ? 'ready-to-install' as const
        : updateAvailable ? 'available' as const
        : 'up-to-date' as const,
      info: { version: app.getVersion() },
    }));

    ipcMain.handle('check-for-updates', () => {
      checkForUpdates();
    });

    ipcMain.handle('restart-and-install', () => {
      if (!updateDownloaded) {
        log.warn('[Update] Ignoring install request before an update is downloaded');
        return;
      }
      isQuitting = true;
      autoUpdater.quitAndInstall();
    });

    ipcMain.handle('get-status', () => {
      const mem = process.memoryUsage();
      return {
        server: isServerRunning() ? 'running' : 'stopped',
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: process.uptime(),
        port: PORT,
      };
    });

    console.log('[Flo] Creating window...');
    createWindow();
    createTray();
    createMenu();
    // Auto-updater: wired up on every non-store platform, including Linux now
    // (#58) — checkForUpdates() itself decides whether Linux's build format
    // (AppImage vs deb/rpm/snap) actually supports self-update.
    if (!isStoreBuild) {
      setupAutoUpdater();
      setTimeout(() => checkForUpdates(), 5000);
    }

    console.log('[Flo] Ready!');
  } catch (error) {
    console.error('[Flo] Initialization error:', error);
    dialog.showErrorBox('Initialization Error', `Failed to start Flo: ${error}`);

    // Best-effort: report the fatal startup failure so support can see which
    // installs are stuck on a stale build without waiting for a user to
    // describe the error message themselves. Never let this delay/block the
    // actual quit — db may not even be open yet depending on where init failed.
    try {
      const payload: Record<string, unknown> = {
        error_message: String(error instanceof Error ? error.message : error).slice(0, 500),
      };
      if (error instanceof SchemaVersionMismatchError) {
        payload.db_schema_version = error.dbVersion;
        payload.app_schema_version = error.appVersion;
      }
      await sendTelemetryEvent('startup_failed', payload);
    } catch (telemetryError) {
      console.error('[Flo] Failed to report startup error via telemetry:', telemetryError);
    }

    app.quit();
    process.exit(1);
  }
}

app.whenReady().then(initialize);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// --- Cleanup function (idempotent — safe to call from multiple places) ---
function runCleanup(): void {
  if (hasCleanedUp) return;
  hasCleanedUp = true;
  console.log('[Flo] Running cleanup...');

  // Destroy tray to prevent ghost icons on X11/GNOME/KDE
  if (tray) {
    try { tray.destroy(); } catch (e) { console.error('[Flo] tray.destroy error:', e); }
    tray = null;
  }

  // Tear down services — each wrapped so one failure doesn't block others
  try { cloudSync.stop(); } catch (e) { console.error('[Flo] cloudSync.stop error:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[Flo] telemetry.stop error:', e); }
  try { googleDrive.stop(); } catch (e) { console.error('[Flo] googleDrive.stop error:', e); }
  try { shutdownWhatsApp(); } catch (e) { console.error('[Flo] shutdownWhatsApp error:', e); }
  try { stopMdns(); } catch (e) { console.error('[Flo] stopMdns error:', e); }
  try { stopKdsServer(); } catch (e) { console.error('[Flo] stopKdsServer error:', e); }
  try { stopServer(); } catch (e) { console.error('[Flo] stopServer error:', e); }
  try { closeDatabase(); } catch (e) { console.error('[Flo] closeDatabase error:', e); }

  console.log('[Flo] Goodbye!');
}

app.on('before-quit', () => {
  if (isQuitting) return; // guard against re-entry
  isQuitting = true;
});

app.on('will-quit', (event) => {
  // Run cleanup if it hasn't run yet
  if (!hasCleanedUp) {
    try {
      runCleanup();
    } catch (e) {
      console.error('[Flo] Cleanup failed, retrying:', e);
      event.preventDefault(); // delay quit to retry
      setTimeout(() => {
        runCleanup();
        app.exit(0); // force exit after retry
      }, 500);
      return;
    }
  }
  // Force-destroy window to prevent Linux compositor stall
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
});

app.on('quit', () => {
  runCleanup(); // fallback — defense in depth
});

// --- SIGTERM/SIGINT handlers (Linux/Unix — clean shutdown on external signals) ---
process.on('SIGTERM', () => {
  console.log('[Flo] SIGTERM received, cleaning up...');
  runCleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Flo] SIGINT received, cleaning up...');
  runCleanup();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log.error('[Flo] Uncaught exception:', error);
  console.error('[Flo] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[Flo] Unhandled rejection:', reason);
  console.error('[Flo] Unhandled rejection:', reason);
});
