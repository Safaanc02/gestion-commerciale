'use client';

import { useState } from 'react';

import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import type { Category, Product } from '@/lib/types';
import { normaliseForSearch } from '@/lib/search-normalise';
import { shelfTint, SHELF_INK } from '@/lib/shelf-colour';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { nameToColor } from '@/lib/image-utils';
import TagBadge from './DietaryBadge';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import { parseDbTimestamp } from '@/lib/utils';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; activeBg: string; activeText: string }> = {
  red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', activeBg: 'bg-red-500', activeText: 'text-white' },
  orange: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', activeBg: 'bg-orange-500', activeText: 'text-white' },
  amber: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', activeBg: 'bg-amber-500', activeText: 'text-white' },
  yellow: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  lime: { bg: 'bg-lime-50', text: 'text-lime-700', border: 'border-lime-200', activeBg: 'bg-lime-500', activeText: 'text-white' },
  green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', activeBg: 'bg-green-500', activeText: 'text-white' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', activeBg: 'bg-emerald-500', activeText: 'text-white' },
  teal: { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200', activeBg: 'bg-teal-500', activeText: 'text-white' },
  cyan: { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', activeBg: 'bg-cyan-500', activeText: 'text-white' },
  sky: { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', activeBg: 'bg-sky-500', activeText: 'text-white' },
  blue: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', activeBg: 'bg-blue-500', activeText: 'text-white' },
  indigo: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', activeBg: 'bg-indigo-500', activeText: 'text-white' },
  violet: { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200', activeBg: 'bg-violet-500', activeText: 'text-white' },
  purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', activeBg: 'bg-purple-500', activeText: 'text-white' },
  fuchsia: { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-200', activeBg: 'bg-fuchsia-500', activeText: 'text-white' },
  pink: { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', activeBg: 'bg-pink-500', activeText: 'text-white' },
  rose: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', activeBg: 'bg-rose-500', activeText: 'text-white' },
};

/**
 * Two letters for a product with no photograph.
 *
 * Taken from the first word that actually starts with a letter: catalogue
 * names routinely begin with a size or a count ("10 Capsules…", "500g …"),
 * and slicing the raw string gave every one of them the same meaningless
 * digits.
 */
function initialsFor(name: string): string {
  const word = (name || '').split(/\s+/).find((w) => /^\p{L}/u.test(w));
  return (word || name || '?').slice(0, 2).toUpperCase();
}

function getCategoryColorClasses(color: string | null | undefined) {
  if (!color) return null;
  return CATEGORY_COLORS[color.toLowerCase()] || null;
}

interface Props {
  categories: Category[];
  products: Product[];
  selectedCategory: number | null;
  setSelectedCategory: (id: number | null) => void;
  search: string;
  setSearch: (s: string) => void;
  currency: string;
  onProductClick: (product: Product) => void;
  /** Resolve a typed or pasted code server-side; resolves true when handled. */
  onScan: (code: string) => Promise<boolean>;
  sidebarOpen?: boolean;
  /** The register puts the shelves in a standing grid of their own. */
  hideCategoryBar?: boolean;
  /** The register carries one search field, at the top of the screen. */
  hideSearch?: boolean;
}

export default function ProductGrid({
  categories, products, selectedCategory, setSelectedCategory,
  search, setSearch, onProductClick, onScan, sidebarOpen = true, hideCategoryBar = false, hideSearch = false,
}: Props) {
  const [page, setPage] = useState(0);
  const cart = useCartStore();
  const { showProductImages } = usePosSettingsStore();
  const { t } = useI18n();
  const fmt = useFormatCurrency();

  // A new shelf or a new search starts at its first page, never mid-list.
  // Adjusted during render rather than in an effect — React's own guidance for
  // resetting state when a prop changes, and the pattern the dashboard uses:
  // an effect here would render the wrong page once before correcting itself.
  const filterKey = `${selectedCategory ?? ''}:${search}`;
  const [syncedFilter, setSyncedFilter] = useState(filterKey);
  if (filterKey !== syncedFilter) {
    setSyncedFilter(filterKey);
    setPage(0);
  }

  const matching = products.filter((p) => {
    const matchCat = !selectedCategory || p.category_id === selectedCategory;
    const matchSearch = !search || normaliseForSearch(p.name).includes(normaliseForSearch(search));
    return matchCat && matchSearch;
  });

  /**
   * How many tiles actually reach the page.
   *
   * The shop's catalogue is 3661 products. Drawn all at once that is north of
   * twenty thousand DOM nodes, and the till spends its time on layout instead
   * of on the scan — the whole screen settles late, not just this grid. Nobody
   * finds a product by scrolling past three thousand either: it is a barcode,
   * a shelf, or a search. So the list is bounded and says what it is holding
   * back, rather than pretending the rest does not exist.
   */
  const PAGE_SIZE = 120;
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const filtered = matching.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div data-testid="pos-product-grid" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <div className="shrink-0 mb-3">
        {!hideSearch && (
        <div className="relative mb-2">
          <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Typed or pasted barcode, not just a scanner — a dedicated
              // action into this field works regardless of typing speed.
              const trimmed = search.trim();
              if (!trimmed) return;
              // Routed through the same server resolution as a scanner read, so
              // a typed scale label works too and neither path can drift from
              // the other. A local products.find() here would silently miss
              // every label and every product added since this screen loaded.
              void onScan(trimmed).then((handled) => {
                if (handled) setSearch('');
              });
            }}
            placeholder={t('pos.searchProducts')}
            className="w-full ps-10 pe-4 py-3 bg-card border border-border rounded-xl focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none transition-colors text-base"
          />
        </div>
        )}
        {!hideCategoryBar && (
        <div className="flex gap-2 pb-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`shrink-0 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              !selectedCategory ? 'bg-brand text-white' : 'bg-card text-foreground/80 border border-border hover:bg-muted/60'
            }`}
          >
            {t('pos.allCategories')}
          </button>
          {categories.filter((cat) => cat.id != null).map((cat) => {
            const colorClasses = getCategoryColorClasses(cat.color);
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`shrink-0 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  isSelected
                    ? colorClasses
                      ? `${colorClasses.activeBg} ${colorClasses.activeText}`
                      : 'bg-brand text-white'
                    : colorClasses
                      ? `${colorClasses.bg} ${colorClasses.text} border ${colorClasses.border} hover:opacity-80`
                      : 'bg-card text-foreground/80 border border-border hover:bg-muted/60'
                }`}
              >
                {cat.name}
              </button>
            );
          })}
        </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
        {/* Sized for fingers, not a mouse pointer.
            The column count now follows the screen rather than the sidebar
            alone: at 768px the previous fixed 4 columns left roughly 51px per
            tile, which is smaller than a fingertip. Tiles are also given a
            minimum height so a one-word product name and a three-line one are
            the same size and the grid does not jump as the cashier scrolls. */}
        <div className={`grid gap-2 grid-cols-3 sm:grid-cols-4 ${
          sidebarOpen
            ? 'lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
            : 'lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7'
        }`}>
          {filtered.map((product) => {
            const inCartQty = cart.items
              .filter((i) => i.product.id === product.id)
              .reduce((sum, i) => sum + i.quantity, 0);
            

            return (
              <div
                key={product.id}
                data-testid="pos-product-card"
                onClick={() => onProductClick(product)}
                className="rounded-lg p-2 min-h-[5.5rem] flex flex-col justify-between border border-black/5 hover:border-brand/50 active:scale-[0.98] hover:shadow-sm transition-all text-start relative group cursor-pointer overflow-hidden select-none"
                style={{ backgroundColor: shelfTint(product.category_id) }}
              >
                {!!product.track_inventory && (
                  <>
                    {product.stock_quantity <= 0 ? (
                      <span className="absolute top-2 start-2 bg-red-100 text-red-700 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-red-200 pointer-events-none">
                        {t('pos.outOfStock')}
                      </span>
                    ) : product.stock_quantity <= (product.low_stock_threshold || 0) ? (
                      <span className="absolute top-2 start-2 bg-orange-100 text-orange-700 text-[10px] font-bold px-2 py-0.5 rounded-full z-10 shadow-sm border border-orange-200 pointer-events-none">
                        {t('pos.lowStock')}
                      </span>
                    ) : null}
                  </>
                )}
                {inCartQty > 0 && (
                  <span className="absolute top-0 end-0 bg-brand text-white text-sm w-8 h-8 rounded-es-xl flex items-center justify-center font-bold z-10">
                    {inCartQty}
                  </span>
                )}

                {showProductImages && (
                  <div className="w-full aspect-square rounded-lg mb-3 relative overflow-hidden">
                    {/* Always-visible background tile — no flash when image loads */}
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ backgroundColor: nameToColor(product.name) }}
                    >
                      <span className="text-2xl font-bold text-white/80">
                        {initialsFor(product.name)}
                      </span>
                    </div>

                    {/* Image overlays the tile when available */}
                    {product.has_image && (
                      <img
                        src={`${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}`}
                        alt={product.name}
                        className="absolute inset-0 w-full h-full object-cover rounded-lg"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}

                    {product.tags && product.tags.length > 0 && (
                      <span className="absolute bottom-1.5 end-1.5 z-10">
                        <TagBadge tag={product.tags[0]} />
                      </span>
                    )}
                  </div>
                )}

                {/* Name then price, with the price given real weight: on a
                    shelf-scanning screen the cashier is confirming an amount,
                    not reading a menu. */}
                <h3 className="font-medium text-xs line-clamp-3 leading-tight" style={{ color: SHELF_INK }}>{product.name}</h3>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-base font-bold tabular-nums" style={{ color: SHELF_INK }}>
                    {fmt(Number(product.price))}
                  </p>
                  <div className="flex items-center gap-1 shrink-0">
                    {!showProductImages && product.tags && product.tags.length > 0 && (
                      <TagBadge tag={product.tags[0]} />
                    )}
                    {product.addon_groups && product.addon_groups.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onProductClick(product);
                        }}
                        className="text-muted-foreground hover:text-muted-foreground transition-colors"
                        title={t('pos.customisable')}
                      >
                        <SlidersHorizontal size={12} />
                      </button>
                    )}
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      </div>

      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            aria-label={t('common.previous')}
            className="rounded-md border border-border bg-card px-4 py-2 text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight size={18} className="rtl:hidden" />
            <ChevronLeft size={18} className="hidden rtl:block" />
          </button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {safePage + 1} / {pageCount}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            aria-label={t('common.next')}
            className="rounded-md border border-border bg-card px-4 py-2 text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft size={18} className="rtl:hidden" />
            <ChevronRight size={18} className="hidden rtl:block" />
          </button>
        </div>
      )}
    </div>
  );
}
