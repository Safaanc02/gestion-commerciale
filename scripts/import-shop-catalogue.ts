/**
 * Replace the catalogue with the shop's own, extracted from its WinDev till.
 *
 *   node tests/run-electron-node-test.cjs scripts/import-shop-catalogue.ts <dossier-extrait>
 *
 * The directory is what `scripts/hfsql-import/extract_hfsql.py` produces:
 * `familles.csv` and `produits.csv`.
 *
 * The demo catalogue seeded from a scraped price list is removed first. It
 * covered 8% of what this shop actually sells and its prices came from other
 * retailers, so keeping both would leave two products per barcode and no way
 * to tell which one the cashier should ring up. Sales history is unaffected:
 * `order_items` stores the product name and price on the line itself.
 */
import * as fs from 'fs';
import * as path from 'path';

const Module = require('module');
const originalLoad = Module._load;
const repoRoot = path.join(__dirname, '..');
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => repoRoot, getVersion: () => 'import' } };
  }
  return originalLoad.apply(this, arguments as never);
};

const { initDatabase, getDatabase, closeDatabase, now, generateShortId } = require('../main/db');

interface Row { [key: string]: string }

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()!.map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])) as Row);
}

/**
 * Families whose name ends in "بالميزان" — "on the scale". The shop's own
 * naming is what says a product is loose goods; there is no separate flag in
 * its database, and this is more reliable than guessing from the product name.
 */
function isWeighedFamily(name: string): boolean {
  return name.includes('بالميزان');
}

const UNCATEGORISED = 'غير مصنف';

function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, 'produits.csv'))) {
    console.error('usage: import-shop-catalogue.ts <dossier contenant produits.csv et familles.csv>');
    process.exit(2);
  }

  const families = parseCsv(fs.readFileSync(path.join(dir, 'familles.csv'), 'utf8'));
  const products = parseCsv(fs.readFileSync(path.join(dir, 'produits.csv'), 'utf8'));

  /**
   * One product per barcode may keep it.
   *
   * 437 codes appear on more than one product in the shop's data — sometimes
   * the same item entered twice, sometimes two unrelated items sharing an
   * internal code. A scan has to resolve to exactly one line, so the others
   * keep the code in `sku`, where it stays searchable but is never scanned.
   * The winner is the one with a price; ties go to the later record, which is
   * the one the shop edited last.
   */
  const byBarcode = new Map<string, number[]>();
  products.forEach((p, i) => {
    const code = (p.barcode || '').trim();
    if (code) byBarcode.set(code, [...(byBarcode.get(code) ?? []), i]);
  });
  const keepsBarcode = new Set<number>();
  let demoted = 0;
  for (const indices of byBarcode.values()) {
    const priced = indices.filter((i) => Number(products[i].price) > 0);
    const winner = (priced.length ? priced : indices)[(priced.length ? priced : indices).length - 1];
    keepsBarcode.add(winner);
    demoted += indices.length - 1;
  }

  initDatabase();
  const db = getDatabase();
  const ts = now();

  const removed = { products: 0, categories: 0 };
  const insertCategory = db.prepare(
    `INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`);
  const insertProduct = db.prepare(
    `INSERT INTO products (id, category_id, name, barcode, sku, price, cost,
       track_inventory, stock_quantity, low_stock_threshold,
       unit_of_measure, quantity_precision, plu_code, max_quantity,
       is_active, sort_order, created_at, updated_at)
     VALUES (@id, @category_id, @name, @barcode, @sku, @price, @cost,
       0, 0, 5, @uom, @precision, NULL, NULL, 1, @sort, @ts, @ts)`);

  const shelves = new Map<string, string>();
  let weighed = 0;

  const run = db.transaction(() => {
    removed.products = db.prepare('DELETE FROM products').run().changes;
    removed.categories = db.prepare('DELETE FROM categories').run().changes;

    const used = new Set(products.map((p) => p.family_id));
    for (const f of families) {
      if (!used.has(f.id)) continue;   // families the shop kept but never filled
      const id = generateShortId('categories');
      insertCategory.run(id, f.nom, 0, ts, ts);
      shelves.set(f.id, id);
    }
    const fallback = generateShortId('categories');
    insertCategory.run(fallback, UNCATEGORISED, 999, ts, ts);

    products.forEach((p, i) => {
      const code = (p.barcode || '').trim();
      const scannable = code && keepsBarcode.has(i);
      const byWeight = isWeighedFamily(p.family || '');
      if (byWeight) weighed++;
      insertProduct.run({
        id: generateShortId('products'),
        category_id: shelves.get(p.family_id) ?? fallback,
        name: p.name || code || '(sans nom)',
        barcode: scannable ? code : null,
        sku: scannable ? null : (code || null),
        price: Number(p.price) || 0,
        cost: Number(p.cost) || 0,
        // Loose goods are keyed in kilos to three decimals — the same
        // precision the scale label carries.
        uom: byWeight ? 'kg' : 'unit',
        precision: byWeight ? 3 : 0,
        sort: i,
        ts,
      });
    });
  });
  run();

  const priced = products.filter((p) => Number(p.price) > 0).length;
  console.log(`\nremplacé : ${removed.products} produits et ${removed.categories} catégories de démonstration`);
  console.log(`(l'historique des ventes est conservé : order_items porte son propre libellé)\n`);
  console.log(`${shelves.size + 1} catégories créées`);
  console.log(`${products.length} produits importés`);
  console.log(`   ${priced} avec un prix de vente, ${products.length - priced} à 0 DH`);
  console.log(`   ${weighed} vendus au poids (kg, 3 décimales)`);
  console.log(`   ${keepsBarcode.size} codes-barres scannables`);
  console.log(`   ${demoted} doublons rétrogradés en référence interne (champ sku)`);
  console.log(`\nStock non importé : la source comptait 3268 valeurs négatives sur 3661.`);

  closeDatabase();
}

main();
