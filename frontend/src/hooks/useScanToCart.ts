'use client';

import { useCallback } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useCartStore } from '@/store/cart';
import { useI18n } from '@/hooks/useI18n';
import type { Product } from '@/lib/types';

/**
 * Resolve a scan on the server and put the result straight into the cart.
 *
 * Two things matter at a supermarket till and both are settled here. The lookup
 * does not search a product array fetched when the screen mounted — a product
 * created minutes ago was reported as an unknown barcode until the page was
 * reloaded, and a scale label could never resolve at all. And a successful scan
 * of an ordinary product does not open a modal by itself: opening one unmounts
 * the scanner listener, so the second of two consecutive scans went nowhere,
 * silently. What to do with a resolved product is the caller's decision, passed
 * in as `onProduct`.
 *
 * This lives in one place on purpose. It is the only client-side reading of a
 * weight-embedded label, and a second copy that drifted — a missing rejection
 * reason, a `label_amount` left unset — would silently charge the wrong amount
 * for loose goods. Both the till and the dashboard's quick-sell panel call it.
 */
export function useScanToCart(options: {
  /** Catalogue already on screen, used to enrich the server's lean product row. */
  products: Product[];
  /** Called for an ordinary product — the caller decides between pad, add-ons or a plain add. */
  onProduct: (product: Product) => void;
  /**
   * Called when the code matches nothing.
   *
   * Optional, and the difference matters. The till offers to create the
   * product on the spot, because a barcode nobody has entered yet is an
   * ordinary delivery, not a mistake. Screens that cannot do anything about it
   * leave this unset and get the message instead.
   */
  onUnknown?: (code: string) => void;
}): (code: string) => Promise<boolean> {
  const { products, onProduct, onUnknown } = options;
  const cart = useCartStore();
  const { t } = useI18n();

  return useCallback(async (code: string): Promise<boolean> => {
    try {
      const res = await api.post('/pos/scan', { code });
      const outcome = res.data as {
        kind: 'product' | 'weighed' | 'unknown' | 'rejected';
        product?: Product;
        measure?: { quantity: number; quantity_source: string; amount_source: string; amount: number; scan_raw: string };
        reason?: string;
      };

      if (outcome.kind === 'product' && outcome.product) {
        const full = products.find((p) => String(p.id) === String(outcome.product!.id)) ?? outcome.product;
        onProduct(full);
        return true;
      }

      if (outcome.kind === 'weighed' && outcome.product && outcome.measure) {
        const full = products.find((p) => String(p.id) === String(outcome.product!.id)) ?? outcome.product;
        cart.addItem(full, outcome.measure.quantity, [], '', {
          quantity_source: outcome.measure.quantity_source as never,
          amount_source: outcome.measure.amount_source as never,
          scan_raw: outcome.measure.scan_raw,
          label_amount: outcome.measure.amount_source === 'label_price' ? outcome.measure.amount : null,
        });
        return true;
      }

      if (outcome.kind === 'rejected') {
        const messages: Record<string, string> = {
          'damaged-label': t('pos.scaleLabelDamaged'),
          'truncated-label': t('pos.scaleLabelTruncated'),
          'unknown-plu': t('pos.scaleLabelUnknownItem'),
          'not-sold-by-weight': t('pos.scaleLabelNotWeighed'),
          'bad-format': t('pos.scaleLabelBadFormat'),
          'over-max-quantity': t('pos.weightOverMax', { max: '' }),
          'zero-quantity': t('pos.scaleLabelDamaged'),
          'no-unit-price': t('pos.scaleLabelNotWeighed'),
        };
        toast.error(messages[outcome.reason ?? ''] ?? t('pos.scaleLabelDamaged'));
        return true;
      }

      if (onUnknown) {
        onUnknown(code);
        return true;
      }
      toast.error(t('pos.barcodeNotFound', { code }));
      return false;
    } catch {
      toast.error(t('pos.scanLookupFailed'));
      return false;
    }
  }, [products, onProduct, onUnknown, cart, t]);
}
