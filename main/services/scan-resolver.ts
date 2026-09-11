/**
 * Turns a raw barcode scan into either an ordinary product or a weighed line.
 *
 * This is the ONLY place the scale-label calling policy lives, and it runs on
 * the server. The till never sends a quantity it decided for itself: it sends
 * the digits it read, and the server re-decodes them against its own catalogue
 * — the same posture main/routes/orders.ts already takes with prices and
 * discounts, where a client-supplied amount is deliberately ignored.
 *
 * Order writing reuses these functions unchanged, so a weighed line is
 * resolved identically whether it arrives from a live scan or from an order
 * being replayed.
 */
import {
  DEFAULT_SCALE_LABEL_FORMAT,
  decodeScaleLabel,
  type ScaleLabel,
  type ScaleLabelFormat,
} from '../lib/scale-barcode';
import { roundMoney, roundQuantity, type Uom } from '../lib/units';

export interface ScanProduct {
  id: string;
  name: string;
  price: number;
  barcode: string | null;
  plu_code: string | null;
  unit_of_measure: Uom;
  quantity_precision: number;
  max_quantity: number | null;
}

export interface Measure {
  quantity: number;
  unit_of_measure: Uom;
  /**
   * 'scale_label' — read straight out of the barcode.
   * 'price_derived' — the label carried a price, and this weight was computed
   * back from it. Never use a price_derived quantity to recompute the amount.
   */
  quantity_source: 'scale_label' | 'price_derived';
  /** 'label_price' means the amount is authoritative and must not be recomputed. */
  amount_source: 'computed' | 'label_price';
  /** Line amount before discount and tax. */
  amount: number;
  scan_raw: string;
}

export type ScanRejectReason =
  /** Right prefix, wrong length: a truncated read of a real label. */
  | 'truncated-label'
  /** Check digit failed: the label is damaged or misread. */
  | 'damaged-label'
  /** The configured label layout is nonsense — a settings problem, not a scan problem. */
  | 'bad-format'
  /** Decoded cleanly, but no product carries that scale item code. */
  | 'unknown-plu'
  /** The item code resolves to a product that isn't sold by weight. */
  | 'not-sold-by-weight'
  /** Beyond the product's per-line ceiling — the classic shifted-digit symptom. */
  | 'over-max-quantity'
  /** Rounds to nothing at the product's precision. */
  | 'zero-quantity'
  /** A price-embedded label on a product with no usable unit price. */
  | 'no-unit-price';

export type ScanOutcome =
  | { kind: 'product'; product: ScanProduct }
  | { kind: 'weighed'; product: ScanProduct; measure: Measure }
  /** Nothing matched. Not an error: the cashier can still search by name. */
  | { kind: 'unknown'; code: string }
  /** It came off a scale but cannot be trusted. Must surface, never fall through. */
  | { kind: 'rejected'; reason: ScanRejectReason; code: string };

export interface ScaleConfig {
  enabled: boolean;
  format: ScaleLabelFormat;
}

const PRODUCT_COLUMNS = `
  id, name, price, barcode, plu_code,
  unit_of_measure, quantity_precision, max_quantity
`;

/**
 * Read the store's scale settings, falling back to the shipped default.
 *
 * The seeded settings row is a convenience, never a hard dependency: a missing
 * or corrupt row must leave scanning working rather than take the till down.
 */
export function getScaleConfig(db: any): ScaleConfig {
  let enabled = false;
  let format: ScaleLabelFormat = DEFAULT_SCALE_LABEL_FORMAT;
  try {
    const enabledRow = db.prepare(`SELECT value FROM settings WHERE key = 'scale_labels_enabled'`).get();
    enabled = String(enabledRow?.value ?? 'false') === 'true';
  } catch {
    enabled = false;
  }
  try {
    const formatRow = db.prepare(`SELECT value FROM settings WHERE key = 'scale_label_format'`).get();
    if (formatRow?.value) {
      const parsed = JSON.parse(String(formatRow.value));
      if (parsed && Array.isArray(parsed.prefixes)) format = parsed as ScaleLabelFormat;
    }
  } catch {
    format = DEFAULT_SCALE_LABEL_FORMAT;
  }
  return { enabled, format };
}

function findByBarcode(db: any, code: string): ScanProduct | null {
  const row = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products
     WHERE barcode = ? AND deleted_at IS NULL AND is_active = 1`
  ).get(code);
  return (row as ScanProduct) ?? null;
}

function findByPlu(db: any, pluCode: string): ScanProduct | null {
  const row = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products
     WHERE plu_code = ? AND deleted_at IS NULL AND is_active = 1`
  ).get(pluCode);
  return (row as ScanProduct) ?? null;
}

/**
 * Build the line measurements a decoded label implies.
 *
 * Exported so order writing can re-derive them from `scan_raw` instead of
 * trusting whatever the client posted.
 */
export function measureFromLabel(
  product: ScanProduct,
  label: ScaleLabel,
): { ok: true; measure: Measure } | { ok: false; reason: ScanRejectReason } {
  const precision = Number.isInteger(product.quantity_precision) ? product.quantity_precision : 3;
  const unitPrice = Number(product.price);

  if (label.embeds === 'weight') {
    const quantity = roundQuantity(label.weightKg, precision);
    if (!(quantity > 0)) return { ok: false, reason: 'zero-quantity' };
    if (product.max_quantity != null && quantity > Number(product.max_quantity)) {
      return { ok: false, reason: 'over-max-quantity' };
    }
    return {
      ok: true,
      measure: {
        quantity,
        unit_of_measure: product.unit_of_measure,
        quantity_source: 'scale_label',
        amount_source: 'computed',
        amount: roundMoney(unitPrice * quantity),
        scan_raw: label.raw,
      },
    };
  }

  // Price-embedded label: the amount the customer read on the scale wins.
  // The weight is only reconstructed for the receipt and for stock, and is
  // marked as derived so nothing ever recomputes the amount from it — at
  // 7.34 MAD / 12.50 MAD/kg the round trip does not close to the centime.
  if (!(unitPrice > 0)) return { ok: false, reason: 'no-unit-price' };
  const amount = roundMoney(label.priceMajor);
  if (!(amount > 0)) return { ok: false, reason: 'zero-quantity' };
  const derived = roundQuantity(amount / unitPrice, precision);
  if (product.max_quantity != null && derived > Number(product.max_quantity)) {
    return { ok: false, reason: 'over-max-quantity' };
  }
  return {
    ok: true,
    measure: {
      quantity: derived,
      unit_of_measure: product.unit_of_measure,
      quantity_source: 'price_derived',
      amount_source: 'label_price',
      amount,
      scan_raw: label.raw,
    },
  };
}

/**
 * Resolve one scan.
 *
 * The branch order matters and is the corrected calling policy:
 *
 *  1. decoding disabled          -> ordinary lookup
 *  2. decodes cleanly            -> weighed line
 *  3. not a scale label          -> ordinary lookup
 *  4. right prefix, wrong length -> AMBIGUOUS. Try the ordinary lookup first:
 *     a 12-digit UPC-A or an in-house code starting with 2 is a real product
 *     and must stay scannable. Only if nothing matches is it a truncated label.
 *  5. bad check digit / value / format -> REFUSE, never fall through. Billing
 *     a misread weight is worse than making the cashier scan again.
 */
export function resolveScan(db: any, code: string, config?: ScaleConfig): ScanOutcome {
  const scanned = String(code ?? '').trim();
  if (!scanned) return { kind: 'unknown', code: scanned };

  const { enabled, format } = config ?? getScaleConfig(db);

  const ordinary = (): ScanOutcome => {
    const product = findByBarcode(db, scanned);
    return product ? { kind: 'product', product } : { kind: 'unknown', code: scanned };
  };

  if (!enabled) return ordinary();

  const decoded = decodeScaleLabel(scanned, format);

  if (decoded.status === 'not-scale-label') return ordinary();

  if (decoded.status === 'invalid') {
    if (decoded.reason === 'bad-length') {
      const fallback = ordinary();
      if (fallback.kind === 'product') return fallback;
      return { kind: 'rejected', reason: 'truncated-label', code: scanned };
    }
    return {
      kind: 'rejected',
      reason: decoded.reason === 'bad-format' ? 'bad-format' : 'damaged-label',
      code: scanned,
    };
  }

  // A scale label carries a different barcode on every weighing, so it can
  // never be stored in products.barcode (which is unique). It resolves on the
  // dedicated plu_code column instead.
  const product = findByPlu(db, decoded.label.itemCode);
  if (!product) return { kind: 'rejected', reason: 'unknown-plu', code: scanned };
  if (product.unit_of_measure !== 'kg') {
    return { kind: 'rejected', reason: 'not-sold-by-weight', code: scanned };
  }

  const measured = measureFromLabel(product, decoded.label);
  if (!measured.ok) return { kind: 'rejected', reason: measured.reason, code: scanned };

  return { kind: 'weighed', product, measure: measured.measure };
}
