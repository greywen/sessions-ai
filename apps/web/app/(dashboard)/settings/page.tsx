'use client';

import { useI18n } from '@/lib/i18n/provider';

export default function Page() {
  const { t } = useI18n();
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('settings.placeholder')}</p>
    </div>
  );
}
