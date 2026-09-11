'use client';

import { useEffect } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { isRtl } from '@/lib/i18n';

/**
 * Keeps <html lang> and <html dir> in step with the chosen language.
 *
 * Darija is written in Arabic script and runs right to left, so the whole
 * layout has to flip — not just the text. Setting `dir` on the root element is
 * what makes the browser do that for flexbox, scrollbars, text alignment and
 * caret movement, rather than each component having to know about it.
 *
 * `lang` matters too: it selects the correct font shaping and tells a screen
 * reader which language it is reading.
 */
export default function DirectionSync() {
  const { language } = useI18n();

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', language);
    root.setAttribute('dir', isRtl(language) ? 'rtl' : 'ltr');
  }, [language]);

  return null;
}
