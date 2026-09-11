'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowBigUp, ChevronDown, CornerDownLeft, Delete, Globe } from 'lucide-react';
import { usePosSettingsStore } from '@/store/pos-settings';

/**
 * A keyboard for a till that has no keyboard.
 *
 * Mounted once and driven by whatever field the cashier taps, rather than
 * wired into each of the ten screens that take text. A per-field keyboard
 * would have to be remembered every time someone adds an input, and the one
 * that got forgotten would be the one a cashier needs at a counter with a
 * queue.
 *
 * It opens on a tap, never on focus alone: the register's search field focuses
 * itself so a scanner's keystrokes land there, and a keyboard that rose every
 * time would sit over the products all day for nothing.
 */

/** Standard Arabic 101, in the order the keys sit on a physical board. */
const ARABIC: string[][] = [
  ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج', 'د', 'ذ'],
  ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط'],
  ['ئ', 'ء', 'ؤ', 'ر', 'لا', 'ى', 'ة', 'و', 'ز', 'ظ'],
];

/** AZERTY: the shop's Windows keyboards are set to French. */
const LATIN: string[][] = [
  ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
  ['w', 'x', 'c', 'v', 'b', 'n', 'é', 'è', 'à', 'ç'],
];

const DIGITS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['.', ',', '-', '+', '×', '/', '%', '(', ')', ':'],
];

type Layout = 'ar' | 'fr' | '123';

const LAYOUTS: Record<Layout, string[][]> = { ar: ARABIC, fr: LATIN, '123': DIGITS };
const NEXT: Record<Layout, Layout> = { ar: 'fr', fr: '123', '123': 'ar' };
const NAME: Record<Layout, string> = { ar: 'ع', fr: 'FR', '123': '123' };

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return ['text', 'search', 'tel', 'number', 'email', 'password', 'url', ''].includes(type);
}

/**
 * Write into a React-controlled field.
 *
 * Assigning `el.value` directly is invisible to React, which tracks the last
 * value it wrote and would discard the change on the next render. Going
 * through the prototype's setter and dispatching a real input event is what
 * makes the component's own onChange run, so the field behaves exactly as if
 * the character had been typed.
 */
function writeValue(el: HTMLInputElement | HTMLTextAreaElement, next: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // A number field refuses a selection range. The text is in; the caret
    // lands at the end on its own.
  }
}

export default function OnScreenKeyboard() {
  const enabled = usePosSettingsStore((s) => s.touchKeyboard);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<Layout>('ar');
  const [shift, setShift] = useState(false);
  const target = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // A tap on a field opens it; a tap anywhere that is not a field and not the
  // keyboard closes it. Captured on the way down so a field that re-renders on
  // focus does not lose the event.
  useEffect(() => {
    if (!enabled) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest('[data-osk]')) return;   // a key: keep the field
      if (isTextField(el)) {
        target.current = el;
        // Keep Windows' own touch keyboard down.
        //
        // On a terminal with no keyboard attached, Windows raises its keyboard
        // by itself as soon as a field takes focus — so the cashier would get
        // two, stacked, one of them without an Arabic layout. inputmode="none"
        // is how a page says it handles text entry itself, and Chromium
        // suppresses the system keyboard for it. Set here rather than on every
        // field because it must only apply while ours is switched on: turn the
        // setting off and the fields go back to asking the OS.
        //
        // pointerdown runs before focus, which is what makes this early enough
        // to matter.
        el.inputMode = 'none';
        setOpen(true);
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [enabled]);

  const press = useCallback((key: string) => {
    const el = target.current;
    if (!el) return;
    el.focus();

    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;

    if (key === '\b') {
      // Nothing selected: take the character before the caret.
      const from = start === end ? Math.max(0, start - 1) : start;
      writeValue(el, el.value.slice(0, from) + el.value.slice(end), from);
      return;
    }
    if (key === '\n') {
      // Let the field's own handler decide — on the register that is the
      // search running a scan, not a line break.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return;
    }
    const text = shift ? key.toUpperCase() : key;
    writeValue(el, el.value.slice(0, start) + text + el.value.slice(end), start + text.length);
    if (shift) setShift(false);
  }, [shift]);

  // Hand the field back to the OS when the setting is switched off, or it
  // stays mute until the page is reloaded. Touching the DOM node is what an
  // effect is for; closing is state, and is adjusted during render below.
  useEffect(() => {
    if (!enabled && target.current) target.current.inputMode = '';
  }, [enabled]);

  // Turning the setting off and on again should not leave the keyboard raised
  // over a field nobody tapped.
  const [syncedEnabled, setSyncedEnabled] = useState(enabled);
  if (syncedEnabled !== enabled) {
    setSyncedEnabled(enabled);
    setOpen(false);
  }

  if (!enabled || !open) return null;

  const rows = LAYOUTS[layout];
  const keyClass = 'flex h-12 min-w-[2.25rem] flex-1 items-center justify-center rounded-md border border-border bg-card text-base font-medium text-foreground shadow-sm transition-colors active:bg-muted';

  return (
    <div
      data-osk
      // Laid out left to right whatever the interface direction: an Arabic
      // keyboard's keys sit in fixed physical positions, and mirroring them
      // would put every letter somewhere a typist does not expect.
      dir="ltr"
      className="shrink-0 border-t border-border bg-muted/70 px-2 py-2 backdrop-blur"
      onPointerDown={(e) => e.preventDefault()}   // keep the field's caret
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-1.5">
            {i === rows.length - 1 && layout !== '123' && (
              <button
                onClick={() => setShift((s) => !s)}
                aria-label="Majuscule"
                className={`${keyClass} max-w-[3.5rem] ${shift ? 'bg-brand text-white' : ''}`}
              >
                <ArrowBigUp size={18} />
              </button>
            )}
            {row.map((k) => (
              <button key={k} onClick={() => press(k)} className={keyClass}>
                {shift && layout === 'fr' ? k.toUpperCase() : k}
              </button>
            ))}
            {i === rows.length - 1 && (
              <button onClick={() => press('\b')} aria-label="Effacer" className={`${keyClass} max-w-[3.5rem]`}>
                <Delete size={18} />
              </button>
            )}
          </div>
        ))}

        <div className="flex gap-1.5">
          <button
            onClick={() => { setLayout(NEXT[layout]); setShift(false); }}
            className={`${keyClass} max-w-[4.5rem] gap-1.5 text-sm`}
          >
            <Globe size={16} />{NAME[NEXT[layout]]}
          </button>
          <button onClick={() => press(' ')} className={`${keyClass} flex-[6]`}>espace</button>
          <button onClick={() => press('\n')} aria-label="Entrée" className={`${keyClass} max-w-[5rem] bg-brand text-white`}>
            <CornerDownLeft size={18} />
          </button>
          <button onClick={() => setOpen(false)} aria-label="Masquer le clavier" className={`${keyClass} max-w-[3.5rem]`}>
            <ChevronDown size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
