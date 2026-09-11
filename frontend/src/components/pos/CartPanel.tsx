'use client';

import {
  ShoppingCart, UtensilsCrossed, Package, Truck,
  Plus, Minus, Trash2, Pause, MapPin, SquarePen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem, CartItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatQuantity, isWeighed } from '@units';
import { cartLineTotal } from '@/lib/cart-math';
import { getCountryByCode } from '@/lib/countries';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  onShowTablePicker: () => void;
  onEditItem?: (item: CartItem) => void;
  variant?: 'sidebar' | 'drawer';
  existingOrder?: Order | null;
  /**
   * Overrides the primary button's text. The dashboard's quick-sell panel
   * builds the same cart but does not take payment — its button hands over to
   * the till instead, and must not claim to be placing the order.
   */
  placeOrderLabel?: string;
}

const orderTypeIcons = {
  dine_in: UtensilsCrossed,
  takeaway: Package,
  delivery: Truck,
};

export default function CartPanel({ tables, submitting, onPlaceOrder, onEditItem, variant = 'sidebar', existingOrder, placeOrderLabel }: Props) {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { currentTenant } = useAuthStore();
  // Weights follow the store's locale so "0,734 kg" reads the way the scale
  // label prints it rather than switching to a decimal point.
  const locale = getCountryByCode(currentTenant?.country ?? '')?.locale ?? 'fr-MA';
  const billingType = usePosSettingsStore((s) => s.billingType);
  const { t } = useI18n();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const fmt = useFormatCurrency();

  // Shared with the register's cart table — see lib/cart-math.
  const lineTotal = cartLineTotal;
  const canHold = isRestaurant && cart.orderType === 'dine_in' && cart.tableId && cart.items.length > 0 && billingType === 'postpaid';

  const handleHold = async () => {
    if (!cart.tableId) {
      toast.error(t('pos.selectTableFirst'));
      return;
    }
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
    try {
      await heldOrders.holdOrder(cart.tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      toast.success(t('pos.orderHeldFor', { table: tableName }));
    } catch (err: unknown) {
      const e = err as Error;
      toast.error(e.message || t('pos.holdOrderFailed'));
    }
  };

  const isDrawer = variant === 'drawer';

  return (
    <div className={
      isDrawer
        ? 'flex flex-col w-full'
        : 'w-full h-full bg-card rounded-xl border border-border flex flex-col shadow-sm'
    }>
      {/* Order type — restaurants only.
          A grocery has exactly one mode: the customer is at the counter and
          leaves with the goods. There is nothing to choose between, and the
          shop does not deliver, so the row of tabs was three-quarters dead
          space above every basket. */}
      {isRestaurant && (
      <div className="p-4 border-b border-border space-y-2">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {(['dine_in', 'takeaway', 'delivery'] as const)
            .filter((type) => isRestaurant || type !== 'dine_in')
            .map((type) => {
              const Icon = orderTypeIcons[type];
              const label = type === 'dine_in' ? t('pos.orderTypeDineIn') : type === 'takeaway' ? t('pos.orderTypeTakeaway') : t('pos.orderTypeDelivery');
              return (
                <button
                  key={type}
                  onClick={() => cart.setOrderType(type)}
                  className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-md text-xs font-medium transition-colors ${
                    cart.orderType === type
                      ? 'bg-card text-brand shadow-sm'
                      : 'text-muted-foreground hover:text-foreground/80'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
        </div>

        {/* Delivery address — shown inline when delivery is selected */}
        {cart.orderType === 'delivery' && (
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              value={cart.deliveryAddress}
              onChange={(e) => cart.setDeliveryAddress(e.target.value)}
              placeholder={t('pos.deliveryAddress')}
              className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        )}
      </div>
      )}

      {/* Cart Items */}
      <div className={isDrawer ? 'overflow-y-auto p-4 max-h-[40vh]' : 'flex-1 overflow-y-auto p-4'}>
        {/* Previously ordered items (add-items mode) */}
        {existingOrder && existingOrder.items && existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').length > 0 && (
          <div className="mb-3 pb-3 border-b border-dashed border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('pos.alreadyOrdered')}</p>
            <div className="space-y-1.5">
              {existingOrder.items.filter((i: OrderItem) => i.status !== 'cancelled').map((item: OrderItem) => (
                <div key={item.id} className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">{item.quantity}× {item.product_name}</span>
                  <span className="text-xs text-muted-foreground">{fmt(Number(item.total))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {cart.items.length === 0 ? (
          <div className={`flex flex-col items-center justify-center text-muted-foreground ${existingOrder ? 'py-4' : isDrawer ? 'py-8' : 'h-full'}`}>
            <ShoppingCart size={existingOrder ? 24 : 40} />
            <p className="mt-2 text-sm">{existingOrder ? t('pos.addNewItemsAbove') : t('pos.cartEmpty')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <button
                  onClick={() => cart.removeItem(item.id)}
                  className="w-6 h-6 rounded-full text-muted-foreground/50 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors mt-0.5 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {item.product.name}
                    </p>
                    {onEditItem && (
                      <button
                        onClick={() => onEditItem(item)}
                        className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 text-xs font-medium transition-colors"
                      >
                        <SquarePen size={12} />
                        {t('common.edit')}
                      </button>
                    )}
                  </div>
                  {item.addons.length > 0 && (
                    <div className="mt-0.5">
                      {item.addons.map((a) => (
                        <p key={a.id} className="text-xs text-muted-foreground">
                          + {a.name}{(a.quantity || 1) > 1 ? ` ×${a.quantity}` : ''} {Number(a.price) > 0 && `(${fmt(Number(a.price) * (a.quantity || 1))})`}
                        </p>
                      ))}
                    </div>
                  )}
                  {item.special_instructions && (
                    <p className="text-xs text-muted-foreground italic mt-0.5 break-words">{item.special_instructions}</p>
                  )}
                  {/* Weighed lines show how the amount was reached, because
                      that is what a customer questions at the till: the weight,
                      the price per kilo, and the resulting total. */}
                  {isWeighed(item.unit_of_measure ?? item.product.unit_of_measure) ? (
                    <p className="text-sm text-muted-foreground">
                      {formatQuantity(item.quantity, 'kg', locale, item.product.quantity_precision ?? 3)}
                      {' × '}{fmt(Number(item.product.price))}{t('pos.perKg')}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {item.unit_price != null ? (
                        <>
                          {/* A keyed price is called out: the cashier changed it
                              deliberately and the customer may ask why. */}
                          <span className="font-medium text-amber-700">{fmt(item.unit_price)}</span>
                          <span className="ms-1 text-xs text-muted-foreground line-through">
                            {fmt(Number(item.product.price))}
                          </span>
                        </>
                      ) : (
                        fmt(Number(item.product.price))
                      )}
                    </p>
                  )}
                </div>

                {/* The line total, which the cart never used to show. It is the
                    single number a customer points at — "how much is that
                    one?" — and without it the cashier had to do the sum in
                    their head or read the whole basket back. */}
                <div className="shrink-0 text-end">
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {fmt(lineTotal(item))}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isWeighed(item.unit_of_measure ?? item.product.unit_of_measure) ? (
                    // No +/- stepper: it only moves in whole units, which is
                    // meaningless for a weight. Tapping reopens the keypad.
                    <button
                      onClick={() => onEditItem?.(item)}
                      aria-label={t('pos.weighByWeight')}
                      className="h-11 min-w-[4.5rem] rounded-lg bg-muted px-3 text-sm font-medium tabular-nums hover:bg-muted transition-colors"
                    >
                      {formatQuantity(item.quantity, 'kg', locale, item.product.quantity_precision ?? 3)}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => cart.updateQuantity(item.id, item.quantity - 1)}
                        className="w-11 h-11 rounded-full bg-muted flex items-center justify-center hover:bg-muted transition-colors"
                      >
                        <Minus size={16} />
                      </button>
                      <span className="text-sm font-medium w-6 text-center tabular-nums">{item.quantity}</span>
                      <button
                        onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                        className="w-11 h-11 rounded-full bg-muted flex items-center justify-center hover:bg-muted transition-colors"
                      >
                        <Plus size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart Footer */}
      <div className="p-4 border-t border-border">
        {/* No order note. A restaurant writes "no onions" against a ticket; a
            grocery rings up a basket with a queue behind it, and the box sat
            between the basket and the confirm button on every single sale.
            cart.orderNotes stays in the store — held orders and the order
            payload still carry the field, now always empty. */}
        <div className="flex justify-between mb-1 text-sm">
          <span className="text-muted-foreground">{t('pos.items')}</span>
          <span className="font-medium">{cart.itemCount()}</span>
        </div>
        {/* The total is the number the cashier reads out loud and the customer
            checks against their change. It was the same size as the item
            count above it; on a screen viewed at arm's length that is not
            enough to find at a glance. */}
        <div className="mb-4 flex items-baseline justify-between rounded-xl bg-brand/5 px-3 py-3">
          <span className="text-base font-semibold text-foreground">{t('pos.subtotal')}</span>
          <span className="text-3xl font-bold tabular-nums text-brand">
            {fmt(cart.subtotal())}
          </span>
        </div>
        <div className="flex gap-2">
          {canHold && (
            <Button variant="outline" onClick={handleHold} className="flex-1">
              <Pause size={14} className="mr-1" /> {t('pos.holdButton')}
            </Button>
          )}
          {/* The most important target on the screen, and it was the same
              height as the buttons beside it. */}
          <Button
            onClick={onPlaceOrder}
            disabled={submitting || cart.items.length === 0}
            className="h-14 flex-1 text-base font-semibold"
            size="lg"
          >
            {submitting ? t('pos.placing') : (placeOrderLabel ?? t('pos.placeOrderButton'))}
          </Button>
        </div>
      </div>
    </div>
  );
}
