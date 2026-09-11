'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useCartStore } from '@/store/cart';
import { useI18n } from '@/hooks/useI18n';
import { useScanToCart } from '@/hooks/useScanToCart';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import { WeightPad } from '@/components/pos/WeightPad';
import { ItemPad } from '@/components/pos/ItemPad';
import AddonModal from '@/components/pos/AddonModal';
import type { Category, Product, Addon } from '@/lib/types';

/**
 * Ringing up a sale without leaving the dashboard.
 *
 * A shopkeeper opening the application in the middle of a queue should not have
 * to cross a screen of figures to reach the products. This panel puts the same
 * catalogue, the same scanner and the same cart at the top of the dashboard.
 *
 * It deliberately stops short of taking money. Everything up to the cart is
 * shared code — the grid, the keypads, the cart and its line arithmetic, the
 * server-side scan resolution — but payment, held orders, printing and the
 * retry bookkeeping that keeps a double-tap from charging twice all live on the
 * till screen. A second implementation of that is how a shop ends up billing a
 * customer twice, so the button hands the cart over instead. The cart is a
 * single store shared by both screens, so nothing is re-entered on arrival.
 */
export default function QuickSell({ currency }: { currency: string }) {
  const router = useRouter();
  const cart = useCartStore();
  const { t } = useI18n();

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const [weighProduct, setWeighProduct] = useState<Product | null>(null);
  const [itemPadProduct, setItemPadProduct] = useState<Product | null>(null);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get('/categories?active=1', { signal: controller.signal }),
      api.get('/products?active=1', { signal: controller.signal }),
    ])
      .then(([cats, prods]) => {
        setCategories(cats.data.categories || []);
        setProducts(prods.data.products || []);
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
  }, []);

  // Same decision the till makes, for the same reasons: a product sold by
  // weight has no sensible "1" to add, and a modal is only worth the friction
  // when there is genuinely something to choose.
  const handleProductClick = (product: Product) => {
    if (product.unit_of_measure === 'kg') {
      setWeighProduct(product);
      return;
    }
    if (product.addon_groups && product.addon_groups.length > 0) {
      setAddonProduct(product);
      return;
    }
    setItemPadProduct(product);
  };

  const handleScan = useScanToCart({ products, onProduct: handleProductClick });

  // A keypad already open means the next scan belongs to it, not to the grid.
  const anyPadOpen = !!weighProduct || !!itemPadProduct || !!addonProduct;
  useBarcodeScanner((code) => { void handleScan(code); }, !anyPadOpen);

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.quickSell')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('dashboard.quickSellHint')}</p>
      </div>

      {/* A fixed height, scrolling inside. Left to grow with the catalogue this
          would push the day's figures off the bottom of the screen entirely. */}
      <div className="flex h-[26rem] gap-4 overflow-hidden rounded-lg border border-border bg-muted/40 p-3">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-3 border-brand border-t-transparent" />
            </div>
          ) : (
            <ProductGrid
              categories={categories}
              products={products}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              search={search}
              setSearch={setSearch}
              currency={currency}
              onProductClick={handleProductClick}
              onScan={handleScan}
              sidebarOpen
            />
          )}
        </div>

        <div className="hidden h-full w-80 shrink-0 lg:flex">
          <CartPanel
            tables={[]}
            currency={currency}
            submitting={false}
            onPlaceOrder={() => router.push('/pos')}
            onShowTablePicker={() => {}}
            placeOrderLabel={t('dashboard.quickSellCheckout')}
          />
        </div>
      </div>

      {/* Below the cart's breakpoint the panel has no visible basket, so the
          count and the way through to the till have to be stated outright. */}
      {cart.items.length > 0 && (
        <button
          onClick={() => router.push('/pos')}
          className="mt-3 flex w-full items-center justify-between rounded-lg bg-brand px-4 py-3 text-white transition-colors hover:bg-brand-hover lg:hidden"
        >
          <span className="text-sm font-medium">{t('dashboard.quickSellCheckout')}</span>
          <span className="text-sm font-semibold tabular-nums">{cart.itemCount()}</span>
        </button>
      )}

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currency}
          onAdd={(product: Product, quantity: number, addons: Addon[], instructions: string) => {
            cart.addItem(product, quantity, addons, instructions);
            setAddonProduct(null);
          }}
          onClose={() => setAddonProduct(null)}
        />
      )}

      {itemPadProduct && (
        <ItemPad
          product={itemPadProduct}
          onConfirm={(product: Product, quantity: number, unitPrice: number | null) => {
            cart.addItem(product, quantity, [], '', unitPrice != null ? { unit_price: unitPrice } : undefined);
            setItemPadProduct(null);
          }}
          onScan={handleScan}
          onClose={() => setItemPadProduct(null)}
        />
      )}

      {weighProduct && (
        <WeightPad
          product={weighProduct}
          onConfirm={(product: Product, quantityKg: number) => {
            cart.addItem(product, quantityKg, [], '', { quantity_source: 'manual_weight' });
            setWeighProduct(null);
          }}
          onClose={() => setWeighProduct(null)}
        />
      )}
    </section>
  );
}
