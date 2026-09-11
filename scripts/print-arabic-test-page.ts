/**
 * Print the Arabic code-page test page on the configured receipt printer.
 *
 *   node tests/run-electron-node-test.cjs scripts/print-arabic-test-page.ts
 *
 * Five settings, the same two product names under each, labelled A to E. Read
 * the label of the line that came out right and set it in the database:
 *
 *   printer_arabic_codepage    cp864 | cp1256
 *   printer_arabic_charset_id  the number after the slash
 */
import * as path from 'path';

const Module = require('module');
const originalLoad = Module._load;
const repoRoot = path.join(__dirname, '..');
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => repoRoot, getVersion: () => 'test-page' } };
  }
  return originalLoad.apply(this, arguments as never);
};

const { initDatabase, closeDatabase } = require('../main/db');
const { printArabicTestPage } = require('../main/printers/thermal');

async function main() {
  initDatabase();
  const result = await printArabicTestPage();
  if (result.ok) {
    console.log('Page de test envoyée. Regarde le ticket et note la lettre de la ligne lisible.');
  } else {
    console.error('Échec :', result.detail);
    process.exitCode = 1;
  }
  closeDatabase();
}

main();
