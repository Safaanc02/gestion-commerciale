/**
 * Preload for the first-run "what is this PC?" window.
 *
 * Deliberately separate from the main preload and exposing only two calls: the
 * setup window runs before any role has been chosen, so it must not be able to
 * reach the database, the printers or anything else the application offers.
 */
// `export {}` makes this a module rather than a global script, so its
// top-level bindings don't collide with the main preload's identically-named
// ones. Preloads are loaded independently, so nothing is actually shared.
export {};

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stationSetup', {
  /** Origins of tills advertising themselves on the local network, via mDNS. */
  discoverTills: (): Promise<string[]> => ipcRenderer.invoke('station-discover-tills'),
  /** Persist the choice. Resolves { ok: true } or { ok: false, error }. */
  save: (config: { role: string; tillUrl?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('station-save-role', config),
});
