export type Language = 'en' | 'es' | 'pt' | 'fr' | 'ar';
import en from './i18n/en.json';
import es from './i18n/es.json';
import pt from './i18n/pt.json';
import fr from './i18n/fr.json';
import ar from './i18n/ar.json';

/**
 * 'ar' is Moroccan Darija written in Arabic script — the language spoken over
 * the counter, not Modern Standard Arabic.
 *
 * Keys absent from a locale fall back to English (see `t` below), so a
 * partially translated locale shows English rather than raw key names. fr and
 * ar are translated for the screens staff use every shift; the deeper admin
 * screens still read English.
 */
const translations: Record<Language, Record<string, string>> = { en, es, pt, fr, ar };

/** Languages written right to left. */
export const RTL_LANGUAGES: readonly Language[] = ['ar'];

export function isRtl(lang: Language): boolean {
  return RTL_LANGUAGES.includes(lang);
}

const PLURAL_RE = /\{(\w+),\s*plural,\s*((?:\s*(?:zero|one|two|few|many|other)\s*\{[^}]*\})+)\s*\}/g;
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
  let pr = pluralRulesCache.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, pr);
  }
  return pr;
}

function formatIcuPlural(template: string, params: Record<string, string | number>, lang: Language): string {
  return template.replace(PLURAL_RE, (_match, name: string, cases: string) => {
    const raw = Number(params[name] ?? 0);
    const locale = lang === 'es' ? 'es-AR' : lang === 'pt' ? 'pt-BR'
      : lang === 'fr' ? 'fr-MA' : lang === 'ar' ? 'ar-MA' : 'en';
    const pr = getPluralRules(locale).select(raw);
    const ordered = ['zero', 'one', 'two', 'few', 'many', 'other'];
    const seen: Record<string, string> = {};
    const caseRe = /(zero|one|two|few|many|other)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(cases)) !== null) seen[m[1]] = m[2];
    let body = seen[pr];
    if (body === undefined) {
      const fallbackIdx = ordered.indexOf(pr) + 1;
      for (let i = fallbackIdx; i < ordered.length; i++) {
        if (seen[ordered[i]] !== undefined) { body = seen[ordered[i]]; break; }
      }
      if (body === undefined) body = seen.other ?? '';
    }
    return body.replace(/#/g, String(raw));
  });
}

export function t(key: string, lang: Language, params?: Record<string, string | number>): string {
  let value = translations[lang]?.[key] ?? translations.en[key] ?? key;
  if (params) {
    value = formatIcuPlural(value, params, lang);
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}

export function getBrowserLanguage(): Language {
  if (typeof navigator !== 'undefined') {
    const nav = navigator.language?.toLowerCase();
    if (nav?.startsWith('es')) return 'es';
    if (nav?.startsWith('pt')) return 'pt';
    if (nav?.startsWith('fr')) return 'fr';
    if (nav?.startsWith('ar')) return 'ar';
  }
  return 'en';
}

/**
 * On mount, fetches the tenant's preferred language from `/api/kds/info`
 * and pushes it into the global `usePosSettingsStore`. Cross-origin tabs
 * (KDS standalone) inherit the language set on the dashboard.
 *
 * Idempotent: only sets language if the server actually returned one.
 * Best-effort: never throws, never blocks the UI.
 */
import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';

export function useSyncServerLanguage(): void {
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);
  useEffect(() => {
    let cancelled = false;
    fetchServerInfo().then((info) => {
      if (cancelled) return;
      // Keep the existing tenant language when metadata is unavailable.
      if (info.language) setLanguage(info.language);
    });
    return () => {
      cancelled = true;
    };
  }, [setLanguage]);
}

export type ServerInfo = {
  language: Language | null;
  country: string | null;
  kdsDefaultView: 'tabs' | 'kanban' | null;
};

/**
 * Fetch the tenant's preferred language + KDS defaults from the public
 * KDS info endpoint. Never throws: on timeout/error returns empty info,
 * so callers fall back to local heuristics. 1500ms is generous for a LAN;
 * this must not block first paint of the login screen.
 */
export async function fetchServerInfo(baseUrl = '', timeoutMs = 1500): Promise<ServerInfo> {
  const empty: ServerInfo = { language: null, country: null, kdsDefaultView: null };
  if (typeof window === 'undefined') return empty;
  try {
    const res = await fetch(`${baseUrl}/api/kds/info`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      language?: string | null;
      country?: string | null;
      kds_default_view?: string | null;
    };
    return {
      language: data.language === 'es' ? 'es' : data.language === 'pt' ? 'pt' : data.language === 'en' ? 'en' : null,
      country: data.country || null,
      kdsDefaultView:
        data.kds_default_view === 'kanban' ? 'kanban' : data.kds_default_view === 'tabs' ? 'tabs' : null,
    };
  } catch {
    return empty;
  }
}
