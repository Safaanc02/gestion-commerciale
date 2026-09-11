import { create } from 'zustand';
import type { Customer, Product, Addon, CartItem } from '@/lib/types';
import { isWeighed, roundMoney } from '@units';

/** Everything a weighed line needs beyond a plain product and a count. */
export interface WeighedLineInput {
  /** Price keyed at the till, when it differs from the catalogue. */
  unit_price?: number | null;
  quantity_source?: CartItem['quantity_source'];
  amount_source?: CartItem['amount_source'];
  scan_raw?: string | null;
  label_amount?: number | null;
}

interface CartState {
  items: CartItem[];
  orderType: 'dine_in' | 'takeaway' | 'delivery';
  /** What a fresh basket starts as. A grocery has one mode and never picks. */
  defaultOrderType: 'dine_in' | 'takeaway' | 'delivery';
  tableId: string | null;
  customerId: number | string | null;
  customer: Customer | null;
  guestCount: number;
  deliveryAddress: string;
  orderNotes: string;

  addItem: (product: Product, quantity?: number, addons?: Addon[], specialInstructions?: string, weighed?: WeighedLineInput) => void;
  updateItemDetails: (cartItemId: string, quantity: number, addons: Addon[], specialInstructions: string) => void;
  removeItem: (cartItemId: string) => void;
  updateQuantity: (cartItemId: string, quantity: number) => void;
  clearCart: () => void;
  loadItems: (items: CartItem[], tableId: string | null, customerId: number | string | null, guestCount: number, orderNotes?: string) => void;
  setOrderType: (type: CartState['orderType']) => void;
  setDefaultOrderType: (type: CartState['orderType']) => void;
  setTableId: (id: string | null) => void;
  setCustomerId: (id: number | string | null) => void;
  setCustomer: (customer: Customer | null) => void;
  setGuestCount: (count: number) => void;
  setDeliveryAddress: (address: string) => void;
  setOrderNotes: (notes: string) => void;

  subtotal: () => number;
  itemCount: () => number;
}

/**
 * Distinguishes one weighing from the next.
 *
 * Countable lines merge by configuration — scanning the same tin twice should
 * read "2 x tin". Weighed lines must NOT: two bags of lentils at 0.734 kg and
 * 1.2 kg are separate physical bags, each with its own label, and collapsing
 * them into one 1.934 kg line destroys the link between a bag and its sticker
 * and makes a single mis-weighed bag impossible to remove on its own.
 */
let weighedLineSequence = 0;

function generateCartItemId(
  productId: number | string,
  addons: Addon[],
  specialInstructions: string,
  weighed = false,
): string {
  const parts = [String(productId)];
  if (weighed) parts.push(`w${++weighedLineSequence}`);
  if (addons.length > 0) {
    const addonStr = [...addons]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((a) => `${a.id}:${a.quantity || 1}`)
      .join(',');
    parts.push(addonStr);
  }
  if (specialInstructions) {
    parts.push(specialInstructions);
  }
  return parts.join('-');
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  orderType: 'dine_in',
  defaultOrderType: 'dine_in',
  tableId: null,
  customerId: null,
  customer: null,
  guestCount: 1,
  deliveryAddress: '',
  orderNotes: '',

  addItem: (product, quantity = 1, addons = [], specialInstructions = '', weighed) => {
    const items = get().items;
    const byWeight = isWeighed(product.unit_of_measure);
    const itemId = generateCartItemId(product.id, addons, specialInstructions, byWeight);
    const existing = byWeight ? undefined : items.find((i) => i.id === itemId);

    const line: CartItem = {
      id: itemId,
      product,
      quantity,
      addons,
      special_instructions: specialInstructions,
      unit_of_measure: byWeight ? 'kg' : 'unit',
      quantity_source: weighed?.quantity_source ?? (byWeight ? 'manual_weight' : 'unit'),
      amount_source: weighed?.amount_source ?? 'computed',
      scan_raw: weighed?.scan_raw ?? null,
      label_amount: weighed?.label_amount ?? null,
      unit_price: weighed?.unit_price ?? null,
    };

    if (existing) {
      set({
        items: items.map((i) =>
          i.id === itemId ? { ...i, quantity: i.quantity + quantity } : i
        ),
      });
    } else {
      set({ items: [...items, line] });
    }
  },

  updateItemDetails: (cartItemId, quantity, addons, specialInstructions) => {
    const items = get().items;
    const target = items.find((i) => i.id === cartItemId);
    if (!target) return;

    // A weighed line keeps its identity: it stands for one physical bag with
    // one label, so editing it must never merge it into another line.
    if (isWeighed(target.unit_of_measure ?? target.product?.unit_of_measure)) {
      set({
        items: items.map((i) =>
          i.id === cartItemId ? { ...i, quantity, addons, special_instructions: specialInstructions } : i
        ),
      });
      return;
    }

    const newId = generateCartItemId(target.product.id, addons, specialInstructions);
    if (newId === cartItemId) {
      set({
        items: items.map((i) =>
          i.id === cartItemId ? { ...i, quantity, addons, special_instructions: specialInstructions } : i
        ),
      });
      return;
    }

    // The edit produced a config that matches another existing line — merge into it.
    const collision = items.find((i) => i.id === newId && i.id !== cartItemId);
    if (collision) {
      set({
        items: items
          .filter((i) => i.id !== cartItemId)
          .map((i) => (i.id === newId ? { ...i, quantity: i.quantity + quantity } : i)),
      });
    } else {
      set({
        items: items.map((i) =>
          i.id === cartItemId ? { ...i, id: newId, quantity, addons, special_instructions: specialInstructions } : i
        ),
      });
    }
  },

  removeItem: (cartItemId) => {
    set({ items: get().items.filter((i) => i.id !== cartItemId) });
  },

  updateQuantity: (cartItemId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(cartItemId);
      return;
    }
    set({
      items: get().items.map((i) =>
        i.id === cartItemId ? { ...i, quantity } : i
      ),
    });
  },

  clearCart: () => {
    set((state) => ({ items: [], tableId: null, customerId: null, customer: null, guestCount: 1, orderType: state.defaultOrderType, deliveryAddress: '', orderNotes: '' }));
  },

  loadItems: (items, tableId, customerId, guestCount, orderNotes) => {
    set({ items, tableId, customerId, guestCount, orderNotes: orderNotes || '' });
  },

  setOrderType: (type) => set((state) => ({ orderType: type, deliveryAddress: type !== 'delivery' ? '' : state.deliveryAddress })),
  setDefaultOrderType: (type) => set((state) => ({
    defaultOrderType: type,
    // An empty basket adopts it straight away; a basket in progress is left alone.
    orderType: state.items.length === 0 ? type : state.orderType,
  })),
  setTableId: (id) => set({ tableId: id }),
  setCustomerId: (id) => set({ customerId: id }),
  setCustomer: (customer) => set({ customer, customerId: customer?.id ?? null }),
  setGuestCount: (count) => set({ guestCount: count }),
  setDeliveryAddress: (address) => set({ deliveryAddress: address }),
  setOrderNotes: (notes) => set({ orderNotes: notes }),

  // Mirrors computeLineSubtotal in main/routes/orders.ts, using the shared
  // rounding from @units so the amount shown on screen is the one the server
  // writes. An add-on is countable, so it is never scaled by a weight.
  subtotal: () => {
    return roundMoney(get().items.reduce((sum, item) => {
      const byWeight = isWeighed(item.unit_of_measure ?? item.product?.unit_of_measure);
      const qty = Number(item.quantity) || 0;
      const addonTotal = (item.addons || []).reduce(
        (a, addon) => a + (Number(addon.price) || 0) * (Number(addon.quantity) || 1), 0);
      // The keyed price wins over the catalogue, exactly as it does on the
      // server. Without this the cart footer showed the catalogue total while
      // the customer was charged the keyed one.
      const unitPrice = item.unit_price ?? (Number(item.product?.price) || 0);
      const base = item.amount_source === 'label_price' && item.label_amount != null
        ? Number(item.label_amount)
        : unitPrice * qty;
      return sum + roundMoney(base + addonTotal * (byWeight ? 1 : qty));
    }, 0));
  },

  // A count of things in the basket, shown on the cart badge. A weighed line
  // is one bag, not 0.734 of something.
  itemCount: () => {
    return get().items.reduce(
      (sum, item) => sum + (isWeighed(item.unit_of_measure ?? item.product?.unit_of_measure) ? 1 : item.quantity),
      0,
    );
  },
}));
