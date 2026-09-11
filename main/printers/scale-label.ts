/**
 * The sticker the scale station prints and the operator sticks on the bag.
 *
 * Two audiences, one piece of paper. The customer reads the weight, the price
 * per kilo and the total in plain text and must be able to check the maths.
 * The till reads only the barcode, which carries the product's scale item code
 * and the weight — so what the customer was quoted and what they are billed
 * come from the same measurement.
 *
 * Rendered as ESC/POS because that is what the rest of the printing stack
 * speaks, and because the barcode is drawn by the printer itself (GS k) rather
 * than rasterised here: a printer-drawn barcode has crisp bar edges at any
 * label width, which is what a scanner needs at the till.
 */
import { encodeScaleLabel, type ScaleLabelFormat } from '../lib/scale-barcode';
import { formatQuantity } from '../lib/units';
import { foldToPrinterAscii, resolveArabicPrinting } from './thermal';
import { hasArabic, renderLine as renderArabicLine } from './arabic';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export interface ScaleLabelContent {
  storeName?: string;
  productName: string;
  /** Net weight in kilograms. */
  quantityKg: number;
  quantityPrecision?: number;
  /** Price per kilogram, in major currency units. */
  pricePerKg: number;
  /** Line total, already rounded to the currency. */
  total: number;
  currencyPrefix: string;
  locale?: string;
  /** The scale item code stored on the product. */
  pluCode: string;
  printedAt?: string;
}

function centered(text: string, cols: number): string {
  const clipped = text.slice(0, cols);
  const pad = Math.max(0, Math.floor((cols - clipped.length) / 2));
  return ' '.repeat(pad) + clipped;
}

function labelled(label: string, value: string, cols: number): string {
  const gap = Math.max(1, cols - label.length - value.length);
  return label + ' '.repeat(gap) + value;
}

function money(amount: number, prefix: string, locale: string): string {
  const digits = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number.isFinite(amount) ? amount : 0);
  return `${digits} ${prefix}`;
}

/**
 * The EAN-13 the till will scan.
 *
 * Returns null when the layout or the item code cannot produce a valid
 * barcode — the caller must refuse to print rather than emit a sticker that
 * cannot be scanned, because an unscannable label means the cashier keys the
 * price in by hand and the whole audit trail is lost.
 */
export function scaleLabelBarcode(
  pluCode: string,
  quantityKg: number,
  total: number,
  format: ScaleLabelFormat,
): string | null {
  // Which number goes inside the bars depends on how the store configured its
  // labels: the weight (the default, and what lets the till print a full
  // "0,734 kg x 12,50" line) or the total price.
  const source = format.embeds === 'weight' ? quantityKg : total;
  const raw = Math.round(source * format.divisor);
  if (!(raw > 0)) return null;
  // A five-digit field tops out at 99999 units; past that the value would wrap
  // silently and bill a fraction of the real amount.
  if (String(raw).length > format.valueLength) return null;
  return encodeScaleLabel(pluCode, raw, format);
}

/** ESC/POS bytes for an EAN-13, drawn by the printer. */
function ean13Bytes(barcode: string): number[] {
  const bytes: number[] = [];
  // Height 80 dots and module width 3 keep the bars readable on a 40mm label
  // while leaving room for the human-readable digits underneath.
  bytes.push(GS, 0x68, 0x50);        // GS h — height
  bytes.push(GS, 0x77, 0x03);        // GS w — module width
  bytes.push(GS, 0x48, 0x02);        // GS H — print digits below the bars
  bytes.push(GS, 0x66, 0x00);        // GS f — HRI font A
  // GS k m n d1..dn, m = 67 (EAN-13). Twelve digits are sent and the printer
  // appends the check digit it computes: identical to ours by construction,
  // and it avoids the models that reject a pre-supplied 13th digit.
  const digits = barcode.slice(0, 12);
  bytes.push(GS, 0x6b, 67, digits.length);
  for (const char of digits) bytes.push(char.charCodeAt(0));
  return bytes;
}

/**
 * Build the printable label.
 *
 * `cols` is the label's character width — narrower than a receipt, since these
 * stickers are typically 40 to 58mm.
 */
export function buildScaleLabel(
  content: ScaleLabelContent,
  barcode: string,
  cols: number = 32,
): Buffer {
  const locale = content.locale ?? 'fr-MA';
  const precision = Number.isInteger(content.quantityPrecision) ? content.quantityPrecision! : 3;
  const buf: number[] = [];

  // The sticker goes on the bag and is what the customer reads, so it gets the
  // same Arabic treatment as the receipt. 165 of this shop's 168 loose-goods
  // products are named in Arabic: folded to ASCII the name came out blank and
  // the customer was handed an anonymous bag with a price on it.
  const arabic = resolveArabicPrinting();

  const write = (text: string, opts: { bold?: boolean; center?: boolean; doubleHeight?: boolean } = {}) => {
    buf.push(ESC, 0x61, opts.center ? 0x01 : 0x00);
    let mode = 0;
    if (opts.doubleHeight) mode |= 0x10;
    if (opts.bold) mode |= 0x08;
    buf.push(ESC, 0x21, mode);
    if (arabic && hasArabic(text)) {
      buf.push(ESC, 0x74, arabic.charsetId);
      buf.push(...renderArabicLine(text, arabic.codepage).bytes);
      buf.push(ESC, 0x74, 0x00);
    } else {
      // Latin accents are folded rather than dropped: "Ble dur" is readable,
      // a blank line never is.
      buf.push(...Buffer.from(foldToPrinterAscii(text).text, 'latin1'));
    }
    buf.push(LF);
  };

  buf.push(ESC, 0x40); // initialise

  if (content.storeName) write(centered(content.storeName, cols), { bold: true, center: true });
  write(centered(content.productName, cols), { bold: true, doubleHeight: true, center: true });
  write('');

  write(labelled('Poids', formatQuantity(content.quantityKg, 'kg', locale, precision), cols));
  write(labelled('Prix/kg', money(content.pricePerKg, content.currencyPrefix, locale), cols));
  write(labelled('TOTAL', money(content.total, content.currencyPrefix, locale), cols), { bold: true });
  write('');

  buf.push(ESC, 0x61, 0x01); // centre the barcode
  buf.push(...ean13Bytes(barcode));
  buf.push(LF);

  if (content.printedAt) write(centered(content.printedAt, cols), { center: true });

  buf.push(ESC, 0x64, 0x03);       // feed past the tear bar
  buf.push(GS, 0x56, 0x42, 0x00);  // partial cut

  return Buffer.from(buf);
}
