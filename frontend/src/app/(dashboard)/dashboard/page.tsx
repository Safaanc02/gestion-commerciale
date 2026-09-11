'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { TrendingUp, ClipboardList, ArrowRight, Tags, BarChart3, Wallet } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import { formatQuantity } from '@units';
import QuickSell from '@/components/pos/QuickSell';
import { getCurrencySymbol } from '@/lib/countries';

interface PaymentMethodBreakdown {
  method: string | null;
  count: number;
  total: number;
}

interface DailyStats {
  sales: number;
  ticketsToday: number;
  lowStockCount: number;
  paymentMethods: PaymentMethodBreakdown[];
}

interface DaySummary {
  date: string;
  orders: { count: number; total: number };
  bills: { count: number; total: number; collected: number };
  customers: { new: number };
  paymentMethods: PaymentMethodBreakdown[];
}

interface TopProduct {
  product_id: number;
  product_name: string;
  total_units: number;
  total_kg: number;
  total_revenue: number;
  order_count: number;
}

interface RecentOrder {
  id: number;
  order_number: string;
  status: string;
  total: number;
  customer_name: string | null;
  table_name: string | null;
  created_at: string;
}

interface TopStaff {
  user_id: string;
  name: string;
  role: string;
  revenue: number;
  orderCount: number;
}

interface TopCategory {
  category_id: string | null;
  name: string;
  quantity: number;
  revenue: number;
}

interface HourBucket {
  hour: number;
  orderCount: number;
}

interface DayBucket {
  dayIndex: number;
  orderCount: number;
}

interface Insights {
  windowDays: number;
  aov: number;
  avgPrepTimeMinutes: number | null;
  topStaff: TopStaff[];
  topCategories: TopCategory[];
  busiestHour: HourBucket | null;
  idlestHour: HourBucket | null;
  busiestDayOfWeek: DayBucket | null;
  idlestDayOfWeek: DayBucket | null;
}

/** Today's date as YYYY-MM-DD in a given IANA timezone (not UTC — avoids an
 *  off-by-one-day default near midnight relative to the tenant's locale). */
function getLocalDateString(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD by convention — a convenient built-in shortcut.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Formats a 0-23 local hour index as a locale-appropriate time label (e.g. "2 PM"). */
function formatHourLabel(hour: number, locale: string): string {
  const reference = new Date(Date.UTC(2000, 0, 1, hour));
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(reference);
}

/** Formats a 0=Sunday..6=Saturday index as a locale-appropriate weekday name. */
function formatWeekdayLabel(dayIndex: number, locale: string): string {
  // Jan 2, 2000 was a Sunday — using local-time Date math (no timeZone
  // needed here, the hour/day bucketing already resolved to the tenant's
  // local calendar server-side).
  const reference = new Date(2000, 0, 2 + dayIndex);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(reference);
}

const orderStatusColor: Record<string, string> = {
  pending: 'text-yellow-600',
  preparing: 'text-blue-600',
  ready: 'text-green-600',
  served: 'text-purple-600',
  completed: 'text-muted-foreground',
  cancelled: 'text-red-500',
};

function localizeTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? `{${k}}`));
}

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const isOwner = currentTenant?.role === 'owner';
  const fmt = useFormatCurrency();
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const currency = getCurrencySymbol(currentTenant?.currency || 'MAD', locale);
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayLocal = getLocalDateString(new Date(), timeZone);
  const [selectedDate, setSelectedDate] = useState(todayLocal);
  const isToday = selectedDate === todayLocal;

  useEffect(() => {
    if (currentTenant && !isOwner) {
      router.replace('/pos');
    }
  }, [currentTenant, isOwner, router]);

  // Show the spinner again as soon as isOwner/selectedDate change, read directly during
  // render (React's recommended pattern for "adjusting state when a prop changes") so the
  // effect below only needs to own the async fetch and its own completion state.
  const syncKey = `${isOwner}:${selectedDate}`;
  const [syncedKey, setSyncedKey] = useState(syncKey);
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    if (isOwner) setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    Promise.all([
      isToday ? api.get('/reports/daily-stats', { signal: controller.signal }) : api.get('/reports/summary', { params: { date: selectedDate }, signal: controller.signal }),
      api.get('/reports/topProducts', { params: { start_date: selectedDate, end_date: selectedDate, limit: 5 }, signal: controller.signal }),
      api.get('/reports/recentOrders', { params: { date: selectedDate, limit: 6 }, signal: controller.signal }),
      api.get('/reports/insights', { params: { days: 30 }, signal: controller.signal }),
    ])
      .then(([statsRes, topRes, recentRes, insightsRes]) => {
        setStats(isToday ? statsRes.data : null);
        setDaySummary(isToday ? null : statsRes.data.summary);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
        setInsights(insightsRes.data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        toast.error(t('common.somethingWrong'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, selectedDate]);

  if (!isOwner) return null;

  const paymentMethods = isToday ? (stats?.paymentMethods ?? []) : (daySummary?.paymentMethods ?? []);
  const paymentMethodsTotal = paymentMethods.reduce((sum, pm) => sum + Number(pm.total), 0);

  // Running/Pending Orders and Tables Occupied are live, "right now" concepts
  // that don't retroactively apply to a past date (an order isn't "pending"
  // in history — it has a final status). When viewing a past date, swap them
  // for the day's actual totals from /reports/summary instead.
  // A grocery has no order in progress and no occupied table. What replaces
  // them is what a shopkeeper actually looks at first: how many tickets were
  // rung up, and what is about to run out.
  /**
   * How much of a product was sold.
   *
   * Units and kilos are reported separately by the API because adding 0.734 kg
   * of lentils to 3 tins gives a number that means nothing. A product is
   * normally one or the other, so only the side that has any is shown.
   */
  const soldLabel = (units: number, kg: number, orders: number) => {
    const parts: string[] = [];
    if (Number(units) > 0) parts.push(localizeTemplate(t('dashboard.soldUnits'), { quantity: units }));
    if (Number(kg) > 0) parts.push(formatQuantity(Number(kg), 'kg', locale, 3));
    if (parts.length === 0) parts.push(localizeTemplate(t('dashboard.soldUnits'), { quantity: 0 }));
    return `${parts.join(' · ')} — ${localizeTemplate(t('dashboard.inOrders'), { orders })}`;
  };



  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-foreground">{t('dashboard.title')}</h1>
        <input
          type="date"
          value={selectedDate}
          max={todayLocal}
          onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
          className="px-3 py-1.5 text-sm border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30"
          aria-label={t('dashboard.selectDate')}
        />
      </div>

      <QuickSell currency={currency} />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-3 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Recent Orders */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <ClipboardList size={16} className="text-muted-foreground" />
                  {isToday ? t('dashboard.recentOrders') : t('dashboard.orders')}
                </h2>
                <Link href="/orders" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('dashboard.viewAll')} <ArrowRight size={12} />
                </Link>
              </div>
              {recentOrders.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">{t('dashboard.noOrdersYet')}</p>
              ) : (
                <div className="divide-y divide-border">
                  {recentOrders.map((order) => (
                    <Link
                      key={order.id}
                      href="/orders"
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/50 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">#{order.order_number}</span>
                          <span className={`text-xs font-medium ${orderStatusColor[order.status] || 'text-muted-foreground'}`}>
                            {t(`orders.${order.status}` as 'orders.pending' | 'orders.preparing' | 'orders.ready' | 'orders.served' | 'orders.completed' | 'orders.cancelled')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {order.customer_name || order.table_name || t('dashboard.walkIn')}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(order.total))}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Top Products Today */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <TrendingUp size={16} className="text-muted-foreground" />
                  {t('dashboard.topProductsToday')}
                </h2>
                <Link href="/products" className="flex items-center gap-1 text-xs text-brand hover:text-brand-hover font-medium">
                  {t('dashboard.viewAll')} <ArrowRight size={12} />
                </Link>
              </div>
              {topProducts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">{t('dashboard.noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-border">
                  {topProducts.map((product) => (
                    <div key={product.product_id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{product.product_name}</span>
                        <p className="text-xs text-muted-foreground">{soldLabel(product.total_units, product.total_kg, product.order_count)}</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(product.total_revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            {/* The "top staff" card is gone with the Staff screen: a shop run
                from one account ranks one person against nobody, and its
                "view all" link pointed at a page that is no longer reachable.
                Payment methods took the seat it left, so this stays a pair —
                one card in a two-column grid left half the page blank. */}
            {/* Top Categories */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <Tags size={16} className="text-muted-foreground" />
                  {t('dashboard.topCategories')}
                </h2>
              </div>
              {(insights?.topCategories.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">{t('dashboard.noSalesYet')}</p>
              ) : (
                <div className="divide-y divide-border">
                  {insights!.topCategories.map((category) => (
                    <div key={category.category_id ?? category.name} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{category.name}</span>
                        <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.categoryQuantitySold'), { quantity: category.quantity })}</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground shrink-0">
                        {fmt(Number(category.revenue))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Payment Methods */}
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 mb-4">
                <Wallet size={16} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('dashboard.paymentMethods')}</h2>
              </div>
              {paymentMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t('dashboard.noPaymentsYet')}</p>
              ) : (
                <div className="space-y-3">
                  {paymentMethods.map((pm) => {
                    const meta = PAYMENT_METHOD_LABELS.find((m) => m.key === pm.method);
                    const Icon = meta?.icon ?? Wallet;
                    const label = meta ? t(meta.labelKey) : t('pos.methodWallet');
                    const percent = paymentMethodsTotal > 0 ? Math.round((Number(pm.total) / paymentMethodsTotal) * 100) : 0;
                    return (
                      <div key={pm.method ?? 'unknown'}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <Icon size={14} className="text-muted-foreground" />
                            <span className="text-sm font-medium text-foreground">{label}</span>
                          </div>
                          <span className="text-sm font-semibold text-foreground">{fmt(Number(pm.total))}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-brand rounded-full" style={{ width: `${percent}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {localizeTemplate(t('dashboard.paymentMethodCount'), { count: pm.count, percent })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Business Patterns */}
          <div className="bg-card rounded-xl border border-border p-4 mt-4">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 size={16} className="text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('dashboard.businessPatterns')}</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              {localizeTemplate(t('dashboard.businessPatternsHint'), { days: insights?.windowDays ?? 30 })}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('dashboard.busiestHour')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.busiestHour ? formatHourLabel(insights.busiestHour.hour, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.busiestHour && (
                  <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('dashboard.idlestHour')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.idlestHour ? formatHourLabel(insights.idlestHour.hour, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.idlestHour && (
                  <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestHour.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('dashboard.busiestDay')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.busiestDayOfWeek ? formatWeekdayLabel(insights.busiestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.busiestDayOfWeek && (
                  <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestDayOfWeek.orderCount })}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('dashboard.idlestDay')}</p>
                <p className="text-lg font-bold text-foreground">
                  {insights?.idlestDayOfWeek ? formatWeekdayLabel(insights.idlestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')}
                </p>
                {insights?.idlestDayOfWeek && (
                  <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestDayOfWeek.orderCount })}</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
