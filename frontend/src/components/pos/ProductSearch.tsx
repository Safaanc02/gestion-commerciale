'use client';

import { useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Product } from '@/lib/types';
import { normaliseForSearch } from '@/lib/search-normalise';

/**
 * Find a product by typing, at the top of the register.
 *
 * The grid below is for browsing a shelf; this is for the cashier who knows
 * what they want. Three letters and the answer is under the cursor, instead of
 * a shelf to pick and three thousand tiles to scan with the eye.
 *
 * It is also where a scanner's keystrokes land, because the field holds focus
 * and the scanner types like a keyboard. That is why Enter goes to the server
 * resolver rather than to the local list: a scale label carries a weight the
 * catalogue cannot answer, and a product created minutes ago is not in the
 * array this screen loaded with. The typed-text path and the scanned path are
 * the same path.
 */
const MAX_RESULTS = 8;

export default function ProductSearch({
  products, search, setSearch, onPick, onScan,
}: {
  products: Product[];
  search: string;
  setSearch: (s: string) => void;
  onPick: (product: Product) => void;
  onScan: (code: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);

  const needle = normaliseForSearch(search);
  const matches = useMemo(() => {
    if (needle.length < 2) return [];
    // A digit run is a code being scanned or keyed, not a name — showing name
    // matches for it would put a list under the cashier's hand at the exact
    // moment the server is about to answer.
    if (/^\d{4,}$/.test(needle)) return [];
    return products
      .filter((p) => normaliseForSearch(p.name).includes(needle))
      .slice(0, MAX_RESULTS);
  }, [products, needle]);

  const choose = (product: Product) => {
    onPick(product);
    setSearch('');
    setHighlight(0);
    inputRef.current?.focus();
  };

  return (
    <div className="relative flex-1 min-w-0">
      <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        // Held by default so a scan needs no click first, and so the cashier
        // can simply start typing.
        autoFocus
        type="text"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setHighlight(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return; }
          if (e.key === 'Escape') { setSearch(''); return; }
          if (e.key !== 'Enter') return;

          // A highlighted name wins; otherwise the text is a code and the
          // server decides what it is.
          if (matches.length > 0) { choose(matches[highlight] ?? matches[0]); return; }
          const trimmed = search.trim();
          if (!trimmed) return;
          void onScan(trimmed).then((handled) => { if (handled) setSearch(''); });
        }}
        placeholder={t('pos.searchProducts')}
        className="w-full ps-10 pe-10 py-2.5 bg-card border border-border rounded-lg outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20"
      />

      {search && (
        <button
          onClick={() => { setSearch(''); inputRef.current?.focus(); }}
          aria-label={t('common.clear')}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>
      )}

      {matches.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          {matches.map((product, i) => (
            <li key={product.id}>
              <button
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(product)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start transition-colors ${
                  i === highlight ? 'bg-brand/10' : 'hover:bg-muted'
                }`}
              >
                <span className="min-w-0 truncate text-sm text-foreground">{product.name}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-brand">
                  {fmt(Number(product.price))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
