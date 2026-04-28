'use client';

import React from 'react';
import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_COOKIE_KEY,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  type Locale,
} from './dictionaries';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

interface I18nProviderProps {
  children: React.ReactNode;
  initialLocale?: Locale;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function isSupported(value: string | null | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as string[]).includes(value);
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (Object.prototype.hasOwnProperty.call(params, k)) return String(params[k]);
    return m;
  });
}

function lookup(locale: Locale, key: string): string {
  const dict = DICTIONARIES[locale];
  const v = dict[key];
  if (v !== undefined) return v;
  const fallback = DICTIONARIES[DEFAULT_LOCALE][key];
  return fallback ?? key;
}

function localeToDocumentLang(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${LOCALE_COOKIE_KEY}=`;
  const raw = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return isSupported(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children, initialLocale = DEFAULT_LOCALE }: I18nProviderProps) {
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale);

  const persistLocale = React.useCallback((next: Locale) => {
    document.documentElement.lang = localeToDocumentLang(next);
    document.cookie = `${LOCALE_COOKIE_KEY}=${encodeURIComponent(next)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable in private mode or restricted environments.
    }
  }, []);

  // Backward compatibility: migrate old localStorage-only preference when cookie is missing.
  React.useEffect(() => {
    if (readLocaleCookie()) return;
    try {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isSupported(saved)) {
        setLocaleState(saved);
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  React.useEffect(() => {
    persistLocale(locale);
  }, [locale, persistLocale]);

  const setLocale = React.useCallback(
    (next: Locale) => {
      setLocaleState(next);
      persistLocale(next);
    },
    [persistLocale],
  );

  const t = React.useCallback(
    (key: string, params?: Record<string, string | number>) => format(lookup(locale, key), params),
    [locale],
  );

  const value = React.useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

export type DateFnsLocaleResolver = () => Promise<Locale>;
