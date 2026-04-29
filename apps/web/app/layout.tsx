import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Toaster } from 'sonner';
import { AppProviders } from '@/components/providers';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_KEY,
  SUPPORTED_LOCALES,
  type Locale,
} from '@/lib/i18n/dictionaries';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sessions-ai - AI Assistant Audit Management',
  description: 'Enterprise distributed AI assistant audit & remote configuration management system',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon.png', type: 'image/png' },
    ],
    shortcut: [{ url: '/favicon.ico' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

function isSupportedLocale(value: string | null | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as string[]).includes(value);
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const localeFromCookie = cookieStore.get(LOCALE_COOKIE_KEY)?.value;
  const initialLocale = isSupportedLocale(localeFromCookie) ? localeFromCookie : DEFAULT_LOCALE;
  const htmlLang = initialLocale === 'zh' ? 'zh-CN' : 'en';

  return (
    <html lang={htmlLang} suppressHydrationWarning className="font-sans">
      <body className="min-h-screen bg-background antialiased">
        <AppProviders initialLocale={initialLocale}>{children}</AppProviders>
        <Toaster
          position="top-right"
          toastOptions={{
            className: 'border border-border bg-card text-foreground shadow-[0_4px_12px_rgba(0,0,0,0.1)]',
          }}
        />
      </body>
    </html>
  );
}
