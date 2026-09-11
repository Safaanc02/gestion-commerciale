'use client';

import { Check, Hash, Trash2, XCircle } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

/**
 * The fixed column of till actions.
 *
 * Four buttons, in the order the till they already use puts them, and always
 * in the same place whatever is on screen: a cashier reaches for a position,
 * not for a label. The two that destroy work are red and sit apart from the
 * two that do not, because the cost of hitting the wrong one is a voided sale
 * in front of a queue.
 */
export default function RegisterActions({
  onConfirm, onQuantity, onRemoveLine, onCancelTicket,
  canConfirm, hasSelection, hasItems, submitting,
}: {
  onConfirm: () => void;
  onQuantity: () => void;
  onRemoveLine: () => void;
  onCancelTicket: () => void;
  canConfirm: boolean;
  hasSelection: boolean;
  hasItems: boolean;
  submitting: boolean;
}) {
  const { t } = useI18n();

  const base = 'flex w-full flex-col items-center justify-center gap-1 rounded-lg px-2 py-3 text-xs font-semibold transition-colors disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="flex h-full w-24 shrink-0 flex-col gap-2">
      <button
        onClick={onConfirm}
        disabled={!canConfirm || submitting}
        className={`${base} flex-1 bg-brand text-white hover:bg-brand-hover text-sm`}
      >
        <Check size={26} strokeWidth={2.5} />
        {submitting ? t('pos.placing') : t('pos.confirm')}
      </button>

      <button onClick={onQuantity} disabled={!hasSelection}
        className={`${base} border border-border bg-card text-foreground hover:bg-muted`}>
        <Hash size={20} strokeWidth={1.75} />
        {t('pos.quantity')}
      </button>

      <div className="mt-auto flex flex-col gap-2">
        <button onClick={onRemoveLine} disabled={!hasSelection}
          className={`${base} border border-red-200 bg-red-50 text-red-700 hover:bg-red-100`}>
          <Trash2 size={20} strokeWidth={1.75} />
          {t('pos.removeLine')}
        </button>
        <button onClick={onCancelTicket} disabled={!hasItems}
          className={`${base} bg-red-600 text-white hover:bg-red-700`}>
          <XCircle size={20} strokeWidth={1.75} />
          {t('pos.cancelTicket')}
        </button>
      </div>
    </div>
  );
}
