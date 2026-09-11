'use client';

import { useMemo, useState } from 'react';
import { X, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { hasAllowedPrecision, roundMoney } from '@units';
import type { Product } from '@/lib/types';

/**
 * Keying a weight in at the till.
 *
 * Primary path when the scale prints no scannable label, and the fallback for
 * when it does but the sticker is damaged or the scale is down — so the shop
 * keeps selling either way. Deliberately not the cart's +/- stepper: nobody
 * reaches 0.734 kg one tap at a time.
 *
 * Entry is in GRAMS, the unit written on the scale's display, so the cashier
 * copies what they see instead of translating it. The keypad targets are 64px
 * because this is used with fingers on a tablet, standing up, in a hurry.
 */
interface Props {
  product: Product;
  onConfirm: (product: Product, quantityKg: number) => void;
  onClose: () => void;
  initialGrams?: number;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'] as const;

export function WeightPad({ product, onConfirm, onClose, initialGrams }: Props) {
  const { t } = useI18n();
  const formatCurrency = useFormatCurrency();
  const [digits, setDigits] = useState(initialGrams ? String(Math.round(initialGrams)) : '');

  const precision = Number.isInteger(product.quantity_precision) ? product.quantity_precision! : 3;
  const pricePerKg = Number(product.price) || 0;

  const grams = Number(digits || '0');
  const quantityKg = useMemo(() => Number((grams / 1000).toFixed(3)), [grams]);
  const amount = roundMoney(pricePerKg * quantityKg);

  const overMax = product.max_quantity != null && quantityKg > Number(product.max_quantity);
  const tooPrecise = quantityKg > 0 && !hasAllowedPrecision(quantityKg, precision);
  const valid = quantityKg > 0 && !overMax && !tooPrecise;

  const press = (key: string) => {
    if (key === 'del') {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    // Six digits is 999.999 kg — far past anything a shop weighs on one line,
    // and it stops a stuck finger from running the display off the screen.
    setDigits((d) => (d.length >= 6 ? d : (d === '0' ? key : d + key).replace(/^0+(?=\d)/, '')));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="flex w-full max-w-md flex-col rounded-t-2xl bg-background p-4 shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{product.name}</h2>
            <p className="text-sm text-muted-foreground">
              {formatCurrency(pricePerKg)} {t('pos.perKg')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* The running read-out: weight as keyed, and what it will cost. The
            price is shown before confirming because that is the number the
            customer will query, and the cashier should see it first. */}
        <div className="mb-3 rounded-xl border bg-muted/40 p-4 text-center">
          <div className="text-4xl font-semibold tabular-nums">
            {quantityKg.toFixed(3).replace('.', ',')} <span className="text-2xl text-muted-foreground">kg</span>
          </div>
          <div className="mt-1 text-2xl font-medium tabular-nums text-primary">{formatCurrency(amount)}</div>
          {overMax && (
            <p className="mt-2 text-sm font-medium text-destructive">
              {t('pos.weightOverMax', { max: String(product.max_quantity) })}
            </p>
          )}
          {tooPrecise && !overMax && (
            <p className="mt-2 text-sm font-medium text-destructive">
              {t('pos.weightTooPrecise', { precision: String(precision) })}
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              aria-label={key === 'del' ? t('common.delete') : key}
              className="flex h-16 items-center justify-center rounded-xl border bg-card text-2xl font-medium tabular-nums
                         active:scale-95 active:bg-muted"
            >
              {key === 'del' ? <Delete className="h-6 w-6" /> : key}
            </button>
          ))}
        </div>

        <p className="mt-2 text-center text-xs text-muted-foreground">{t('pos.enterWeightInGrams')}</p>

        <div className="mt-3 flex gap-2">
          <Button variant="outline" className="h-14 flex-1 text-base" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="h-14 flex-[2] text-base"
            disabled={!valid}
            onClick={() => onConfirm(product, quantityKg)}
          >
            {t('pos.addToCart')}
          </Button>
        </div>
      </div>
    </div>
  );
}
