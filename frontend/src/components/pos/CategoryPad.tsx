'use client';

import { useI18n } from '@/hooks/useI18n';
import type { Category } from '@/lib/types';
import { shelfTint, SHELF_INK } from '@/lib/shelf-colour';

/**
 * The shelves, as a standing grid rather than a scrolling strip.
 *
 * Two columns, always on screen, in the shop's own order. The cashier's hand
 * learns where a shelf sits and stops reading the labels — which is the whole
 * reason the till they already use puts them here. A strip that scrolls
 * horizontally moves the targets and defeats that.
 */
export default function CategoryPad({
  categories, selected, onSelect,
}: {
  categories: Category[];
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('pos.categories')}
      </div>
      <div className="grid flex-1 auto-rows-min grid-cols-2 gap-1 overflow-y-auto p-1">
        <button
          onClick={() => onSelect(null)}
          className={`col-span-2 rounded px-2 py-2.5 text-sm font-medium transition-colors ${
            selected === null
              ? 'bg-brand text-white'
              : 'bg-muted text-foreground hover:bg-muted/70'
          }`}
        >
          {t('pos.allCategories')}
        </button>
        {categories.filter((c) => c.id != null).map((cat) => (
          <button
            key={cat.id}
            onClick={() => onSelect(cat.id)}
            title={cat.name}
            // The button wears the colour of the products it reveals, so the
            // link between the two is visible rather than remembered.
            //
            // Selection is marked by an outline and weight, not by swapping
            // the colour out: turning the current shelf green would break the
            // one association the colour exists to make, at the exact moment
            // the cashier is using it.
            //
            // Two lines, then clipped. A shelf name that wraps to four lines
            // would push every button below it out of reach.
            style={{ backgroundColor: shelfTint(cat.id), color: SHELF_INK }}
            className={`min-h-[3rem] rounded px-1.5 py-1.5 text-xs leading-tight transition-shadow line-clamp-2 ${
              selected === cat.id
                ? 'font-bold ring-2 ring-inset ring-[color:var(--sidebar)] shadow-sm'
                : 'font-medium hover:shadow-sm'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>
    </div>
  );
}
