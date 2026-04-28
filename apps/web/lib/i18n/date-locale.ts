import { enUS, zhCN } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';
import type { Locale } from './dictionaries';

/** Map app locale to a date-fns locale. */
export function dateFnsLocale(locale: Locale): DateFnsLocale {
  return locale === 'zh' ? zhCN : enUS;
}
