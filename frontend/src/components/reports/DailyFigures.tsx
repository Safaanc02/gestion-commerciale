'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Banknote, PackageSearch, Receipt, TrendingUp } from 'lucide-react';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

/**
 * Today's four figures, as one band.
 *
 * It sits above the sales rather than on the dashboard, because that is where
 * it is read: a shopkeeper checking the day's takings is already looking at
 * the day's sales, and keeping the summary on a different screen from the list
 * it summarises meant crossing the application to reconcile them.
 *
 * It fetches its own figures so it can be moved without dragging the
 * dashboard's data loading behind it, and fails quietly: a band of dashes is
 * better than an error over a screen whose actual job — listing sales — is
 * working perfectly well.
 */
interface DailyStats {
  sales: number;
  ticketsToday: number;
  lowStockCount: number;
}

export default function DailyFigures() {
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [aov, setAov] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get('/reports/daily-stats', { signal: controller.signal }),
      api.get('/reports/insights', { params: { days: 30 }, signal: controller.signal }),
    ])
      .then(([daily, insights]) => {
        setStats(daily.data);
        setAov(Number(insights.data?.aov ?? 0));
      })
      .catch(() => { /* the band stays empty; the sales list is unaffected */ });
    return () => controller.abort();
  }, []);

  const tiles = [
    { label: t('dashboard.todaySales'), value: stats ? fmt(stats.sales) : '—', icon: Banknote, href: '/orders', lead: true },
    { label: t('dashboard.ticketsToday'), value: stats ? String(stats.ticketsToday) : '—', icon: Receipt, href: '/orders', lead: false },
    { label: t('dashboard.lowStock'), value: stats ? String(stats.lowStockCount) : '—', icon: PackageSearch, href: '/products', lead: false },
    { label: t('dashboard.aov'), value: aov === null ? '—' : fmt(aov), icon: TrendingUp, href: '/orders', lead: false },
  ];

  return (
    <div className="mb-4 grid shrink-0 grid-cols-2 divide-y divide-border overflow-hidden rounded-lg border border-border lg:grid-cols-4 lg:divide-y-0 lg:divide-x">
      {tiles.map((tile) => (
        <Link key={tile.label} href={tile.href} className="flex flex-col gap-2 p-4 transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-2">
            <tile.icon size={15} strokeWidth={1.75} className={`shrink-0 ${tile.lead ? 'text-brand' : 'text-muted-foreground'}`} />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</span>
          </div>
          <p className={`font-bold tabular-nums leading-none ${tile.lead ? 'text-2xl text-brand' : 'text-xl text-foreground'}`}>
            {tile.value}
          </p>
        </Link>
      ))}
    </div>
  );
}
