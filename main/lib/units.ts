/**
 * Unit-of-measure vocabulary shared by the Electron main process and the
 * renderer, so a weight is rounded and displayed identically in the cart, in
 * the persisted order and on the printed receipt.
 *
 * Deliberately dependency-free, like main/lib/scale-barcode.ts: it is aliased
 * into the Next.js bundle (`@units`), so anything imported here would end up
 * shipped to the browser.
 */

/** What a product is sold by. 'unit' is countable, 'kg' is weighed. */
export type Uom = 'unit' | 'kg';

export const UOM_VALUES: readonly Uom[] = ['unit', 'kg'] as const;

/**
 * Decimals a quantity may carry, per unit. Weighed goods go to the gram; a
 * countable item is a whole number. Stored per product as
 * `products.quantity_precision` so an exception (e.g. a 2-decimal scale)
 * doesn't need a code change — these are only the defaults.
 */
export const DEFAULT_PRECISION: Readonly<Record<Uom, number>> = { unit: 0, kg: 3 };

export function isUom(value: unknown): value is Uom {
  return typeof value === 'string' && (UOM_VALUES as readonly string[]).includes(value);
}

export function isWeighed(uom: unknown): boolean {
  return uom === 'kg';
}

export function defaultPrecision(uom: Uom): number {
  return DEFAULT_PRECISION[uom] ?? 0;
}

/**
 * Round half-up at `decimals`, via the same string-shift trick as
 * round() in main/services/tax.ts:77-80.
 *
 * Not toFixed(): on binary floats toFixed rounds the stored approximation
 * rather than the decimal the user typed, so 1.005 becomes "1.00". Sharing
 * tax.ts's algorithm is what keeps a line total identical between the tax
 * preview and the order actually written.
 */
function roundTo(value: number, decimals: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (!Number.isInteger(decimals) || decimals < 0) return value;
  const shifted = Number(`${value}e${decimals}`);
  // Magnitudes that serialise in exponential notation break the trick
  // ("1e-7e2" parses as NaN). They sit far outside any price or weight this
  // handles, so fall back rather than returning a silent 0.
  if (!Number.isFinite(shifted)) return Number(value.toFixed(decimals));
  const out = Number(`${Math.round(shifted)}e-${decimals}`);
  return Number.isFinite(out) ? out : Number(value.toFixed(decimals));
}

/** Round a monetary amount to 2 decimals. */
export function roundMoney(value: number): number {
  return roundTo(value, 2);
}

/** Round a quantity to the precision its product declares. */
export function roundQuantity(value: number, precision: number): number {
  return roundTo(value, precision);
}

/**
 * Whether `value` already fits within `precision` decimals.
 *
 * Callers use this to REJECT an over-precise quantity rather than round it:
 * silently turning 0.7341 kg into 0.734 kg makes the till disagree with the
 * scale label the customer is holding, and the difference only ever surfaces
 * during a stock count.
 */
export function hasAllowedPrecision(value: number, precision: number): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (!Number.isInteger(precision) || precision < 0) return false;
  const scaled = Number(`${value}e${precision}`);
  if (!Number.isFinite(scaled)) return false;
  // Tolerance absorbs the binary representation error of a decimal literal
  // (0.734 * 1000 is 733.9999999999999 in plain arithmetic), while staying far
  // below the 0.1 gap a genuinely over-precise value produces.
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

/**
 * Quantity as shown to a human: "0,734 kg" or "2".
 *
 * Weighed quantities keep their trailing zeros ("1,500 kg") to match what the
 * scale prints on the label, so a customer comparing the two sees the same
 * number rather than wondering whether "1,5" and "1,500" are the same thing.
 */
export function formatQuantity(
  value: number,
  uom: Uom,
  locale: string = 'fr-MA',
  precision: number = defaultPrecision(uom),
): string {
  const safe = Number.isFinite(value) ? value : 0;
  const decimals = Number.isInteger(precision) && precision >= 0 ? precision : defaultPrecision(uom);

  let digits: string;
  try {
    digits = new Intl.NumberFormat(locale, {
      minimumFractionDigits: isWeighed(uom) ? decimals : 0,
      maximumFractionDigits: decimals,
    }).format(safe);
  } catch {
    digits = safe.toFixed(decimals);
  }

  return isWeighed(uom) ? `${digits} kg` : digits;
}
