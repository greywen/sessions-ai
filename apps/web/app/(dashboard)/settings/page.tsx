'use client';

import { useI18n } from '@/lib/i18n/provider';

export default function Page() {
  const { t } = useI18n();
  return (
    <div>
      <p className="text-muted-foreground">{t('settings.placeholder')}</p>
    </div>
  );
}
