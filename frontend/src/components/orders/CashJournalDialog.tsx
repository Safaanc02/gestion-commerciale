'use client';

import { useState } from 'react';
import { FileText, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { printCashJournal } from '@/lib/printer/cash-journal';
import type { Bill } from '@/lib/types';

/**
 * Print the day's takings on a sheet of A4.
 *
 * The range defaults to today at both ends, which is the case that gets used
 * every evening; widening it to a week or a month for the accountant is two
 * taps rather than a second screen.
 *
 * The bills come from the server for the range asked for, not from whatever
 * the orders list happens to be showing: that list is paged and filtered, and
 * a journal that quietly omitted the sales on page two would be worse than no
 * journal at all.
 */
export default function CashJournalDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { currentTenant } = useAuthStore();
  const { billAddress, billTaxRegistrationNumber } = usePosSettingsStore();

  const today = new Date().toLocaleDateString('en-CA');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (from > to) { toast.error(t('orders.journalRangeInvalid')); return; }
    setLoading(true);
    try {
      // per_page is capped server-side; ask for the maximum so a busy day is
      // not silently truncated at the default fifty.
      const { data } = await api.get('/bills', { params: { from, to, per_page: 500 } });
      const bills: Bill[] = data.bills ?? data ?? [];
      if (bills.length === 0) { toast.error(t('orders.journalEmpty')); setLoading(false); return; }

      const locale = getCountryByCode(currentTenant?.country ?? 'MA')?.locale ?? 'fr-MA';
      printCashJournal(bills, {
        from, to, locale,
        businessName: currentTenant?.business_name ?? '',
        address: billAddress,
        taxRegistrationNumber: billTaxRegistrationNumber,
        currency: getCurrencySymbol(currentTenant?.currency ?? 'MAD', locale),
      });
      onClose();
    } catch {
      toast.error(t('common.somethingWrong'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{t('orders.cashJournal')}</h2>
          <button onClick={onClose} aria-label={t('common.close')} className="text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('orders.journalFrom')}</span>
            <input type="date" value={from} max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('orders.journalTo')}</span>
            <input type="date" value={to} min={from} max={today}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-brand" />
          </label>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">{t('orders.journalHint')}</p>

        <button onClick={run} disabled={loading}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-40">
          <FileText size={16} />
          {loading ? t('common.loading') : t('orders.printJournal')}
        </button>
      </div>
    </div>
  );
}
