/**
 * Fold a product name or a query so that searching finds what is there.
 *
 * Arabic writes several letters more than one way, and the shop's catalogue
 * uses both. A cashier typing "قهوه" — the ordinary spelling — matched none of
 * the sixty coffees on the shelf, because they are written with ة; "مربي"
 * matched none of the thirty-six jams. 1164 of this shop's 3661 names contain
 * a letter with a variant, so a literal search fails on nearly a third of the
 * catalogue and the cashier concludes the product is not in the system.
 *
 * The substitutions are the ones Arabic readers make without thinking: the
 * hamza carriers collapse onto their base letter, taa marbuta onto haa, alef
 * maqsura onto yaa. Diacritics and tatweel carry no meaning for a match and
 * are dropped. Latin is lowercased and stripped of its accents for the same
 * reason — "cafe" should find "Café".
 */
const ARABIC_VARIANTS: Record<string, string> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ة': 'ه',
  'ى': 'ي', 'ئ': 'ي',
  'ؤ': 'و',
};

/** Harakat, shadda, sukun and the tatweel stretching character. */
const ARABIC_MARKS = /[ً-ْـٰ]/g;

export function normaliseForSearch(value: string): string {
  if (!value) return '';
  let out = '';
  for (const ch of value) out += ARABIC_VARIANTS[ch] ?? ch;
  return out
    .replace(ARABIC_MARKS, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // Latin accents
    .toLowerCase()
    .trim();
}
