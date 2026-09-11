/**
 * Load a sample catalogue into a fresh install, so the till can be exercised
 * with real products instead of invented ones.
 *
 *   node tests/run-electron-node-test.cjs scripts/seed-demo-catalogue.ts <catalogue.csv> [count]
 *
 * The CSV is the shop's own scraped catalogue. Only rows that would actually
 * work at a till are taken: a price, a name that survives thermal printing,
 * and a barcode whose EAN-13 check digit is valid. Everything else is counted
 * and reported rather than imported half-broken — a product with no price
 * would ring up at 0 DH, and an unverified barcode is one that never scans.
 *
 * Bulk products (rice, lentils, pasta, flour) are not in that catalogue at all
 * — they have no barcode by nature — so a handful are created here with their
 * scale item codes, which is what makes the weighing chain testable end to end.
 */
import * as fs from 'fs';
import * as path from 'path';

// main/db.ts asks Electron where to put its files. Run outside the app, that
// module isn't there — so it is stubbed to point at the development database
// in the repository root, the same one `npm run dev` opens.
const Module = require('module');
const originalLoad = Module._load;
const repoRoot = path.join(__dirname, '..');
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => repoRoot, getVersion: () => 'seed' } };
  }
  return originalLoad.apply(this, arguments as never);
};

const { initDatabase, getDatabase, closeDatabase, now, generateShortId } = require('../main/db');
const { ean13CheckDigit } = require('../main/lib/scale-barcode');

interface Row { [key: string]: string }

/** Same folding the receipt encoder applies — a name that empties out here would print blank. */
function printableName(name: string): string {
  let out = '';
  for (const char of name) {
    if (char.charCodeAt(0) < 0x80) { out += char; continue; }
    const stripped = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (stripped && /^[\x00-\x7F]+$/.test(stripped)) out += stripped;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isValidEan13(code: string): boolean {
  const c = (code || '').trim();
  if (!/^\d{13}$/.test(c)) return false;
  return ean13CheckDigit(c.slice(0, 12)) === Number(c[12]);
}

/**
 * Shelves, inferred from the product name.
 *
 * The catalogue carries no category at all, and a till whose every product
 * sits in "Uncategorised" is unusable on a touch screen — the cashier finds
 * things by aisle. Order matters: the first match wins, so narrower rules
 * come first.
 */
// No trailing \b: French shelf words are as often plural as singular on a
// label ("Bonbons", "Olives", "Capsules"), and requiring a boundary after the
// stem silently dropped every plural into "Divers".
const SHELVES: Array<{ name: string; test: RegExp }> = [
  { name: 'منتجات الأطفال', test: /\b(bebe|infantile|biberon|pampers|celia|petit pot)/i },
  { name: 'العناية الشخصية', test: /\b(savon|douche|shampo|dentifrice|deodorant|couche|mouchoir|serviette|rasoir|coton|hygien|elseve|elselve|pantene|gel intime|papier toilette)/i },
  { name: 'منتجات التنظيف', test: /\b(nettoyant|vaisselle|lessive|javel|desinfect|ariel|omo|tide|eponge|detergent|assouplis|sac poubelle|insecticide|essuie)/i },
  { name: 'القهوة والشاي', test: /\b(cafe|nespresso|capsule|the\b|infusion|tisane|chicoree|verveine|camomille|menthe sultan|sachets?\b.*(the|infusion))/i },
  { name: 'المشروبات', test: /\b(eau|coca|fanta|sprite|schweppes|hawai|poms|boisson|jus|soda|red bull|monster|limonade|seven up|7up|sirop|nectar|energetique|gazeuse)/i },
  { name: 'منتجات الألبان', test: /\b(lait|yaourt|yoghourt|fromage|beurre|creme fraiche|danone|jaouda|raibi|leben|petit suisse|margarine)/i },
  { name: 'الحلويات', test: /\b(chocolat|biscuit|gateau|bonbon|confiture|miel|sucre|nutella|cereale|gaufre|barre|nappage|dessert|flan|cake|madeleine|pruneau|raisins secs|fruits secs|coco rape|amande|noix)/i },
  { name: 'التوابل والصلصات', test: /\b(mayonnaise|moutarde|ketchup|sauce|pesto|vinaigre|epice|poivre|gingembre|origan|bouillon|colorant|arome|levure|cannelle|cumin|paprika|curcuma|safran|herbe)/i },
  { name: 'المواد الغذائية', test: /\b(huile|conserve|thon|sardine|tomate|pate|tagliatelle|spaghetti|macaroni|riz|couscous|semoule|farine|legume|haricot|flageolet|pois|mais|olive|sel\b|lentille|avoine|soupe|chips|biscuit sale)/i },
];

function shelfFor(name: string): string {
  for (const shelf of SHELVES) if (shelf.test.test(name)) return shelf.name;
  return 'متفرقات';
}

/** Sold by weight, with the scale item code the label carries. */
const BULK = [
  { name: 'Riz basmati vrac', plu: '02001', price: 18.0, stock: 80 },
  { name: 'Lentilles vertes vrac', plu: '02002', price: 12.5, stock: 45 },
  { name: 'Pois chiches vrac', plu: '02003', price: 14.0, stock: 60 },
  { name: 'Pates coquillettes vrac', plu: '02004', price: 9.5, stock: 35 },
  { name: 'Ble dur concasse vrac', plu: '02005', price: 8.0, stock: 50 },
  { name: 'Amandes vrac', plu: '02006', price: 120.0, stock: 12, max: 5 },
  { name: 'Dattes Majhoul vrac', plu: '02007', price: 95.0, stock: 20, max: 5 },
];

function parseCsv(text: string): Row[] {
  // Minimal RFC-4180 reader: the catalogue quotes names containing commas.
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

function main() {
  const csvPath = process.argv[2];
  const wanted = Number(process.argv[3] || 300);
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(`usage: seed-demo-catalogue.ts <catalogue.csv> [count]`);
    process.exit(2);
  }

  initDatabase();
  const db = getDatabase();

  const rows = parseCsv(fs.readFileSync(path.resolve(csvPath), 'utf8'));
  const skipped = { noPrice: 0, badBarcode: 0, unprintable: 0, duplicate: 0 };
  const seenBarcode = new Set<string>();
  const picked: Array<{ name: string; barcode: string; price: number; shelf: string }> = [];

  for (const r of rows) {
    if (picked.length >= wanted) break;
    const price = Number((r.price_mad || '').trim());
    if (!Number.isFinite(price) || price <= 0) { skipped.noPrice++; continue; }
    const barcode = (r.sku || '').trim();
    if (!isValidEan13(barcode)) { skipped.badBarcode++; continue; }
    if (seenBarcode.has(barcode)) { skipped.duplicate++; continue; }
    const name = printableName(r.name || '');
    if (name.length < 3) { skipped.unprintable++; continue; }
    seenBarcode.add(barcode);
    // Catalogue names put the variant at the end ("… Ristretto Intenso"), so a
    // hard truncation removed the only thing telling two tiles apart.
    picked.push({ name: name.slice(0, 90), barcode, price, shelf: shelfFor(name) });
  }

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO categories (id, name, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`);
  const insertProduct = db.prepare(
    `INSERT INTO products (id, category_id, name, barcode, price, cost, track_inventory, stock_quantity,
       low_stock_threshold, unit_of_measure, quantity_precision, plu_code, max_quantity,
       is_active, sort_order, created_at, updated_at)
     VALUES (@id, @category_id, @name, @barcode, @price, @cost, 1, @stock, 5,
       @uom, @precision, @plu, @max, 1, 0, @ts, @ts)`);

  const shelves = new Map<string, string>();
  const seed = db.transaction(() => {
    const ts = now();
    for (const shelfName of [...new Set(picked.map((p) => p.shelf)), 'المواد السائبة']) {
      const id = generateShortId('categories');
      insertCategory.run(id, shelfName, 0, ts, ts);
      const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(shelfName) as { id: string };
      shelves.set(shelfName, row.id);
    }
    for (const p of picked) {
      insertProduct.run({
        id: generateShortId('products'), category_id: shelves.get(p.shelf), name: p.name,
        barcode: p.barcode, price: p.price,
        // A plausible margin so cost-based reports have something to show.
        cost: Math.round(p.price * 0.78 * 100) / 100,
        stock: 24, uom: 'unit', precision: 0, plu: null, max: null, ts,
      });
    }
    // Label decoding is off on a fresh install by design — a mis-set layout
    // bills a tenfold weight while keeping a valid check digit. It is safe to
    // turn on here because this seeder both prints and reads the labels, using
    // the one format it also encoded them with.
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('scale_labels_enabled', 'true', ?)
                ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(ts);

    for (const b of BULK) {
      insertProduct.run({
        id: generateShortId('products'), category_id: shelves.get('المواد السائبة'), name: b.name,
        barcode: null, price: b.price, cost: Math.round(b.price * 0.8 * 100) / 100,
        stock: b.stock, uom: 'kg', precision: 3, plu: b.plu, max: b.max ?? null, ts,
      });
    }
  });
  seed();

  const byShelf = new Map<string, number>();
  for (const p of picked) byShelf.set(p.shelf, (byShelf.get(p.shelf) ?? 0) + 1);

  console.log(`\n${picked.length} produits emballés importés depuis ${path.basename(csvPath)}`);
  for (const [shelf, n] of [...byShelf].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${shelf.padEnd(20)} ${n}`);
  }
  console.log(`   ${'المواد السائبة (بالوزن)'.padEnd(20)} ${BULK.length}`);
  console.log(`\nignorés : ${skipped.noPrice} sans prix, ${skipped.badBarcode} sans code-barres valide, ` +
    `${skipped.duplicate} en double, ${skipped.unprintable} au nom non imprimable`);
  console.log('\nÉtiquettes de balance à scanner pour tester :');
  for (const b of BULK.slice(0, 3)) {
    const grams = 734;
    const digits = `2${b.plu}0${String(grams).padStart(5, '0')}`;
    console.log(`   ${digits}${ean13CheckDigit(digits)}   ${b.name} — 0,734 kg`);
  }

  closeDatabase();
}

main();
