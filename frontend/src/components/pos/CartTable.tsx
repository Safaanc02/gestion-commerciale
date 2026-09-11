'use client';

import { useI18n } from '@/hooks/useI18n';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatQuantity, isWeighed } from '@units';
import { getCountryByCode } from '@/lib/countries';
import { cartLineTotal, cartUnitPrice } from '@/lib/cart-math';
import type { CartItem } from '@/lib/types';

/**
 * The basket as a table, the way a till receipt reads: quantity, item, unit
 * price, line total.
 *
 * A row is selected rather than carrying its own buttons. The actions live in
 * one fixed column at the edge of the screen, so a row keeps its full width
 * for the product name — and with names running to forty Arabic characters,
 * that width is what makes the line legible at arm's length.
 */
export default function CartTable({
  items, selectedId, onSelect, onOpenLine,
}: {
  items: CartItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenLine: (item: CartItem) => void;
}) {
  const { t } = useI18n();
  const { currentTenant } = useAuthStore();
  const fmt = useFormatCurrency();
  const locale = getCountryByCode(currentTenant?.country ?? '')?.locale ?? 'fr-MA';

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid shrink-0 grid-cols-[4.5rem_1fr_6rem_6.5rem] gap-2 border-b border-border bg-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{t('pos.quantity')}</span>
        <span>{t('pos.item')}</span>
        <span className="text-end">{t('pos.price')}</span>
        <span className="text-end">{t('pos.lineTotal')}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t('pos.cartEmpty')}</p>
        ) : (
          items.map((item) => {
            const byWeight = isWeighed(item.unit_of_measure ?? item.product?.unit_of_measure);
            const selected = item.id === selectedId;
            return (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                onDoubleClick={() => onOpenLine(item)}
                className={`grid w-full grid-cols-[4.5rem_1fr_6rem_6.5rem] items-center gap-2 border-b border-border px-3 py-2.5 text-start transition-colors ${
                  selected ? 'bg-brand/10' : 'hover:bg-muted/60'
                }`}
              >
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {byWeight
                    ? formatQuantity(item.quantity, 'kg', locale)
                    : item.quantity}
                </span>
                <span className="min-w-0 truncate text-sm text-foreground">{item.product?.name}</span>
                <span className="text-end text-sm tabular-nums text-muted-foreground">
                  {fmt(cartUnitPrice(item))}
                </span>
                <span className="text-end text-sm font-semibold tabular-nums text-foreground">
                  {fmt(cartLineTotal(item))}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
