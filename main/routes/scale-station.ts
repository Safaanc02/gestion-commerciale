/**
 * The scale station: weigh a bulk product, print the sticker.
 *
 * Runs as the second mode of the same application, on the PC the scale is
 * plugged into, reading the SAME catalogue as the till over the local network.
 * That shared catalogue is the whole point — a separate label printer with its
 * own product list drifts out of step with the till the first time a price
 * changes, and then a lentil sticker gets billed as almonds.
 *
 * The server owns the arithmetic here exactly as it does at the till: the
 * station sends a product and a weight, never a price.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { requireRole } from '../middleware/security';
import { getScaleConfig } from '../services/scan-resolver';
import { hasAllowedPrecision, roundMoney } from '../lib/units';
import { buildScaleLabel, scaleLabelBarcode } from '../printers/scale-label';
import { printScaleLabel } from '../printers/thermal';
import { getCountryByCode } from '../countries';

const router = Router();

interface WeighedProductRow {
  id: string;
  name: string;
  price: number;
  plu_code: string | null;
  quantity_precision: number;
  max_quantity: number | null;
}

/**
 * Products this station can weigh: sold by the kilo and carrying a scale item
 * code. A weighed product with no code cannot be labelled, because the till
 * would have nothing to resolve the sticker against.
 */
router.get('/products', requireRole('owner', 'manager', 'cashier', 'waiter'), (_req: Request, res: Response) => {
  try {
    const products = getDatabase().prepare(`
      SELECT p.id, p.name, p.price, p.plu_code, p.quantity_precision, p.max_quantity,
             p.tare_default, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.unit_of_measure = 'kg'
        AND p.plu_code IS NOT NULL AND p.plu_code != ''
        AND p.is_active = 1 AND p.deleted_at IS NULL
      ORDER BY c.sort_order, p.sort_order, p.name
    `).all();
    res.json({ products });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Compute and (optionally) print one label.
 *
 * `preview: true` returns the barcode and the amounts without printing, so the
 * station screen can show the operator exactly what will come out before any
 * paper is used.
 */
router.post('/label', requireRole('owner', 'manager', 'cashier', 'waiter'), async (req: Request, res: Response) => {
  try {
    const { product_id, quantity, preview } = req.body ?? {};
    const db = getDatabase();

    const product = db.prepare(`
      SELECT id, name, price, plu_code, quantity_precision, max_quantity
      FROM products
      WHERE id = ? AND unit_of_measure = 'kg' AND is_active = 1 AND deleted_at IS NULL
    `).get(String(product_id ?? '')) as WeighedProductRow | undefined;

    if (!product) return res.status(404).json({ error: 'No such product is sold by weight' });
    if (!product.plu_code) {
      return res.status(400).json({ error: 'This product has no scale item code, so its label could not be scanned at the till' });
    }

    const quantityKg = Number(quantity);
    if (!Number.isFinite(quantityKg) || quantityKg <= 0) {
      return res.status(400).json({ error: 'A positive weight is required' });
    }
    const precision = Number.isInteger(product.quantity_precision) ? product.quantity_precision : 3;
    if (!hasAllowedPrecision(quantityKg, precision)) {
      return res.status(400).json({ error: `Weight must have at most ${precision} decimal places` });
    }
    if (product.max_quantity != null && quantityKg > Number(product.max_quantity)) {
      return res.status(400).json({ error: `Weight exceeds this product's ${product.max_quantity} kg limit` });
    }

    // Same rounding module as the till, so the total printed on the sticker is
    // the one the customer is charged — to the centime.
    const pricePerKg = Number(product.price) || 0;
    const total = roundMoney(pricePerKg * quantityKg);

    const { format } = getScaleConfig(db);
    const barcode = scaleLabelBarcode(product.plu_code, quantityKg, total, format);
    if (!barcode) {
      return res.status(400).json({
        error: 'This weight cannot be encoded with the configured label layout — check Settings > Scale',
      });
    }

    const settings = db.prepare(
      `SELECT key, value FROM settings WHERE key IN ('business_name', 'currency_symbol', 'country')`
    ).all() as { key: string; value: string }[];
    const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    const country = settingsMap.country || 'MA';

    const content = {
      storeName: settingsMap.business_name || undefined,
      productName: product.name,
      quantityKg,
      quantityPrecision: precision,
      pricePerKg,
      total,
      currencyPrefix: settingsMap.currency_symbol || 'MAD',
      locale: getCountryByCode(country)?.locale ?? 'fr-MA',
      pluCode: product.plu_code,
      printedAt: now(),
    };

    if (preview) {
      return res.json({ preview: true, barcode, total, quantity: quantityKg, price_per_kg: pricePerKg });
    }

    const data = buildScaleLabel(content, barcode);
    const dispatch = await printScaleLabel(data);
    if (!dispatch.ok) {
      // A failed print is reported with the barcode still attached: the
      // operator can retry without re-weighing, and the bag never leaves the
      // station carrying a sticker the till cannot read.
      return res.status(502).json({
        error: dispatch.detail || 'The label printer did not respond',
        barcode, total, quantity: quantityKg,
      });
    }

    res.json({ printed: true, barcode, total, quantity: quantityKg, price_per_kg: pricePerKg });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const scaleStationRoutes = router;
