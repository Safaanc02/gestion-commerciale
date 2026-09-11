'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useScanToCart } from '@/hooks/useScanToCart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { printWebBill } from '@/lib/printer/web-print';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { ShoppingCart, X, Info } from 'lucide-react';
import type { Addon, Category, Product, Table, Bill, Order, CartItem } from '@/lib/types';
import { useConfirm } from '@/hooks/use-confirm';
import {
  Drawer, DrawerContent, DrawerTrigger,
} from '@/components/ui/drawer';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import CartTable from '@/components/pos/CartTable';
import CategoryPad from '@/components/pos/CategoryPad';
import RegisterActions from '@/components/pos/RegisterActions';
import RegisterTotals from '@/components/pos/RegisterTotals';
import UnknownBarcodeModal from '@/components/pos/UnknownBarcodeModal';
import AddonModal from '@/components/pos/AddonModal';
import { WeightPad } from '@/components/pos/WeightPad';
import { ItemPad } from '@/components/pos/ItemPad';
import CustomerSearch from '@/components/pos/CustomerSearch';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal, { type PrepaidPayment, type PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import { usePrinterStore } from '@/hooks/usePrinter';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useSupportTicketStatus } from '@/hooks/useSupportTicketStatus';
import { useSupportDiagnosticsPreview } from '@/hooks/useSupportDiagnosticsPreview';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';

const PREPAID_ATTEMPT_STORAGE_KEY = 'flo.prepaid.checkout.attempt';
const POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';

interface PostpaidAttempt {
  userId: string;
  fingerprint: string;
  idempotencyKey: string;
  order?: Order;
}

interface PrepaidAttempt {
  userId: string;
  cartFingerprint: string;
  paymentFingerprint: string;
  discount: PrepaidDiscount | null;
  order?: Order;
  bill?: Bill;
  orderIdempotencyKey: string;
  paymentIdempotencyKey: string;
}

export default function POSPage() {
  const { currentTenant, user } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';

  // A shop that does not seat anyone and does not deliver has one order type.
  // Set as the store's default rather than once on mount, because clearCart
  // runs after every sale — otherwise the second ticket of the day, and every
  // one after it, would be recorded as eaten in.
  const setDefaultOrderType = useCartStore((s) => s.setDefaultOrderType);
  const wantedOrderType = isRestaurant ? 'dine_in' : 'takeaway';
  useEffect(() => { setDefaultOrderType(wantedOrderType); }, [wantedOrderType, setDefaultOrderType]);
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { customerMandatory, autoPrintKot, autoPrintBill, billingType, tablesRequired, kotPrintingEnabled, setBillingType, setTablesRequired, setKotPrintingEnabled,
    printerPaperSize, billAddress, billPhone, billTaxRegistrationNumber, billShowTaxId, billFooterMessage } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const { t } = useI18n();
  const currencyFmt = useFormatCurrency();
  const { confirm, ConfirmDialog } = useConfirm();

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Until the business settings land we do not know whether confirming takes
  // the money now or records an unpaid order. Confirming is held until then.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState(false);

  /**
   * Re-read the one setting that decides how a sale is taken.
   *
   * Holding the confirm button until the billing mode is known is right, but
   * on its own it leaves a till that cannot sell at all if the request failed
   * once. This is the way back — offered in the open, next to the button it
   * unblocks, rather than behind a reload of the whole application.
   */
  const loadBillingSettings = async () => {
    try {
      const { data } = await api.get('/settings/business');
      setBillingType(data.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
      setTablesRequired(typeof data.tables_required === 'boolean' ? data.tables_required : true);
      setSettingsLoaded(true);
      setSettingsError(false);
    } catch {
      setSettingsError(true);
    }
  };
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  // Which basket line the action column acts on.
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  // Modal state
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  // Weighed goods: the keypad replaces the add-on modal entirely.
  const [weighProduct, setWeighProduct] = useState<Product | null>(null);
  // A scanned code that matches nothing — offered for quick creation.
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  // Tapping a countable product opens the quantity/price pad.
  const [itemPadProduct, setItemPadProduct] = useState<Product | null>(null);
  const [editingCartItem, setEditingCartItem] = useState<CartItem | null>(null);
  const [checkoutTable, setCheckoutTable] = useState<Table | null>(null);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const [supportError, setSupportError] = useState<{ code: string; message: string; payload: Record<string, unknown> } | null>(null);
  const [sentTicketId, setSentTicketId] = useState<string | null>(null);
  const delivery = useSupportTicketStatus(sentTicketId);
  const diagnosticsPreview = useSupportDiagnosticsPreview(
    supportError ? String(supportError.payload.category || 'general') : null,
  );
  const activeUserId = user?.id == null ? null : String(user.id);
  const prepaidAttemptRef = useRef<PrepaidAttempt | null>(null);
  const postpaidAttemptRef = useRef<PostpaidAttempt | null>(null);
  const addItemsAttemptRef = useRef<{ orderId: string; key: string } | null>(null);

  const readPostpaidAttempt = () => {
    if (postpaidAttemptRef.current?.userId === activeUserId) return postpaidAttemptRef.current;
    postpaidAttemptRef.current = null;
    if (typeof window === 'undefined') return null;
    try {
      const stored = window.localStorage.getItem(POSTPAID_ATTEMPT_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) as PostpaidAttempt : null;
      if (parsed && parsed.userId === activeUserId) postpaidAttemptRef.current = parsed;
      else window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
    }
    return postpaidAttemptRef.current;
  };
  const savePostpaidAttempt = (attempt: PostpaidAttempt): boolean => {
    postpaidAttemptRef.current = attempt;
    try {
      window.localStorage.setItem(POSTPAID_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
      return true;
    } catch {
      return false;
    }
  };
  const clearPostpaidAttempt = () => {
    postpaidAttemptRef.current = null;
    try {
      window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  };

  const readPrepaidAttempt = () => {
    if (prepaidAttemptRef.current?.userId === activeUserId) return prepaidAttemptRef.current;
    prepaidAttemptRef.current = null;
    if (typeof window === 'undefined') return null;
    try {
      const stored = window.localStorage.getItem(PREPAID_ATTEMPT_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) as PrepaidAttempt : null;
      if (parsed && parsed.userId === activeUserId) {
        if (parsed.discount && 'override_pin' in parsed.discount) {
          const safeDiscount = { ...parsed.discount };
          delete safeDiscount.override_pin;
          parsed.discount = safeDiscount;
          window.localStorage.setItem(PREPAID_ATTEMPT_STORAGE_KEY, JSON.stringify(parsed));
        }
        prepaidAttemptRef.current = parsed;
      } else window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    }
    return prepaidAttemptRef.current;
  };
  const savePrepaidAttempt = (attempt: PrepaidAttempt): boolean => {
    try {
      const safeAttempt = { ...attempt };
      if (safeAttempt.discount) {
        const safeDiscount = { ...safeAttempt.discount };
        delete safeDiscount.override_pin;
        safeAttempt.discount = safeDiscount;
      }
      prepaidAttemptRef.current = safeAttempt;
      window.localStorage.setItem(PREPAID_ATTEMPT_STORAGE_KEY, JSON.stringify(safeAttempt));
      return true;
    } catch {
      return false;
    }
  };
  const clearPrepaidAttempt = () => {
    prepaidAttemptRef.current = null;
    try {
      window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  };
  const newIdempotencyKey = () => typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR', getCountryByCode(currentTenant?.country ?? 'IN')?.locale);
  const { printBill, printKot } = usePrinterStore();
  const billingIsPrepaid = billingType === 'prepaid';
  const shouldTakePaymentNow = billingIsPrepaid;

  const printKotIfEnabled = async (order: Order) => {
    // kot_printing_enabled is coarser than auto_print_kot: when it's off, no
    // KOT print command should go out at all, regardless of the auto-print
    // preference (issue #133).
    if (!kotPrintingEnabled) return;
    if (!autoPrintKot) return;

    try {
      const printWarnings = await printKot(order);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      console.error('[POS] KOT print failed:', err);
      const msg = err instanceof Error ? err.message : t('common.checkPrinterConnection');
      const code = `print.kot.${msg.toLowerCase().includes('spool') ? 'spooler_timeout' : 'failed'}`;
      setSupportError({
        code,
        message: msg,
        payload: { event_code: code, message: msg, category: 'printer', diagnostics: { order_id: order.id, stage: 'kot_print' } },
      });
      toast.error(`${t('pos.kotPrintFailed')}: ${msg}`);
    }
  };

  const fetchLatestBill = async (billId: number): Promise<Bill> => {
    const { data } = await api.get(`/bills/${billId}`);
    return data.bill as Bill;
  };

  const printBillForTenant = async (bill: Bill, force = false) => {
    if (!currentTenant) return;
    if (!force && !autoPrintBill) return;

    // An A5 sheet is not a thermal roll and does not go through the ESC/POS
    // path at all: it is laid out as a page and handed to the Windows printer
    // driver. Arabic needs no code page here — the system font shapes it.
    if (printerPaperSize === 'a5') {
      printWebBill(
        bill,
        { business_name: currentTenant.business_name, currency, country: currentTenant.country },
        {
          paperSize: 'a5',
          businessName: currentTenant.business_name,
          address: billAddress,
          phone: billPhone,
          taxRegistrationNumber: billTaxRegistrationNumber,
          includeTaxId: billShowTaxId,
          footerNote: billFooterMessage,
          isReprint: !force,
        },
      );
      return;
    }

    try {
      const printWarnings = await printBill(bill, {
        business_name: currentTenant.business_name,
        currency,
        country: currentTenant.country,
      });
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      // Non-fatal: print failure should not block the checkout flow.
      const msg = err instanceof Error ? err.message : t('common.checkPrinterConnection');
      const code = 'print.receipt.failed';
      setSupportError({
        code,
        message: msg,
        payload: { event_code: code, message: msg, category: 'printer', diagnostics: { bill_id: bill.id, stage: 'receipt_print' } },
      });
      toast.error(t('pos.receiptPrintFailed'));
    }
  };

  const refreshTables = async () => {
    if (!isRestaurant || !tablesRequired) return;
    try {
      const { data } = await api.get('/tables?active=1');
      setTables(data.tables || []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        // 1. Fetch business settings first
        const settingsRes = await api.get('/settings/business');
        const d = settingsRes.data;
        setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
        setSettingsLoaded(true);
        const isTablesRequired = typeof d.tables_required === 'boolean' ? d.tables_required : true;
        setTablesRequired(isTablesRequired);

        api.get('/settings/kot_printing_enabled')
          .then((res) => setKotPrintingEnabled(res.data.setting?.value !== 'false'))
          .catch(() => {});

        // 2. Fetch other menu data
        const requests: Promise<{ data: Record<string, unknown> }>[] = [
          api.get('/categories?active=1'),
          api.get('/products?active=1'),
        ];
        
        if (isRestaurant && isTablesRequired) {
          requests.push(api.get('/tables?active=1'));
        }
        
        const [catRes, prodRes, tableRes] = await Promise.all(requests);
        setCategories((catRes.data.categories as Category[]) || []);
        setProducts((prodRes.data.products as Product[]) || []);
        
        if (tableRes) {
          setTables((tableRes.data.tables as Table[]) || []);
        } else {
          setTables([]);
        }

        // 3. Fetch held orders conditionally
        if (isTablesRequired) {
          await heldOrders.fetchHeldOrders();
        }
      } catch {
        setSettingsError(true);
        toast.error(t('pos.menuLoadFailed'));
      }
    };
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant, setBillingType, setTablesRequired, setKotPrintingEnabled]);

  const handleProductClick = (product: Product) => {
    // Sold by weight: there is no sensible "1" to add, so ask for the weight.
    if (product.unit_of_measure === 'kg') {
      setWeighProduct(product);
      return;
    }
    // Only stop for a modal when there is actually something to choose. In a
    // supermarket most taps are a plain item and a forced modal is pure
    // friction; restaurant products with option groups still open it.
    if (product.addon_groups && product.addon_groups.length > 0) {
      setAddonProduct(product);
      return;
    }
    setItemPadProduct(product);
  };

  const handleItemPadConfirm = (product: Product, quantity: number, unitPrice: number | null) => {
    cart.addItem(product, quantity, [], '', unitPrice != null ? { unit_price: unitPrice } : undefined);
    setItemPadProduct(null);
  };

  const handleAddonAdd = (product: Product, quantity: number, addons: Addon[], instructions: string) => {
    cart.addItem(product, quantity, addons, instructions);
  };

  const handleWeighConfirm = (product: Product, quantityKg: number) => {
    cart.addItem(product, quantityKg, [], '', { quantity_source: 'manual_weight' });
    setWeighProduct(null);
  };

  const handleEditItemSave = (_product: Product, quantity: number, addons: Addon[], instructions: string) => {
    if (!editingCartItem) return;
    cart.updateItemDetails(editingCartItem.id, quantity, addons, instructions);
  };

  // A modal already open means the scan (if one lands) isn't meant for the
  // product grid — e.g. it could be a barcode field inside that modal.
  const anyModalOpen = showTablePicker || !!addonProduct || !!editingCartItem || !!checkoutTable
    || !!paymentBill || showCustomerPrompt || showPrepaidCheckout || !!weighProduct || !!itemPadProduct || !!unknownBarcode;

  // Shared with the dashboard quick-sell panel — see useScanToCart.
  // A scan and a tap land in the same place: the keypad, so a price that has
  // changed can be keyed before the line is added. Scanning does not skip it.
  //
  // The pad keeps the scanner alive itself while it is open (see ItemPad's
  // onScan) — otherwise the second of two consecutive scans went nowhere at
  // all, silently, because opening a modal takes the listener off this page.
  const handleScan = useScanToCart({ products, onProduct: handleProductClick, onUnknown: setUnknownBarcode });

  useBarcodeScanner((code) => { void handleScan(code); }, !anyModalOpen);

  const handlePlaceOrder = async () => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    if (customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return;
    }
    if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired && !cart.tableId) {
      setShowTablePicker(true);
      return;
    }

    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow) {
      setShowPrepaidCheckout(true);
      return;
    }

    // Postpaid store / unpaid order → place order, kitchen gets the ticket, payment collected later
    setSubmitting(true);
    try {
      let orderForKot: Order;

      if (pendingOrder) {
        // Add new items to an existing order with a durable retry key.
        const newItems = cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
            : null,
          special_instructions: item.special_instructions || null,
          // The raw label, when there was one. The server re-decodes it and
          // recomputes the weight and the amount from its own catalogue — the
          // quantity above is only what the till displayed.
          scan_raw: item.scan_raw || null,
      unit_price: item.unit_price ?? undefined,
        }));
        const itemFingerprint = JSON.stringify({ order_id: pendingOrder.id, items: newItems, special_instructions: cart.orderNotes || undefined });
        const priorItemsAttempt = readPostpaidAttempt();
        const itemAttempt: PostpaidAttempt = priorItemsAttempt?.userId === activeUserId && priorItemsAttempt.fingerprint === itemFingerprint
          ? priorItemsAttempt
          : { userId: activeUserId || '', fingerprint: itemFingerprint, idempotencyKey: newIdempotencyKey() };
        if (!savePostpaidAttempt(itemAttempt)) throw new Error(t('pos.placeOrderFailed'));
        const { data } = await api.post(
          `/orders/${pendingOrder.id}/items`,
          { items: newItems, special_instructions: cart.orderNotes || undefined },
          { headers: { 'Idempotency-Key': itemAttempt.idempotencyKey } },
        );
        toast.success(t('pos.itemsAddedToOrder', { number: pendingOrder.order_number }));
        orderForKot = data.order as Order;
        clearPostpaidAttempt();
        setPendingOrder(null);
      } else {
        const orderPayload = {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          items: cart.items.map((item) => ({
            product_id: item.product.id,
            quantity: item.quantity,
            addons: item.addons.length > 0
              ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
              : null,
            special_instructions: item.special_instructions || null,
            scan_raw: item.scan_raw || null,
      unit_price: item.unit_price ?? undefined,
          })),
        };
        const orderFingerprint = JSON.stringify(orderPayload);
        const priorOrderAttempt = readPostpaidAttempt();
        const orderAttempt: PostpaidAttempt = priorOrderAttempt?.userId === activeUserId && priorOrderAttempt.fingerprint === orderFingerprint
          ? priorOrderAttempt
          : { userId: activeUserId || '', fingerprint: orderFingerprint, idempotencyKey: newIdempotencyKey() };
        if (!savePostpaidAttempt(orderAttempt)) throw new Error(t('pos.placeOrderFailed'));
        const { data } = orderAttempt.order
          ? { data: { order: orderAttempt.order } }
          : await api.post('/orders', orderPayload, { headers: { 'Idempotency-Key': orderAttempt.idempotencyKey } });
        if (!orderAttempt.order) savePostpaidAttempt({ ...orderAttempt, order: data.order as Order });
        toast.success(t('pos.orderPlaced', { number: data.order.order_number }));
        orderForKot = data.order as Order;
        clearPostpaidAttempt();
      }

      if (cart.tableId) heldOrders.removeHeldOrder(cart.tableId);
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderForKot);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string; error?: string } } };
      toast.error(error.response?.data?.message || error.response?.data?.error || t('pos.placeOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Handle prepaid checkout - place order and pay in one step
  const handlePrepaidCheckout = async (payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) => {
    const isPrepaidCheckout = shouldTakePaymentNow;
    setShowPrepaidCheckout(false);
    setSubmitting(true);
    const orderItems = cart.items.map((item) => ({
      product_id: item.product.id,
      quantity: item.quantity,
      addons: item.addons.length > 0
        ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
        : null,
      special_instructions: item.special_instructions || null,
      scan_raw: item.scan_raw || null,
      unit_price: item.unit_price ?? undefined,
    }));
    const paymentLines = payments
      .filter((p) => p.amount > 0)
      .map((p) => ({ method: p.method, amount: p.amount }));
    if (walletAmount > 0) paymentLines.push({ method: 'wallet', amount: walletAmount });
    const paymentFingerprint = JSON.stringify({ payments: paymentLines, customer_id: cart.customerId });
    const cartFingerprint = JSON.stringify({
      table_id: cart.tableId,
      customer_id: cart.customerId,
      type: cart.orderType,
      guest_count: cart.guestCount,
      special_instructions: cart.orderNotes,
      items: orderItems,
    });
    const storedAttempt = readPrepaidAttempt();
    const existingAttempt = storedAttempt && storedAttempt.userId === activeUserId && storedAttempt.cartFingerprint === cartFingerprint
      && storedAttempt.orderIdempotencyKey && storedAttempt.paymentIdempotencyKey
      ? storedAttempt
      : null;
    const currentDiscount = discount && discount.value > 0 ? discount : null;
    const discountFingerprint = (value: PrepaidDiscount | null | undefined) => JSON.stringify(
      value ? { type: value.type, value: value.value, reason: value.reason } : null,
    );
    const discountChanged = !!existingAttempt
      && discountFingerprint(existingAttempt.discount) !== discountFingerprint(currentDiscount);
    const retryDiscount = currentDiscount;
    let attempt: PrepaidAttempt = existingAttempt
      ? {
        ...existingAttempt,
        discount: retryDiscount,
        bill: discountChanged ? undefined : existingAttempt.bill,
        paymentFingerprint,
        paymentIdempotencyKey: existingAttempt.paymentFingerprint === paymentFingerprint && !discountChanged
          ? existingAttempt.paymentIdempotencyKey
          : newIdempotencyKey(),
      }
      : {
        userId: activeUserId || '',
        cartFingerprint,
        paymentFingerprint,
        discount: discount && discount.value > 0 ? discount : null,
        orderIdempotencyKey: newIdempotencyKey(),
        paymentIdempotencyKey: newIdempotencyKey(),
      };
    // Persist the key before the first order mutation. The server replays the
    // order response if this renderer loses the response or restarts.
    if (!savePrepaidAttempt(attempt)) {
      clearPrepaidAttempt();
      toast.error(t('pos.processOrderFailed'));
      setSubmitting(false);
      return;
    }
    let orderData: { order: Order };
    let billData: { bill: Bill };
    try {
      if (existingAttempt?.bill && discountChanged) {
        try {
          const { data: currentBillData } = await api.get(`/bills/${existingAttempt.bill.id}`);
          if (currentBillData.bill?.payment_status === 'paid') {
            // A lost payment response wins over a later UI edit; replay the
            // original request instead of mutating an already-settled bill.
            attempt = {
              ...attempt,
              discount: existingAttempt.discount,
              bill: existingAttempt.bill,
              paymentFingerprint: existingAttempt.paymentFingerprint,
              paymentIdempotencyKey: existingAttempt.paymentIdempotencyKey,
            };
            savePrepaidAttempt(attempt);
          }
        } catch {
          // An unknown bill state must replay the original request. Applying a
          // new discount/key could turn a committed payment into a stuck retry.
          attempt = {
            ...attempt,
            discount: existingAttempt.discount,
            bill: existingAttempt.bill,
            paymentFingerprint: existingAttempt.paymentFingerprint,
            paymentIdempotencyKey: existingAttempt.paymentIdempotencyKey,
          };
          savePrepaidAttempt(attempt);
        }
      }
      if (attempt.order) {
        orderData = { order: attempt.order };
      } else {
        const { data } = await api.post('/orders', {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          items: orderItems,
        }, { headers: { 'Idempotency-Key': attempt.orderIdempotencyKey } });
        orderData = data;
        savePrepaidAttempt({ ...attempt, order: data.order });
      }
      const orderId = orderData.order.id;

      // Apply discount before bill generation so the bill uses the discounted
      // totals (tax recalculated on the net payable amount). Repeating this SET
      // operation is safe if its response was lost.
      const effectiveDiscount = attempt.discount;
      const discountForRequest = effectiveDiscount && currentDiscount
        && discountFingerprint(effectiveDiscount) === discountFingerprint(currentDiscount)
        ? { ...effectiveDiscount, override_pin: currentDiscount.override_pin }
        : effectiveDiscount;
      let discountAlreadyApplied = false;
      if (!attempt.bill && (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0)) && attempt.order) {
        try {
          const { data: currentOrderData } = await api.get(`/orders/${orderId}`);
          const serverDiscount = currentOrderData.order?.discount_type && Number(currentOrderData.order.discount_value) > 0
            ? {
              type: currentOrderData.order.discount_type,
              value: Number(currentOrderData.order.discount_value),
              reason: currentOrderData.order.discount_reason || undefined,
            }
            : null;
          discountAlreadyApplied = discountFingerprint(serverDiscount) === discountFingerprint(effectiveDiscount);
        } catch {
          // If the order cannot be read, retain the safe retry behavior below;
          // an approval PIN may be required to reapply an uncertain discount.
        }
      }
      if (!attempt.bill && !discountAlreadyApplied && (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0))) {
        await api.patch(`/orders/${orderId}/discount`, {
          discount_type: discountForRequest?.type || 'percentage',
          discount_value: discountForRequest?.value || 0,
          discount_reason: discountForRequest?.reason,
          override_pin: discountForRequest?.override_pin,
        });
      }

      if (attempt.bill) {
        billData = { bill: attempt.bill };
      } else {
        const { data: generatedBill } = await api.post('/bills/generate', { order_id: orderId });
        billData = generatedBill;
        savePrepaidAttempt({ ...attempt, order: orderData.order, bill: generatedBill.bill });
      }

      // Record every split in one atomic request. The persisted bill/key pair
      // makes a lost response safe to retry without creating a second order.
      const paymentResponse = await api.post(
        `/bills/${billData.bill.id}/payments`,
        { payments: paymentLines, customer_id: cart.customerId },
        { headers: { 'Idempotency-Key': attempt.paymentIdempotencyKey } },
      );
      const paidBill: Bill = paymentResponse.data?.bill || billData.bill;
      const pointsEarned = paymentResponse.data?.loyaltyPointsEarned > 0
        ? paymentResponse.data.loyaltyPointsEarned
        : 0;

      if (paidBill.payment_status !== 'paid') {
        throw new Error(t('pos.paymentIncomplete', {
          amount: currencyFmt(Number(paidBill.balance) || 0),
        }));
      }

      const successMsg = pointsEarned > 0
        ? t('pos.orderPaidWithPoints', { number: orderData.order.order_number, points: pointsEarned })
        : t('pos.orderPaid', { number: orderData.order.order_number });
      toast.success(successMsg);
      if (cart.tableId) heldOrders.removeHeldOrder(cart.tableId);
      cart.clearCart();
      clearPrepaidAttempt();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderData.order);

      await printBillForTenant(paidBill, isPrepaidCheckout);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string; error?: string } }; message?: string };
      toast.error(error.response?.data?.message || error.response?.data?.error || error.message || t('pos.processOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };


  const handleSelectAvailableTable = (tableId: string, customer?: { id: number; name: string; phone: string } | null) => {
    cart.setTableId(tableId);
    if (customer) {
      cart.setCustomer({ ...customer, email: null, visits_count: 0, total_spent: 0, last_visit_at: null, country_code: '' });
    }
    setShowTablePicker(false);
  };

  const handleSelectOccupiedTable = async (table: Table) => {
    const activeOrder = table.current_order || table.activeOrder || null;
    const activeCustomerId = activeOrder?.customer_id;
    const activeCustomerName = activeOrder?.customer?.name || t('pos.anotherCustomer');

    if (
      cart.customerId != null &&
      activeCustomerId != null &&
      String(cart.customerId) !== String(activeCustomerId)
    ) {
      const shouldProceed = await confirm(
        t('pos.customerMismatchWarning', { customer: activeCustomerName }),
        {
          title: t('pos.customerMismatchTitle'),
          confirmLabel: t('pos.proceedAnyway'),
        },
      );

      if (!shouldProceed) return;
    }

    setShowTablePicker(false);
    setCheckoutTable(table);
  };

  const handleSelectHeldTable = async (tableId: string) => {
    const held = await heldOrders.restoreOrder(tableId);
    if (held) {
      cart.loadItems(held.items, tableId, held.customerId, held.guestCount, held.orderNotes);
      cart.setOrderType('dine_in');
    }
    setShowTablePicker(false);
    await refreshTables();
  };

  const handleHoldTable = async (tableId: string) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === tableId)?.name || tableId;
    try {
      await heldOrders.holdOrder(tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      setShowTablePicker(false);
      toast.success(t('pos.orderHeld', { tableName }));
      await refreshTables();
    } catch (err: unknown) {
      const e = err as Error;
      toast.error(e.message || t('pos.holdOrderFailed'));
    }
  };

  const handleAddItemsToOrder = (table: Table, order: Order) => {
    setCheckoutTable(null);
    cart.setTableId(table.id);
    cart.setOrderType('dine_in');
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('pos.addingItemsToOrder', { number: order.order_number })} ${t('pos.placeOrderReady')}`, { icon: <Info size={18} className="text-brand" /> });
  };

  // Add cart items directly to existing order
  const handleAddCartToOrder = async (table: Table, order: Order) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      const existingAttempt = addItemsAttemptRef.current;
      const idempotencyKey = existingAttempt?.orderId === String(order.id)
        ? existingAttempt.key
        : newIdempotencyKey();
      addItemsAttemptRef.current = { orderId: String(order.id), key: idempotencyKey };
      await api.post(`/orders/${order.id}/items`, {
        items: cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
            : null,
          special_instructions: item.special_instructions || null,
          scan_raw: item.scan_raw || null,
      unit_price: item.unit_price ?? undefined,
        })),
        special_instructions: order.special_instructions || undefined,
      }, { headers: { 'Idempotency-Key': idempotencyKey } });
      addItemsAttemptRef.current = null;
      toast.success(t('pos.itemsAddedToOrder', { number: order.order_number }));
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || t('pos.addItemsFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutTable(null);
    refreshTables();

    if (bill) {
      try {
        await printBillForTenant(await fetchLatestBill(bill.id));
      } catch {
        toast.error(t('pos.receiptPrintFailed'));
      }
    }
  };

  const cartPanelProps = {
    tables,
    currency,
    submitting,
    onPlaceOrder: handlePlaceOrder,
    onShowTablePicker: () => setShowTablePicker(true),
    onEditItem: setEditingCartItem,
    existingOrder: pendingOrder,
  };

  const itemCount = cart.itemCount();

  return (
    <>
      {supportError && (
        <div className="fixed bottom-4 start-4 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-200 bg-card p-4 shadow-xl">
          {sentTicketId ? (
            <>
              <p className="font-semibold text-red-800">{t('support.requestQueued')}</p>
              {delivery.status === 'delivered' && delivery.supportCode ? (
                <>
                  <p className="mt-1 text-sm font-semibold text-foreground">{t('support.supportCode')}: <span className="font-mono">{delivery.supportCode}</span></p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('support.supportCodeHint')}</p>
                </>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {delivery.status === 'failed' ? t('support.stillQueuedLocally') : t('support.confirmingDelivery')}
                </p>
              )}
              <div className="mt-3">
                <button className="rounded border px-3 py-2 text-sm" onClick={() => { setSupportError(null); setSentTicketId(null); }}>Dismiss</button>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold text-red-800">Printing failed</p>
              <p className="mt-1 text-sm text-muted-foreground">{supportError.message}</p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('support.showPayload')}</summary>
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted/50 p-2">{JSON.stringify(
                  diagnosticsPreview
                    ? { ...supportError.payload, diagnostics: { ...(supportError.payload.diagnostics as Record<string, unknown> | undefined), ...diagnosticsPreview } }
                    : supportError.payload,
                  null, 2,
                )}</pre>
              </details>
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded bg-brand px-3 py-2 text-sm font-medium text-white"
                  onClick={async () => {
                    const clientTicketId = crypto.randomUUID();
                    try {
                      const response = await api.post('/support-ticket', {
                        ...supportError.payload,
                        subject: 'FloCafe printing problem',
                        correlation_id: crypto.randomUUID(),
                        client_ticket_id: clientTicketId,
                      });
                      toast.success(response.data.message || 'Queued — will send when online');
                      setSentTicketId(clientTicketId);
                    } catch {
                      toast.error('Could not queue the support request');
                    }
                  }}
                >Get help</button>
                <button className="rounded border px-3 py-2 text-sm" onClick={() => setSupportError(null)}>Dismiss</button>
              </div>
            </>
          )}
        </div>
      )}
      <PosTopbar tables={tables} onShowTablePicker={() => setShowTablePicker(true)} />

      {/*
        The register, laid out like the till this shop already runs: basket and
        shelves on top, products underneath, actions in a fixed column at the
        edge. Nothing is behind a menu, so a cashier reaches for a position on
        the screen instead of reading their way to it.

        Sides are logical, not physical. In Arabic the shelves sit at the
        reading start (right) and the action column at the end (left), which is
        where they are on the machine being replaced; in French the whole thing
        mirrors without a second layout.
      */}
      {settingsError && !settingsLoaded && (
        <div className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>{t('pos.settingsUnavailable')}</span>
          <button
            onClick={loadBillingSettings}
            className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden p-3 gap-3">
        <div className="flex min-h-0 flex-1 min-w-0 flex-col gap-2">
          <RegisterTotals itemCount={itemCount} />
          <div className="flex min-h-0 flex-[2] gap-2">
            <div className="min-w-0 flex-1">
              <CartTable
                items={cart.items}
                selectedId={selectedLineId}
                onSelect={setSelectedLineId}
                onOpenLine={setEditingCartItem}
              />
            </div>
            <div className="w-56 shrink-0">
              <CategoryPad
                categories={categories}
                selected={selectedCategory}
                onSelect={setSelectedCategory}
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-[3] flex-col">
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
              sidebarOpen={leftSidebarOpen}
              hideCategoryBar
            />
          </div>
        </div>

        <RegisterActions
          onConfirm={handlePlaceOrder}
          onQuantity={() => {
            const line = cart.items.find((i) => i.id === selectedLineId);
            if (line) setEditingCartItem(line);
          }}
          onRemoveLine={() => {
            if (selectedLineId) { cart.removeItem(selectedLineId); setSelectedLineId(null); }
          }}
          onCancelTicket={async () => {
            if (await confirm(t('pos.cancelTicketConfirm'))) {
              cart.clearCart();
              setSelectedLineId(null);
            }
          }}
          canConfirm={cart.items.length > 0 && settingsLoaded}
          hasSelection={!!selectedLineId && cart.items.some((i) => i.id === selectedLineId)}
          hasItems={cart.items.length > 0}
          submitting={submitting}
        />
      </div>

      {/* Below the register's width the columns cannot coexist: the grid takes
          the screen and the basket moves into the sheet reached from the
          floating button. */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-3 md:hidden">
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
          sidebarOpen={leftSidebarOpen}
        />
      </div>

      {/* Mobile: Floating Cart Button + Bottom Sheet — outside flex container */}
      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button className="fixed bottom-5 end-5 z-40 w-14 h-14 bg-brand text-white rounded-full shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors md:hidden">
            <ShoppingCart size={22} />
            {itemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                {itemCount}
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh]">
          <div className="overflow-y-auto max-h-[80vh] px-2 pb-2">
            <CartPanel {...cartPanelProps} variant="drawer" />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Modals */}
      {isRestaurant && showTablePicker && (
        <TablePickerModal
          tables={tables}
          selectedTableId={cart.tableId}
          onSelectAvailable={handleSelectAvailableTable}
          onSelectOccupied={handleSelectOccupiedTable}
          onSelectHeld={handleSelectHeldTable}
          onPlaceOrder={handlePlaceOrder}
          onHoldTable={handleHoldTable}
          onClose={() => setShowTablePicker(false)}
        />
      )}

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currency}
          onAdd={handleAddonAdd}
          onClose={() => setAddonProduct(null)}
        />
      )}

      {itemPadProduct && (
        <ItemPad
          product={itemPadProduct}
          onConfirm={handleItemPadConfirm}
          onScan={handleScan}
          onClose={() => setItemPadProduct(null)}
        />
      )}

      {weighProduct && (
        <WeightPad
          product={weighProduct}
          onConfirm={handleWeighConfirm}
          onClose={() => setWeighProduct(null)}
        />
      )}

      {editingCartItem && editingCartItem.unit_of_measure === 'kg' && (
        // Correcting a mis-keyed weight goes back through the keypad, not the
        // add-on stepper: the stepper only moves in whole units.
        <WeightPad
          product={editingCartItem.product}
          initialGrams={Math.round(editingCartItem.quantity * 1000)}
          onConfirm={(_product, quantityKg) => {
            cart.updateItemDetails(editingCartItem.id, quantityKg, editingCartItem.addons, editingCartItem.special_instructions);
            setEditingCartItem(null);
          }}
          onClose={() => setEditingCartItem(null)}
        />
      )}

      {editingCartItem && editingCartItem.unit_of_measure !== 'kg' && (
        <AddonModal
          product={editingCartItem.product}
          currency={currency}
          mode="edit"
          initialQuantity={editingCartItem.quantity}
          initialAddons={editingCartItem.addons}
          initialInstructions={editingCartItem.special_instructions}
          onAdd={handleEditItemSave}
          onClose={() => setEditingCartItem(null)}
        />
      )}

      {checkoutTable && (
        <TableCheckoutModal
          table={checkoutTable}
          currency={currency}
          cartItemCount={cart.itemCount()}
          onClose={() => setCheckoutTable(null)}
          onAddItems={handleAddItemsToOrder}
          onPayment={(bill) => { setCheckoutTable(null); setPaymentBill(bill); }}
          onAddCartToOrder={handleAddCartToOrder}
        />
      )}

      {paymentBill && (
        <PaymentModal
          bill={paymentBill}
          currency={currency}
          onClose={() => setPaymentBill(null)}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
        />
      )}

      {showCustomerPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-5 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">{t('pos.selectCustomer')}</h3>
              <button onClick={() => setShowCustomerPrompt(false)} className="text-muted-foreground hover:text-muted-foreground">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('pos.customerRequiredBeforeOrder')}</p>
            <CustomerSearch onSelected={() => setShowCustomerPrompt(false)} />
          </div>
        </div>
      )}

      {ConfirmDialog}

      {/* Prepaid Checkout Modal - Payment BEFORE order is placed */}
      {unknownBarcode && (
        <UnknownBarcodeModal
          barcode={unknownBarcode}
          categories={categories}
          onClose={() => setUnknownBarcode(null)}
          onCreated={(product) => {
            // Into the catalogue on screen as well as the basket, so the next
            // scan of the same code resolves without a page reload.
            setProducts((prev) => [...prev, product]);
            cart.addItem(product, 1, [], '');
            setUnknownBarcode(null);
          }}
        />
      )}

      {showPrepaidCheckout && (
        <PrepaidCheckoutModal
          currency={currency}
          onClose={() => setShowPrepaidCheckout(false)}
          onConfirm={handlePrepaidCheckout}
        />
      )}

    </>
  );
}
