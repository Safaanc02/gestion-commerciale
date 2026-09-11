'use client';

import { useMemo, useState } from 'react';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { X, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { roundMoney } from '@units';
import type { Product } from '@/lib/types';

/**
 * What opens when a cashier taps a product: how many, and at what price.
 *
 * One keypad, two fields. Tapping a field aims the keypad at it, so there is
 * no second layout to learn and no stepper to press eleven times. The price
 * starts at the catalogue price and is only sent when it was actually changed
 * — shelf prices move faster than a catalogue, but a till that quietly reports
 * a price on every line makes a genuine change impossible to spot afterwards.
 */
interface Props {
  product: Product;
  onConfirm: (product: Product, quantity: number, unitPrice: number | null) => void;
  onClose: () => void;
  initialQuantity?: number;
  /**
   * A code read while this pad is open.
   *
   * Given only by the till. The pad is a chance to correct a quantity or a
   * price, not a gate: a cashier working through a basket scans one item after
   * another and should not have to reach for the screen between two beeps. So
   * a scan accepts this line as it stands and hands the new code back up.
   * Without this the pad silently swallowed every scan after the first, since
   * opening it takes the scanner listener off the page.
   */
  onScan?: (code: string) => void;
}

type Field = 'quantity' | 'price';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function ItemPad({ product, onConfirm, onClose, initialQuantity = 1, onScan }: Props) {
  const { t } = useI18n();
  const formatCurrency = useFormatCurrency();

  const cataloguePrice = Number(product.price) || 0;
  const [field, setField] = useState<Field>('quantity');
  const [quantity, setQuantity] = useState(String(initialQuantity));
  const [price, setPrice] = useState(cataloguePrice.toFixed(2));

  const qty = Math.floor(Number(quantity) || 0);
  const unitPrice = Number(price.replace(',', '.')) || 0;
  const total = useMemo(() => roundMoney(unitPrice * qty), [unitPrice, qty]);
  const priceChanged = roundMoney(unitPrice) !== roundMoney(cataloguePrice);
  const valid = qty > 0 && unitPrice >= 0;

  // Enabled only when the till passed a handler, so exactly one listener is
  // ever active: the page turns its own off while this pad is open.
  useBarcodeScanner((code) => {
    if (valid) onConfirm(product, qty, priceChanged ? roundMoney(unitPrice) : null);
    onScan?.(code);
  }, !!onScan);

  const current = field === 'quantity' ? quantity : price;
  const setCurrent = (next: string) => (field === 'quantity' ? setQuantity(next) : setPrice(next));

  const press = (key: string) => {
    if (key === 'del') { setCurrent(current.slice(0, -1)); return; }
    if (key === '.') {
      // Whole units only — a countable product has no half.
      if (field === 'quantity' || current.includes('.')) return;
      setCurrent(current + '.');
      return;
    }
    if (current.length >= 8) return;
    setCurrent(current === '0' ? key : current + key);
  };

  const fieldClass = (target: Field) =>
    `flex-1 rounded-xl border-2 p-3 text-start transition-colors ${
      field === target ? 'border-primary bg-primary/5' : 'border-border'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="flex w-full max-w-md flex-col rounded-t-2xl bg-background p-4 shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{product.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-3 flex gap-2">
          <button type="button" onClick={() => setField('quantity')} className={fieldClass('quantity')}>
            <div className="text-xs text-muted-foreground">{t('pos.quantity')}</div>
            <div className="text-2xl font-semibold tabular-nums">{quantity || '0'}</div>
          </button>
          <button type="button" onClick={() => setField('price')} className={fieldClass('price')}>
            <div className="text-xs text-muted-foreground">
              {t('pos.unitPrice')}
              {priceChanged && <span className="ms-1 text-amber-600">•</span>}
            </div>
            <div className="text-2xl font-semibold tabular-nums">{price || '0'}</div>
          </button>
        </div>

        <div className="mb-3 rounded-xl bg-muted/40 p-3 text-center">
          <div className="text-3xl font-semibold tabular-nums text-primary">{formatCurrency(total)}</div>
          {priceChanged && (
            <p className="mt-1 text-xs text-amber-700">
              {t('pos.priceChangedFrom', { price: formatCurrency(cataloguePrice) })}
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              className="flex h-14 items-center justify-center rounded-xl border bg-card text-2xl font-medium tabular-nums
                         active:scale-95 active:bg-muted"
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => press('.')}
            disabled={field === 'quantity'}
            className="flex h-14 items-center justify-center rounded-xl border bg-card text-2xl font-medium
                       active:scale-95 active:bg-muted disabled:opacity-30"
          >
            ,
          </button>
          <button
            type="button"
            onClick={() => press('0')}
            className="flex h-14 items-center justify-center rounded-xl border bg-card text-2xl font-medium tabular-nums
                       active:scale-95 active:bg-muted"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => press('del')}
            aria-label={t('common.delete')}
            className="flex h-14 items-center justify-center rounded-xl border bg-card active:scale-95 active:bg-muted"
          >
            <Delete className="h-6 w-6" />
          </button>
        </div>

        <div className="mt-3 flex gap-2">
          <Button variant="outline" className="h-14 flex-1 text-base" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="h-14 flex-[2] text-base"
            disabled={!valid}
            onClick={() => onConfirm(product, qty, priceChanged ? roundMoney(unitPrice) : null)}
          >
            {t('pos.addToCart', { total: formatCurrency(total) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
