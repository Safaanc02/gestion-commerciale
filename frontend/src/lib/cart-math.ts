import type { CartItem } from '@/lib/types';
import { formatQuantity, isWeighed, roundMoney } from '@units';

/**
 * What a cart line costs.
 *
 * This mirrors computeLineSubtotal on the server, and the two must not drift:
 * the screen shows this number and the server charges its own. It lives here
 * rather than inside a panel so the register's cart table and the sidebar cart
 * cannot disagree about the same basket.
 *
 * Three rules that are easy to get wrong. A price keyed by the cashier beats
 * the catalogue price. An add-on is a countable thing, so it is multiplied by
 * the quantity for a unit product but never by a weight — half a kilo does not
 * come with half a lid. And a line scanned off a scale label is worth the
 * amount printed on the sticker, not a recomputation of it.
 */
export function cartLineTotal(item: CartItem): number {
  const byWeight = isWeighed(item.unit_of_measure ?? item.product?.unit_of_measure);
  const qty = Number(item.quantity) || 0;
  const unitPrice = item.unit_price ?? (Number(item.product?.price) || 0);
  const base = item.amount_source === 'label_price' && item.label_amount != null
    ? Number(item.label_amount)
    : unitPrice * qty;
  const addons = (item.addons || []).reduce(
    (sum, a) => sum + (Number(a.price) || 0) * (Number(a.quantity) || 1), 0);
  return roundMoney(base + addons * (byWeight ? 1 : qty));
}

/** The unit price actually charged: a keyed price if there is one. */
export function cartUnitPrice(item: CartItem): number {
  return item.unit_price ?? (Number(item.product?.price) || 0);
}

/**
 * How much of something a line is for.
 *
 * A countable line reads "2x"; a weighed one reads "0,734 kg". Getting this
 * wrong is not cosmetic — the orders screen showed a 4-gram line of vermicelli
 * as "0.004x", which reads as a fraction of a packet rather than as a weight,
 * and gives no clue that the cashier keyed grams where they meant kilos.
 *
 * Shared because the till, the basket and the order history all show the same
 * line and must describe it the same way.
 */
export function quantityLabel(
  quantity: number | string,
  unitOfMeasure: string | null | undefined,
  locale: string,
): string {
  const qty = Number(quantity) || 0;
  return isWeighed(unitOfMeasure) ? formatQuantity(qty, 'kg', locale) : `${qty}x`;
}
