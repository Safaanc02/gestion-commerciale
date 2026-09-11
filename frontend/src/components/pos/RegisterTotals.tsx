'use client';

import { useI18n } from '@/hooks/useI18n';
import { useCartStore } from '@/store/cart';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { cartLineTotal } from '@/lib/cart-math';

/**
 * What the customer owes, in the largest type on the screen.
 *
 * The till this replaces gives the total its own band across the top, and it
 * is the one number both people at the counter are looking at — the cashier to
 * announce it, the customer to check it. My first pass at the register had no
 * total anywhere: the basket listed its lines and stopped.
 */
export default function RegisterTotals({ itemCount }: { itemCount: number }) {
  const { t } = useI18n();
  const cart = useCartStore();
  const fmt = useFormatCurrency();

  const total = cart.items.reduce((sum, item) => sum + cartLineTotal(item), 0);

  return (
    <div className="flex shrink-0 items-center justify-between gap-4 rounded-lg bg-[#123D2B] px-4 py-2.5 text-white">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/60">
          {t('pos.items')}
        </span>
        <span className="text-lg font-semibold tabular-nums">{itemCount}</span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-white/60">
          {t('pos.total')}
        </span>
        {/* Sized to be read across a counter, not from a chair. */}
        <span className="text-3xl font-bold tabular-nums leading-none">{fmt(total)}</span>
      </div>
    </div>
  );
}
