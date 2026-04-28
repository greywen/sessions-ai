'use client';

import React from 'react';
import type { Locale } from '@/lib/i18n/dictionaries';
import { I18nProvider } from '@/lib/i18n/provider';

export function AppProviders({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale: Locale;
}) {
  return <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>;
}
