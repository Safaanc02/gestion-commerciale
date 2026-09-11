'use client';

import { useScaleWedge } from '@/hooks/useScaleWedge';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Delete, Printer, Search, Scale } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useAuthStore } from '@/store/auth';
import { getCountryByCode } from '@/lib/countries';
import { formatQuantity, hasAllowedPrecision, roundMoney } from '@units';

/**
 * The scale station screen.
 *
 * Runs on the PC the scale is plugged into, as the second mode of this same
 * application, reading the till's catalogue over the local network. One
 * operation, three taps: pick the product, key the weight, print the sticker.
 *
 * Where the weight comes from depends on the scale. One wired as a keyboard
 * fills it in by itself when the operator presses send (see useScaleWedge) —
 * no driver, no cable settings. One that speaks RS-232 needs a real driver and
 * its own protocol, and until that exists the keypad is the way in. The keypad
 * stays either way: a scale that is switched off, unplugged or between
 * readings must not stop a sale.
 */
interface WeighedProduct {
  id: string;
  name: string;
  price: number;
  plu_code: string;
  quantity_precision: number;
  max_quantity: number | null;
  category_name: string | null;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'] as const;

export default function ScaleStationPage() {
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const { currentTenant } = useAuthStore();
  const locale = getCountryByCode(currentTenant?.country ?? '')?.locale ?? 'fr-MA';

  const [products, setProducts] = useState<WeighedProduct[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WeighedProduct | null>(null);
  const [digits, setDigits] = useState('');

  // A scale wired as a keyboard fills the weight itself; one that speaks
  // RS-232 sends nothing here and the keypad below still works.
  useScaleWedge((grams) => setDigits(String(grams)));
  const [printing, setPrinting] = useState(false);
  const [lastLabel, setLastLabel] = useState<{ name: string; weight: number; total: number; barcode: string } | null>(null);

  useEffect(() => {
    api.get('/scale-station/products')
      .then((res) => setProducts((res.data.products as WeighedProduct[]) || []))
      .catch(() => toast.error(t('scaleStation.loadFailed')));
  }, [t]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return products;
    // Searching by PLU too: an operator who knows the code types it faster
    // than they can find the tile.
    return products.filter((p) => p.name.toLowerCase().includes(needle) || p.plu_code.includes(needle));
  }, [products, search]);

  const precision = selected?.quantity_precision ?? 3;
  const grams = Number(digits || '0');
  const quantityKg = Number((grams / 1000).toFixed(3));
  const total = roundMoney((selected?.price ?? 0) * quantityKg);
  const overMax = !!selected?.max_quantity && quantityKg > Number(selected.max_quantity);
  const tooPrecise = quantityKg > 0 && !hasAllowedPrecision(quantityKg, precision);
  const canPrint = !!selected && quantityKg > 0 && !overMax && !tooPrecise && !printing;

  const press = (key: string) => {
    if (key === 'del') { setDigits((d) => d.slice(0, -1)); return; }
    setDigits((d) => (d.length >= 6 ? d : (d === '0' ? key : d + key).replace(/^0+(?=\d)/, '')));
  };

  const print = async () => {
    if (!selected) return;
    setPrinting(true);
    try {
      const res = await api.post('/scale-station/label', { product_id: selected.id, quantity: quantityKg });
      setLastLabel({ name: selected.name, weight: quantityKg, total: res.data.total, barcode: res.data.barcode });
      // Cleared for the next bag, but the product stays selected: a queue of
      // customers is usually buying the same thing from the same bin.
      setDigits('');
      toast.success(t('scaleStation.labelPrinted'));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; barcode?: string } } };
      toast.error(e.response?.data?.error || t('scaleStation.printFailed'));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:flex-row">
      {/* Products */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative mb-3">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('scaleStation.searchPlaceholder')}
            className="w-full rounded-xl border border-border py-3 pl-10 pr-4 text-base outline-none focus:border-brand"
          />
        </div>

        {products.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground/70">
            <Scale size={48} />
            {/* The likeliest cause by far, so it is named rather than left as
                a generic empty state. */}
            <p className="mt-3 max-w-xs text-sm">{t('scaleStation.noWeighedProducts')}</p>
          </div>
        ) : (
          <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
            {filtered.map((product) => {
              const active = selected?.id === product.id;
              return (
                <button
                  key={product.id}
                  onClick={() => { setSelected(product); setDigits(''); }}
                  className={`flex min-h-[5.5rem] flex-col justify-between rounded-xl border p-3 text-left transition-colors ${
                    active ? 'border-brand bg-brand/10' : 'border-border bg-card hover:bg-muted'
                  }`}
                >
                  <span className="line-clamp-2 text-sm font-medium text-foreground">{product.name}</span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    {fmt(Number(product.price))}{t('pos.perKg')} · {product.plu_code}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Weighing */}
      <div className="flex w-full shrink-0 flex-col rounded-2xl border border-border bg-card p-4 lg:w-[22rem]">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground/70">
            {t('scaleStation.pickProduct')}
          </div>
        ) : (
          <>
            <h2 className="truncate text-lg font-semibold">{selected.name}</h2>
            <p className="text-sm text-muted-foreground">{fmt(Number(selected.price))}{t('pos.perKg')}</p>

            <div className="my-3 rounded-xl border bg-muted p-4 text-center">
              <div className="text-4xl font-semibold tabular-nums">
                {formatQuantity(quantityKg, 'kg', locale, precision)}
              </div>
              <div className="mt-1 text-2xl font-medium tabular-nums text-brand">{fmt(total)}</div>
              {overMax && (
                <p className="mt-2 text-sm font-medium text-red-600">
                  {t('pos.weightOverMax', { max: String(selected.max_quantity) })}
                </p>
              )}
              {tooPrecise && !overMax && (
                <p className="mt-2 text-sm font-medium text-red-600">
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
                  className="flex h-16 items-center justify-center rounded-xl border bg-card text-2xl font-medium tabular-nums active:scale-95 active:bg-muted"
                >
                  {key === 'del' ? <Delete className="h-6 w-6" /> : key}
                </button>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">{t('pos.enterWeightInGrams')}</p>

            <Button className="mt-3 h-16 text-base" disabled={!canPrint} onClick={print}>
              <Printer className="mr-2 h-5 w-5" />
              {printing ? t('scaleStation.printing') : t('scaleStation.printLabel')}
            </Button>

            {/* The last sticker stays on screen so the operator can check that
                what came out of the printer matches what they weighed. */}
            {lastLabel && (
              <div className="mt-3 rounded-lg border border-dashed border-input p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t('scaleStation.lastLabel')}</p>
                <p className="mt-1 truncate">{lastLabel.name}</p>
                <p className="tabular-nums">
                  {formatQuantity(lastLabel.weight, 'kg', locale, precision)} · {fmt(lastLabel.total)}
                </p>
                <p className="mt-1 font-mono tabular-nums">{lastLabel.barcode}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
