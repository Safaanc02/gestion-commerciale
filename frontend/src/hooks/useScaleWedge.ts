'use client';

import { useEffect, useRef } from 'react';

/**
 * Read a weight from a scale that behaves like a keyboard.
 *
 * A good number of counter scales offer exactly this: press the send key and
 * the scale types its reading, then Enter — the same trick the barcode reader
 * uses, needing no driver, no cable configuration and no serial library. When
 * a shop's scale does that, this is the whole of the integration.
 *
 * A scale that speaks RS-232 instead sends nothing here and needs a real
 * driver; this hook simply never fires, so it costs nothing to leave enabled.
 *
 * Told apart from a barcode by shape, since both arrive as fast keystrokes:
 * a weight carries a decimal separator or a unit, a barcode is a long run of
 * digits and nothing else. Anything ambiguous is left alone rather than
 * guessed at — a misread weight is a mispriced bag.
 */
const MAX_INTER_KEY_MS = 60;

/** "1.234 kg", "0,734kg", "ST,GS 1.234 kg" — take the number and its unit. */
const WEIGHT = /(-?\d+[.,]\d+)\s*(kg|g)?\s*$/i;

export function useScaleWedge(onWeight: (grams: number) => void, enabled = true) {
  const buffer = useRef('');
  const lastKey = useRef(0);
  const handler = useRef(onWeight);

  useEffect(() => { handler.current = onWeight; }, [onWeight]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      const gap = now - lastKey.current;
      lastKey.current = now;

      if (e.key === 'Enter') {
        const raw = buffer.current;
        buffer.current = '';
        const match = WEIGHT.exec(raw.trim());
        if (!match) return;   // no decimal point: this was a barcode, not a weight

        const value = Number(match[1].replace(',', '.'));
        if (!Number.isFinite(value) || value <= 0) return;
        // Grams unless the reading says otherwise. A scale sending "734" with
        // no unit is already in grams; one sending "0.734 kg" is not.
        const grams = match[2]?.toLowerCase() === 'g' ? value : Math.round(value * 1000);
        if (grams <= 0 || grams > 99_999) return;   // beyond what a label can carry
        e.preventDefault();
        handler.current(grams);
        return;
      }

      // Typed slowly: a person at the keypad, not an instrument.
      if (gap > MAX_INTER_KEY_MS) buffer.current = '';
      if (e.key.length === 1) buffer.current += e.key;
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
