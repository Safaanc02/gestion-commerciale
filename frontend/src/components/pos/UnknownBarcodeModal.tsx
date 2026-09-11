'use client';

import { useState } from 'react';
import { Barcode, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { useAuthStore } from '@/store/auth';
import type { Category, Product } from '@/lib/types';

/**
 * A scanned code that is in no catalogue.
 *
 * Until now this was a dead end: a toast said the barcode was unknown and the
 * sale stopped there, with the item on the counter and a queue behind it. New
 * stock arrives every week and nobody enters it into the till before selling
 * it, so this is an ordinary Tuesday, not an error.
 *
 * The barcode is already known, so only two things are missing — what it is
 * and what it costs. Everything else takes a default the manager can correct
 * later from the products screen, and the item goes into the basket the moment
 * it is saved.
 */
export default function UnknownBarcodeModal({
  barcode, categories, onCreated, onClose,
}: {
  barcode: string;
  categories: Category[];
  onCreated: (product: Product) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { currentTenant } = useAuthStore();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const priceValue = Number(price.replace(',', '.'));
  const canSave = name.trim().length > 0 && Number.isFinite(priceValue) && priceValue > 0;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const { data } = await api.post('/products', {
        name: name.trim(),
        barcode,
        price: priceValue,
        category_id: categoryId || null,
        is_active: true,
        // Stock is not tracked: the imported catalogue carries none, and a
        // count invented at the till would be worse than no count at all.
        track_inventory: false,
      });
      const created: Product = data.product ?? data;
      toast.success(t('pos.productCreated'));
      onCreated(created);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      // A cashier is not allowed to add to the catalogue. Say so plainly
      // instead of showing a generic failure they cannot act on.
      toast.error(e.response?.status === 403
        ? t('pos.productCreateNotAllowed')
        : e.response?.data?.error || t('common.somethingWrong'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('pos.unknownBarcodeTitle')}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm tabular-nums text-muted-foreground">
              <Barcode size={14} className="shrink-0" />
              {barcode}
            </p>
          </div>
          <button onClick={onClose} aria-label={t('common.close')} className="text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('pos.item')}</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-input px-3 py-2.5 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('pos.price')}</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
              className="rounded-lg border border-input px-3 py-2.5 text-xl font-semibold tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('pos.categories')}</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="rounded-lg border border-input px-3 py-2.5 text-sm outline-none focus:border-brand"
            >
              <option value="">{t('pos.uncategorised')}</option>
              {categories.filter((c) => c.id != null).map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-muted">
            {t('common.cancel')}
          </button>
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="flex-[2] rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? t('common.saving') : t('pos.createAndAdd')}
          </button>
        </div>

        {currentTenant?.role !== 'owner' && currentTenant?.role !== 'manager' && (
          <p className="mt-3 text-center text-xs text-amber-700">{t('pos.productCreateNotAllowed')}</p>
        )}
      </div>
    </div>
  );
}
