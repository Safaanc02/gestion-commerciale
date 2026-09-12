'use client';

import { useEffect, useState } from 'react';
import { Languages, Printer } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';

/**
 * Teach the receipt printer to write Arabic.
 *
 * A thermal printer cannot be asked which character tables it knows, so this
 * cannot be detected: the shop prints one page showing the same two product
 * names under five settings, reads the line that came out legible, and picks
 * its letter here. One minute at the counter, and 3318 of this shop's 3661
 * products stop printing with an empty or truncated name.
 *
 * It lives in settings rather than in a script because the till is a packaged
 * application on a Windows machine with no repository and no Node beside it.
 */
const CHOICES = [
  { key: 'none', codepage: 'none', charsetId: 0 },
  { key: 'A', codepage: 'cp864', charsetId: 22 },
  { key: 'B', codepage: 'cp864', charsetId: 37 },
  { key: 'C', codepage: 'cp1256', charsetId: 50 },
  { key: 'D', codepage: 'cp1256', charsetId: 22 },
  { key: 'E', codepage: 'cp1256', charsetId: 32 },
] as const;

export default function ArabicPrintingCard() {
  const { t } = useI18n();
  const [choice, setChoice] = useState<string>('none');
  const [printing, setPrinting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/settings/printer_arabic_codepage'),
      api.get('/settings/printer_arabic_charset_id'),
    ])
      .then(([cpRes, idRes]) => {
        const cp = cpRes.data?.setting?.value ?? 'none';
        const id = Number(idRes.data?.setting?.value ?? 22);
        const found = CHOICES.find((c) => c.codepage === cp && c.charsetId === id);
        setChoice(found?.key ?? (cp === 'none' ? 'none' : 'A'));
      })
      .catch(() => { /* leave it at "off", which is the safe state */ });
  }, []);

  const printTest = async () => {
    setPrinting(true);
    try {
      await api.post('/printers/arabic-test');
      toast.success(t('settings.arabicTestSent'));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || t('settings.testPrintFailed'));
    } finally {
      setPrinting(false);
    }
  };

  const save = async (key: string) => {
    const picked = CHOICES.find((c) => c.key === key);
    if (!picked) return;
    setChoice(key);
    setSaving(true);
    try {
      await api.put('/settings/arabic-printing', {
        codepage: picked.codepage,
        charset_id: picked.charsetId,
      });
      toast.success(t('common.saved'));
    } catch {
      toast.error(t('common.somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <Languages size={16} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t('settings.arabicPrinting')}</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{t('settings.arabicPrintingHint')}</p>

      <button
        onClick={printTest}
        disabled={printing}
        className="mb-4 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-40"
      >
        <Printer size={15} />
        {printing ? t('settings.testPrintSending') : t('settings.arabicPrintTest')}
      </button>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('settings.arabicLegibleLine')}</span>
        <select
          value={choice}
          onChange={(e) => void save(e.target.value)}
          disabled={saving}
          className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-brand"
        >
          <option value="none">{t('settings.arabicOff')}</option>
          {CHOICES.filter((c) => c.key !== 'none').map((c) => (
            <option key={c.key} value={c.key}>
              {c.key} — {c.codepage} / {c.charsetId}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
