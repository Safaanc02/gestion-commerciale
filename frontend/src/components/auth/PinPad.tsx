'use client';

import { useEffect } from 'react';
import { Delete } from 'lucide-react';

/**
 * The numeric keypad staff sign in with.
 *
 * Shared by first-run setup (where the PIN is chosen) and the login screen
 * (where it is entered), so the two can never drift into accepting different
 * lengths or behaving differently under a finger.
 *
 * Targets are 64px because this is used standing up, on a touch screen, with
 * a queue waiting. A physical keyboard still works — a till often has one, and
 * typing four digits is faster than tapping them.
 */
interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Fired when the keypad is submitted, by the round button or by Enter. */
  onSubmit?: () => void;
  /** Digits shown as filled dots; entry is capped here. */
  maxLength?: number;
  /** Enable submission — the caller decides what "complete" means. */
  canSubmit?: boolean;
  busy?: boolean;
  error?: string | null;
  label?: string;
  submitLabel: string;
  autoFocusKeyboard?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function PinPad({
  value, onChange, onSubmit, maxLength = 8, canSubmit = false,
  busy = false, error = null, label, submitLabel, autoFocusKeyboard = true,
}: Props) {
  const press = (digit: string) => {
    if (value.length >= maxLength) return;
    onChange(value + digit);
  };

  useEffect(() => {
    if (!autoFocusKeyboard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) { press(event.key); event.preventDefault(); }
      else if (event.key === 'Backspace') { onChange(value.slice(0, -1)); event.preventDefault(); }
      else if (event.key === 'Enter' && canSubmit && !busy) { onSubmit?.(); event.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="mx-auto w-full max-w-xs">
      {label && <p className="mb-3 text-center text-sm text-muted-foreground">{label}</p>}

      {/* Dots rather than digits: the screen faces the shop floor. */}
      <div className="mb-2 flex justify-center gap-3" aria-hidden="true">
        {Array.from({ length: Math.max(4, value.length || 4) }).map((_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full transition-colors ${
              i < value.length ? 'bg-primary' : 'bg-muted-foreground/25'
            }`}
          />
        ))}
      </div>

      <p className="mb-4 min-h-[1.25rem] text-center text-sm font-medium text-red-600">{error ?? ''}</p>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            className="flex h-16 items-center justify-center rounded-2xl border bg-card text-2xl font-medium tabular-nums
                       transition-transform active:scale-95 active:bg-muted"
          >
            {key}
          </button>
        ))}

        <button
          type="button"
          onClick={() => onChange('')}
          className="flex h-16 items-center justify-center rounded-2xl border bg-card text-sm font-medium
                     text-muted-foreground transition-transform active:scale-95 active:bg-muted"
        >
          C
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          className="flex h-16 items-center justify-center rounded-2xl border bg-card text-2xl font-medium tabular-nums
                     transition-transform active:scale-95 active:bg-muted"
        >
          0
        </button>
        <button
          type="button"
          onClick={() => onChange(value.slice(0, -1))}
          aria-label="effacer"
          className="flex h-16 items-center justify-center rounded-2xl border bg-card
                     transition-transform active:scale-95 active:bg-muted"
        >
          <Delete className="h-6 w-6" />
        </button>
      </div>

      <button
        type="button"
        disabled={!canSubmit || busy}
        onClick={() => onSubmit?.()}
        className="mt-4 h-16 w-full rounded-2xl bg-primary text-lg font-semibold text-primary-foreground
                   transition-opacity disabled:opacity-40"
      >
        {submitLabel}
      </button>
    </div>
  );
}
