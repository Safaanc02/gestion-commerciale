/**
 * Decoder for "variable measure" scale labels — the EAN-13 barcodes a deli or
 * bulk-goods scale prints onto a bag of rice, lentils, pasta or flour.
 *
 * The scale knows the price per kilo; the checkout does not learn the weight
 * from any cable, it reads it back out of the barcode itself. GS1 reserves the
 * prefixes 20-29 for exactly this ("restricted circulation within a company"),
 * so these codes are only meaningful inside one store's own catalogue.
 *
 * Layouts differ between scale brands and even between configurations of the
 * same brand, so nothing here is hard-coded to one vendor: the field positions
 * come from a ScaleLabelFormat that ships as a store setting. Two families
 * cover most of the market:
 *
 *   2 IIIII C VVVVV K   1-digit prefix, 5-digit item, scale's own check on the
 *                       measure, 5-digit measure, EAN-13 check digit
 *   20 IIIII VVVVV K    2-digit prefix, 5-digit item, 5-digit measure, check
 *
 * The embedded measure is either a WEIGHT in grams (00734 -> 0.734 kg) or a
 * PRICE in minor units (01250 -> 12.50 MAD), depending on how the scale was
 * configured. Both are supported; the store picks one.
 */

export type ScaleLabelEmbeds = 'weight' | 'price';

export interface ScaleLabelFormat {
  /** Leading digits that mark a barcode as a scale label, e.g. ['2'] or ['20', '02']. */
  prefixes: string[];
  /** Zero-based slice of the 13 digits holding the scale's item/PLU code. */
  itemCodeStart: number;
  itemCodeLength: number;
  /** Zero-based slice holding the embedded measure. */
  valueStart: number;
  valueLength: number;
  /** Whether the embedded digits are a weight or a total price. */
  embeds: ScaleLabelEmbeds;
  /** Divide the raw integer by this: 1000 for grams->kg, 100 for centimes->MAD. */
  divisor: number;
  /**
   * Reject labels whose EAN-13 check digit doesn't match. Leave this on: a
   * misread digit in the measure field silently overcharges or undercharges
   * the customer, and the check digit is the only thing that catches it.
   */
  verifyCheckDigit: boolean;
}

/**
 * Layout assumed until the store's own scale is confirmed: 1-digit prefix,
 * 5-digit item code, the scale's internal check digit, then the weight in
 * grams. This is the most common configuration on the machines sold into
 * Moroccan retail (Dibal, Epelsa, Bizerba), but it MUST be verified against a
 * real printed label before going live — see decodeScaleLabel's contract.
 */
export const DEFAULT_SCALE_LABEL_FORMAT: ScaleLabelFormat = {
  prefixes: ['2'],
  itemCodeStart: 1,
  itemCodeLength: 5,
  valueStart: 7,
  valueLength: 5,
  embeds: 'weight',
  divisor: 1000,
  verifyCheckDigit: true,
};

export type ScaleLabel =
  | { embeds: 'weight'; itemCode: string; weightKg: number; raw: string }
  | { embeds: 'price'; itemCode: string; priceMajor: number; raw: string };

export type ScaleLabelDecode =
  /** Not a scale label at all — the caller should fall through to a normal barcode lookup. */
  | { status: 'not-scale-label' }
  | { status: 'ok'; label: ScaleLabel }
  /**
   * It looks like a scale label but cannot be trusted. Never fall through to a
   * normal lookup here: show the cashier the reason and let them re-scan or
   * key the weight in by hand.
   */
  | { status: 'invalid'; reason: 'bad-length' | 'bad-check-digit' | 'bad-value' | 'bad-format' };

const EAN13_LENGTH = 13;

/** Check digit for the first 12 digits of an EAN-13, per GS1. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    // Positions are 1-indexed in the spec: odd positions weigh 1, even weigh 3.
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/**
 * Whether a label layout is self-consistent: both fields numeric, positive,
 * and landing inside the 12 data digits (the 13th is the check digit and is
 * never payload). Exported so the settings endpoint can refuse an incoherent
 * layout at write time rather than letting every scan fail afterwards.
 */
export function isValidScaleLabelFormat(format: ScaleLabelFormat): boolean {
  const { itemCodeStart, itemCodeLength, valueStart, valueLength } = format;
  if (!Number.isInteger(itemCodeStart) || !Number.isInteger(itemCodeLength)) return false;
  if (!Number.isInteger(valueStart) || !Number.isInteger(valueLength)) return false;
  if (itemCodeLength <= 0 || valueLength <= 0) return false;
  if (itemCodeStart < 0 || valueStart < 0) return false;
  // Both fields must land inside the 12 data digits — the 13th is the check
  // digit and is never part of a payload.
  if (itemCodeStart + itemCodeLength > EAN13_LENGTH - 1) return false;
  if (valueStart + valueLength > EAN13_LENGTH - 1) return false;
  if (!format.prefixes.length || !format.prefixes.every((p) => /^\d+$/.test(p))) return false;
  if (!(format.divisor > 0)) return false;
  return true;
}

/**
 * Decode a scanned barcode as a scale label, or report why it isn't one.
 *
 * The caller is expected to branch on `status`: 'not-scale-label' means "this
 * is an ordinary product barcode, look it up normally", while 'invalid' means
 * "this came off a scale but is unusable" and must surface to the cashier.
 */
export function decodeScaleLabel(
  scanned: string,
  format: ScaleLabelFormat = DEFAULT_SCALE_LABEL_FORMAT,
): ScaleLabelDecode {
  const code = String(scanned ?? '').trim();

  // A non-numeric scan can't be an EAN-13 at all, so it is somebody else's
  // problem (a QR code, a keyed-in SKU) rather than a broken label.
  if (!/^\d+$/.test(code)) return { status: 'not-scale-label' };
  if (!format.prefixes.some((p) => code.startsWith(p))) return { status: 'not-scale-label' };

  if (!isValidScaleLabelFormat(format)) return { status: 'invalid', reason: 'bad-format' };
  if (code.length !== EAN13_LENGTH) return { status: 'invalid', reason: 'bad-length' };
  if (format.verifyCheckDigit && !isValidEan13(code)) {
    return { status: 'invalid', reason: 'bad-check-digit' };
  }

  const itemCode = code.slice(format.itemCodeStart, format.itemCodeStart + format.itemCodeLength);
  const rawValue = Number(code.slice(format.valueStart, format.valueStart + format.valueLength));
  if (!Number.isFinite(rawValue) || rawValue <= 0) return { status: 'invalid', reason: 'bad-value' };

  // Round to the precision the divisor actually carries, so 734/1000 is stored
  // as 0.734 rather than a float tail that would later print as 0.7340000001.
  const decimals = Math.max(0, Math.round(Math.log10(format.divisor)));
  const value = Number((rawValue / format.divisor).toFixed(decimals));

  return {
    status: 'ok',
    label:
      format.embeds === 'weight'
        ? { embeds: 'weight', itemCode, weightKg: value, raw: code }
        : { embeds: 'price', itemCode, priceMajor: value, raw: code },
  };
}

/**
 * Build a scale label, for tests and for the settings screen's "try my format"
 * preview — so a shopkeeper can check their configuration against a real
 * printed label without guessing.
 */
export function encodeScaleLabel(
  itemCode: string,
  rawValue: number,
  format: ScaleLabelFormat = DEFAULT_SCALE_LABEL_FORMAT,
): string | null {
  if (!isValidScaleLabelFormat(format)) return null;
  if (!/^\d+$/.test(itemCode) || itemCode.length !== format.itemCodeLength) return null;
  const valueDigits = String(Math.round(rawValue)).padStart(format.valueLength, '0');
  if (valueDigits.length !== format.valueLength) return null;

  const digits = new Array(EAN13_LENGTH - 1).fill('0');
  const prefix = format.prefixes[0];
  for (let i = 0; i < prefix.length; i++) digits[i] = prefix[i];
  for (let i = 0; i < format.itemCodeLength; i++) digits[format.itemCodeStart + i] = itemCode[i];
  for (let i = 0; i < format.valueLength; i++) digits[format.valueStart + i] = valueDigits[i];

  const first12 = digits.join('');
  return first12 + String(ean13CheckDigit(first12));
}
