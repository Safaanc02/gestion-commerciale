/**
 * A shelf's colour, from its identifier.
 *
 * The till this replaces colours every tile, which is what makes it quick to
 * scan — but its colours are per product and arbitrary: three neighbours from
 * the same aisle come out magenta, cyan and orange, so the colour tells the
 * cashier nothing. Here it comes from the shelf, so a block of one colour is a
 * block of one aisle and the eye can use it.
 *
 * Shared by the tiles and the shelf buttons on purpose. The whole point is
 * that the button and the products it reveals are the same colour, and two
 * copies of this would eventually disagree.
 *
 * The twelve grounds carry dark text at 9.9:1 or better, so the price stays
 * the most legible thing on a tile. They are deliberately not saturated:
 * white-on-strong-colour reads well for a minute and wears on a cashier over a
 * ten-hour day.
 */
const SHELF_TINTS = [
  '#BFE3CE', '#C9DDF5', '#FBDCC0', '#F2CADD', '#C6E3EC', '#EADFA8',
  '#DCCDF0', '#F8C9C2', '#D4EBBE', '#E2D9C6', '#BFE6E3', '#F3C9DE',
];

/** The single ink these grounds were measured against. */
export const SHELF_INK = '#1F2A24';

export function shelfTint(categoryId: string | number | null | undefined): string {
  const key = String(categoryId ?? '');
  if (!key) return SHELF_TINTS[0];
  // Deterministic: a shelf keeps its colour between sessions, which is what
  // lets a cashier learn "the blue block is tea".
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return SHELF_TINTS[hash % SHELF_TINTS.length];
}
