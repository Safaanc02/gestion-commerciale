/**
 * Make Arabic printable on an ESC/POS thermal printer.
 *
 * A receipt printer has no text engine. It draws one glyph per byte, left to
 * right, in whatever code page it was last told to use. Arabic needs three
 * things done to it before it can be handed over in that form:
 *
 *   1. Shaping. A letter takes a different glyph depending on its neighbours
 *      — ع alone, عـ starting a word, ـعـ inside one, ـع ending one. Sending
 *      base letters to a printer that does not shape produces a row of
 *      disconnected, unreadable stumps.
 *   2. Ligatures. lam followed by alef is one glyph, not two. Arabic readers
 *      treat the two-glyph form as broken, not merely ugly.
 *   3. Visual order. The printer advances left to right regardless, so the
 *      characters must be handed over already reversed.
 *
 * Which of these the printer does for itself varies by model, so the code page
 * is a setting rather than an assumption, and `renderVariants` prints the same
 * words every way at once so a shop can see which line comes out right.
 */
import { FORMS, LIGATURES, CP864, CP1256 } from './arabic-tables';

export type ArabicCodepage = 'none' | 'cp864' | 'cp1256';

const ISOLATED = 0, FINAL = 1, INITIAL = 2, MEDIAL = 3;

/** Combining marks — vowels and shadda. They never affect joining. */
const TRANSPARENT = /[ً-ٰٟۖ-ۭ]/;

/** Any Arabic character, base letters and presentation forms alike. */
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

export function hasArabic(text: string): boolean {
  return ARABIC.test(text);
}

/**
 * Can this letter connect to the letter that follows it?
 *
 * True only for letters that have an initial form. Alef, dal, ra, waw and
 * their relatives have isolated and final forms only: a following letter
 * always starts a fresh shape after them.
 */
function joinsForward(ch: string): boolean {
  const f = FORMS[ch];
  return !!f && !!f[INITIAL];
}

/** Can this letter connect to the letter before it? True for every Arabic letter. */
function joinsBackward(ch: string): boolean {
  return !!FORMS[ch];
}

/**
 * Replace each letter with the glyph its neighbours call for.
 *
 * Marks are skipped when looking left and right, so a vowel sign between two
 * letters does not break their connection.
 */
/**
 * Invisible direction marks. A text editor inserts them, they carry no glyph,
 * and reported as "dropped" they would look like a real loss.
 */
const INVISIBLE = /[\u200B-\u200F\u061C\uFEFF]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

export function shape(text: string): string {
  const chars = [...stripInvisible(text)];
  const out: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    // lam + alef is a single glyph. Consume both and pick its form from what
    // precedes the lam, since the pair never joins to what follows.
    const pair = ch + (chars[i + 1] ?? '');
    const ligature = LIGATURES[pair];
    if (ligature) {
      let j = i - 1;
      while (j >= 0 && TRANSPARENT.test(chars[j])) j--;
      const joined = j >= 0 && joinsForward(chars[j]);
      out.push(ligature[joined ? FINAL : ISOLATED] ?? ligature[ISOLATED] ?? pair);
      i++;
      continue;
    }

    const forms = FORMS[ch];
    if (!forms) { out.push(ch); continue; }

    let p = i - 1;
    while (p >= 0 && TRANSPARENT.test(chars[p])) p--;
    let n = i + 1;
    while (n < chars.length && TRANSPARENT.test(chars[n])) n++;

    const toPrev = p >= 0 && joinsForward(chars[p]) && joinsBackward(ch);
    const toNext = n < chars.length && joinsForward(ch) && joinsBackward(chars[n]);

    const wanted = toPrev && toNext ? MEDIAL : toPrev ? FINAL : toNext ? INITIAL : ISOLATED;
    // Fall back through the forms a letter actually has: a right-joining
    // letter asked for a medial glyph takes its final one.
    out.push(forms[wanted] ?? forms[FINAL] ?? forms[ISOLATED] ?? ch);
  }
  return out.join('');
}

/**
 * Reorder a line so a left-to-right printer draws it correctly.
 *
 * The line itself stays left to right — receipt columns depend on it, and an
 * item row is a name on one side and a price on the other. Only the Arabic
 * stretches are turned around, each taken whole so the words inside it swap
 * places along with their letters.
 *
 * Digits are then turned back. A quantity reads left to right inside Arabic
 * text, so "200غ" must not come out as "002غ" — the one thing a shopper would
 * actually notice on a price line.
 */
export function toVisualOrder(text: string): string {
  const chars = [...stripInvisible(text)];
  const out: string[] = [];
  let i = 0;

  while (i < chars.length) {
    if (!ARABIC.test(chars[i])) { out.push(chars[i++]); continue; }

    // Extend over neutrals so long as more Arabic follows: spaces and
    // punctuation between two Arabic words belong to the run.
    let end = i;
    for (let j = i; j < chars.length; j++) {
      if (ARABIC.test(chars[j]) || /[0-9٠-٩]/.test(chars[j])) end = j;
      else if (!/[\s،؛؟.,:;!?()\/+\-×*]/.test(chars[j])) break;
    }

    const run = chars.slice(i, end + 1).reverse();
    // Undo the reversal within each digit group.
    const restored = run.join('').replace(/[0-9٠-٩]+/g, (d) => [...d].reverse().join(''));
    out.push(restored);
    i = end + 1;
  }
  return out.join('');
}

/**
 * Encode to a printer code page, reporting what could not be represented.
 *
 * CP864 holds the shaped glyphs but almost none of the base letters; CP1256
 * holds the base letters and none of the shaped ones. Passing text through the
 * wrong one silently empties it, so the caller is told rather than left to
 * discover it on a customer's receipt.
 */
/**
 * Where each presentation glyph came from: form -> [base letter, which form].
 * Built from the tables rather than duplicated, so it cannot drift from them.
 */
const ORIGIN = new Map<string, { base: string; form: number }>();
for (const [table] of [[FORMS], [LIGATURES]] as const) {
  for (const base of Object.keys(table)) {
    (table as Record<string, (string | null)[]>)[base].forEach((glyph, form) => {
      if (glyph) ORIGIN.set(glyph, { base, form });
    });
  }
}

/**
 * CP864 keeps two shapes for most letters, not four: one that starts or joins
 * on the left, one that ends or stands alone. The printer's font draws the
 * connecting stroke. So a medial glyph it does not hold is written with the
 * initial one and a final glyph with the isolated one — the intended encoding,
 * not a downgrade. Letters whose four shapes genuinely differ, like ain, carry
 * all four and never reach this.
 */
const CP864_ALTERNATIVES: Record<number, number[]> = {
  [FINAL]: [ISOLATED],
  [MEDIAL]: [INITIAL, FINAL, ISOLATED],
  [INITIAL]: [ISOLATED],
  [ISOLATED]: [FINAL],
};

/**
 * Letters CP864 has no slot for, written with the plain letter underneath the
 * hamza. This is the substitution Arabic readers make without noticing;
 * leaving a gap in the middle of a product name is the alternative.
 */
const SIMPLIFY: Record<string, string> = {
  '\u0625': '\u0627', '\u0623': '\u0627', '\u0622': '\u0627',   // إ أ آ -> ا
  '\u0626': '\u064A',                                             // ئ -> ي
  '\u0624': '\u0648',                                             // ؤ -> و
};

function cp864Byte(ch: string): number | undefined {
  const direct = CP864[ch];
  if (direct !== undefined) return direct;
  const origin = ORIGIN.get(ch);
  if (!origin) return undefined;
  const shapes = (LIGATURES[origin.base] ?? FORMS[origin.base]) as (string | null)[] | undefined;
  if (!shapes) return undefined;
  for (const form of CP864_ALTERNATIVES[origin.form] ?? []) {
    const alt = shapes[form];
    if (alt && CP864[alt] !== undefined) return CP864[alt];
  }
  const plain = SIMPLIFY[origin.base];
  if (plain) {
    const plainShapes = FORMS[plain];
    for (const form of [origin.form, ...(CP864_ALTERNATIVES[origin.form] ?? [])]) {
      const alt = plainShapes?.[form];
      if (alt && CP864[alt] !== undefined) return CP864[alt];
    }
  }
  return undefined;
}

export function encode(text: string, codepage: 'cp864' | 'cp1256'): { bytes: Buffer; dropped: string[] } {
  const bytes: number[] = [];
  const dropped: string[] = [];

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) { bytes.push(code); continue; }
    const mapped = codepage === 'cp864' ? cp864Byte(ch) : CP1256[ch];
    if (mapped !== undefined) { bytes.push(mapped); continue; }
    // Diacritics are absent from CP864 and are not needed to read a product
    // name, so they go quietly. Anything else is worth reporting.
    if (!TRANSPARENT.test(ch)) dropped.push(ch);
  }
  return { bytes: Buffer.from(bytes), dropped };
}

/**
 * Turn one line of text into bytes for the given code page.
 *
 * CP1256 carries base letters, so the shaping pass is skipped and the printer
 * is trusted to do it — that is what its Arabic mode is for. CP864 carries
 * shaped glyphs, so the shaping is done here.
 */
export function renderLine(text: string, codepage: 'cp864' | 'cp1256'): { bytes: Buffer; dropped: string[] } {
  const prepared = codepage === 'cp864' ? shape(text) : text;
  return encode(toVisualOrder(prepared), codepage);
}
