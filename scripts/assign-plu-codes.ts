/**
 * Give every product sold by weight the item number its label carries.
 *
 *   node tests/run-electron-node-test.cjs scripts/assign-plu-codes.ts [--dry-run]
 *
 * The number is ours to choose. Both ends of the chain are this software: the
 * scale station composes the barcode and the till decodes it, so nothing has
 * to match a number programmed into the weighing hardware — that machine only
 * tells the operator what the bag weighs.
 *
 * Without one a product cannot be labelled at all: the station lists only
 * products that have a code, so an unnumbered product is invisible to the
 * person holding the bag.
 */
import * as path from 'path';

const Module = require('module');
const originalLoad = Module._load;
const repoRoot = path.join(__dirname, '..');
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => repoRoot, getVersion: () => 'plu' } };
  }
  return originalLoad.apply(this, arguments as never);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { DEFAULT_SCALE_LABEL_FORMAT } = require('../main/lib/scale-barcode');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  initDatabase();
  const db = getDatabase();

  const width = DEFAULT_SCALE_LABEL_FORMAT.itemCodeLength as number;
  const taken = new Set<string>(
    db.prepare(`SELECT plu_code FROM products WHERE plu_code IS NOT NULL AND plu_code != ''`)
      .all().map((r: { plu_code: string }) => r.plu_code),
  );

  const missing = db.prepare(`
    SELECT p.id, p.name, p.price, c.name AS category
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.unit_of_measure = 'kg'
      AND (p.plu_code IS NULL OR p.plu_code = '')
      AND p.is_active = 1 AND p.deleted_at IS NULL
    ORDER BY c.name, p.name
  `).all() as { id: string; name: string; price: number; category: string }[];

  if (missing.length === 0) {
    console.log('Tous les produits au poids ont déjà un numéro.');
    closeDatabase();
    return;
  }

  // Start at 2001 and step past anything already used. Leading zeros pad it to
  // the width the label format reserves; 5 digits leaves room for 99 999
  // products, which no grocery will reach.
  let next = 2001;
  const nextFree = (): string => {
    for (;;) {
      const code = String(next++).padStart(width, '0');
      if (!taken.has(code)) { taken.add(code); return code; }
    }
  };

  const assignments = missing.map((p) => ({ ...p, plu: nextFree() }));
  const update = db.prepare(`UPDATE products SET plu_code = ?, updated_at = ? WHERE id = ?`);

  if (!dryRun) {
    const ts = now();
    db.transaction(() => {
      for (const a of assignments) update.run(a.plu, ts, a.id);
    })();
  }

  console.log(`${assignments.length} produits ${dryRun ? 'recevraient' : 'ont reçu'} un numéro\n`);
  for (const a of assignments.slice(0, 10)) {
    console.log(`  ${a.plu}  ${String(a.price).padStart(7)} DH/kg  ${a.name.slice(0, 34)}`);
  }
  if (assignments.length > 10) console.log(`  ... et ${assignments.length - 10} autres`);
  if (dryRun) console.log('\n(--dry-run : rien n\'a été écrit)');

  closeDatabase();
}

main();
