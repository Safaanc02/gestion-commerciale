import type { Bill } from '@/lib/types';

/**
 * The day's takings, one line per sale, on a sheet of A4.
 *
 * This is the document an accountant asks for and a shopkeeper files: forty
 * sales fit on a page, where the same day printed as full invoices runs to
 * twenty. It goes through the Windows printer driver rather than the ESC/POS
 * path, so Arabic needs no code page — the system font shapes it.
 *
 * Every figure comes from the bill as it was settled, never recomputed here. A
 * journal that disagreed with the till by a centime would be worse than no
 * journal, and the arithmetic that produced these totals lives on the server.
 */

export interface JournalOptions {
  from: string;
  to: string;
  businessName: string;
  address?: string;
  taxRegistrationNumber?: string;
  locale: string;
  currency: string;
}

interface PaymentEntry { method?: string; amount?: number }

const METHOD_LABELS: Record<string, string> = {
  cash: 'espèces',
  card: 'carte',
  wallet: 'portefeuille',
  credit: 'crédit',
  cheque: 'chèque',
  bank: 'virement',
};

/**
 * What was tendered, read off the settled bill rather than guessed.
 *
 * The list endpoint already parses this column, so it arrives as an array —
 * but a bill fetched by another path can still carry the raw string, and a
 * journal is not the place to throw on a shape difference.
 */
function methodsOf(bill: Bill): string {
  const raw = bill.payment_details as unknown;
  if (!raw) return '—';
  let entries: PaymentEntry[];
  if (typeof raw === 'string') {
    try { entries = JSON.parse(raw); } catch { return '—'; }
  } else {
    entries = raw as PaymentEntry[];
  }
  if (!Array.isArray(entries)) return '—';
  const names = [...new Set(entries.map((e) => METHOD_LABELS[e.method ?? ''] ?? e.method ?? '—'))];
  return names.join(' + ') || '—';
}

function money(value: number | string, locale: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function time(stamp: string, locale: string): string {
  // The database stores "YYYY-MM-DD HH:MM:SS" in UTC wall form.
  const dt = new Date(String(stamp).replace(' ', 'T') + 'Z');
  return Number.isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function day(stamp: string, locale: string): string {
  const dt = new Date(stamp + 'T00:00:00Z');
  return Number.isNaN(dt.getTime()) ? stamp : dt.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export function generateJournalHtml(bills: Bill[], opts: JournalOptions): string {
  const { locale, currency } = opts;
  const rows = [...bills].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const total = rows.reduce((sum, b) => sum + (Number(b.total) || 0), 0);
  const collected = rows.reduce((sum, b) => sum + (Number(b.paid_amount) || 0), 0);

  const period = opts.from === opts.to
    ? day(opts.from, locale)
    : `${day(opts.from, locale)} — ${day(opts.to, locale)}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Journal de caisse ${escapeHtml(period)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11px; color: #111; }
  header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
  .row { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  h1 { font-size: 16px; letter-spacing: 0.02em; }
  .shop { font-size: 13px; font-weight: bold; }
  .meta { font-size: 10px; color: #444; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #444;
    text-align: left; border-bottom: 1px solid #999; padding: 5px 6px;
  }
  /* A journal runs past one sheet: repeat the header, never split a sale. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  td { padding: 4px 6px; border-bottom: 1px solid #e6e6e6; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { border-top: 2px solid #111; border-bottom: none; padding-top: 8px; font-weight: bold; font-size: 12px; }
  .empty { padding: 28px 0; text-align: center; color: #666; }
  footer { margin-top: 14px; font-size: 9px; color: #666; display: flex; justify-content: space-between; }
</style></head>
<body>
  <header>
    <div class="row">
      <div>
        <h1>JOURNAL DE CAISSE</h1>
        <p class="shop">${escapeHtml(opts.businessName)}</p>
      </div>
      <div class="meta">
        <p><strong>${escapeHtml(period)}</strong></p>
        ${opts.address ? `<p>${escapeHtml(opts.address)}</p>` : ''}
        ${opts.taxRegistrationNumber ? `<p>ICE ${escapeHtml(opts.taxRegistrationNumber)}</p>` : ''}
      </div>
    </div>
  </header>

  ${rows.length === 0 ? '<p class="empty">Aucune vente sur cette période.</p>' : `
  <table>
    <thead>
      <tr>
        <th>N°</th><th>Heure</th><th class="num">Total</th>
        <th class="num">Encaissé</th><th>Paiement</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((b) => `
        <tr>
          <td>${escapeHtml(String(b.bill_number ?? b.id))}</td>
          <td>${escapeHtml(time(String(b.created_at), locale))}</td>
          <td class="num">${money(b.total, locale)}</td>
          <td class="num">${money(b.paid_amount ?? 0, locale)}</td>
          <td>${escapeHtml(methodsOf(b))}</td>
        </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2">${rows.length} vente${rows.length > 1 ? 's' : ''}</td>
        <td class="num">${money(total, locale)} ${escapeHtml(currency)}</td>
        <td class="num">${money(collected, locale)} ${escapeHtml(currency)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>`}

  <footer>
    <span>Édité le ${new Date().toLocaleString(locale)}</span>
    <span>${escapeHtml(opts.businessName)}</span>
  </footer>
</body></html>`;
}

export function printCashJournal(bills: Bill[], opts: JournalOptions): void {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(generateJournalHtml(bills, opts));
  win.document.close();
  win.onload = () => win.print();
}
