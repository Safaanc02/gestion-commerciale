import { Banknote, CreditCard, Smartphone } from 'lucide-react';

/**
 * What the till accepts. Cash only: this shop has no card terminal and takes
 * no online payment, so offering the other tiles is a way to mis-record a sale
 * — a cashier taps "card", the money is in the drawer, and the day's takings
 * no longer reconcile.
 *
 * Removed from the payment screens, not from the system: bills already paid by
 * card in an earlier install must still display correctly, which is what
 * PAYMENT_METHOD_LABELS below is for.
 */
export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
]);

/**
 * Every method that has ever been recordable, for displaying history.
 * Reading a past bill must not depend on what the till currently offers.
 */
export const PAYMENT_METHOD_LABELS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: CreditCard },
  { key: 'upi' as const, labelKey: 'pos.methodUpi', icon: Smartphone },
]);
