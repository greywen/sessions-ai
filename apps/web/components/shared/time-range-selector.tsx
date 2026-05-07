'use client';

import * as React from 'react';
import { format, startOfMonth, startOfYear } from 'date-fns';
import { CalendarIcon, Clock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

export interface TimeRangeValue {
  from: string; // yyyy-MM-dd
  to: string; // yyyy-MM-dd
}

interface PresetDef {
  key: string;
  getRange: () => { from: Date; to: Date };
}

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const PRESETS: PresetDef[] = [
  { key: 'today', getRange: () => ({ from: today(), to: today() }) },
  {
    key: '7d',
    getRange: () => {
      const to = today();
      const from = new Date(to);
      from.setDate(from.getDate() - 6);
      return { from, to };
    },
  },
  {
    key: '30d',
    getRange: () => {
      const to = today();
      const from = new Date(to);
      from.setDate(from.getDate() - 29);
      return { from, to };
    },
  },
  {
    key: '90d',
    getRange: () => {
      const to = today();
      const from = new Date(to);
      from.setDate(from.getDate() - 89);
      return { from, to };
    },
  },
  { key: 'mtd', getRange: () => ({ from: startOfMonth(today()), to: today() }) },
  { key: 'ytd', getRange: () => ({ from: startOfYear(today()), to: today() }) },
];

function parseLocalDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

interface TimeRangeSelectorProps {
  value: TimeRangeValue;
  onChange: (value: TimeRangeValue) => void;
  className?: string;
}

export function TimeRangeSelector({ value, onChange, className }: TimeRangeSelectorProps) {
  const { t, locale } = useI18n();
  const fnsLocale = dateFnsLocale(locale);

  const [open, setOpen] = React.useState(false);
  const [draftFrom, setDraftFrom] = React.useState<Date>(parseLocalDate(value.from));
  const [draftTo, setDraftTo] = React.useState<Date>(parseLocalDate(value.to));
  const [activePreset, setActivePreset] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraftFrom(parseLocalDate(value.from));
    setDraftTo(parseLocalDate(value.to));
  }, [value.from, value.to]);

  const handlePreset = (preset: PresetDef) => {
    const { from, to } = preset.getRange();
    setDraftFrom(from);
    setDraftTo(to);
    setActivePreset(preset.key);
  };

  const handleApply = () => {
    const fromStr = formatDate(draftFrom);
    const toStr = formatDate(draftTo > draftFrom ? draftTo : draftFrom);
    onChange({ from: fromStr, to: toStr });
    setOpen(false);
  };

  const handleCancel = () => {
    setDraftFrom(parseLocalDate(value.from));
    setDraftTo(parseLocalDate(value.to));
    setActivePreset(null);
    setOpen(false);
  };

  const displayFrom = parseLocalDate(value.from);
  const displayTo = parseLocalDate(value.to);
  const displayFmt = locale === 'zh' ? 'M月d日' : 'MMM d';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
            className,
          )}
        >
          <Clock className="size-4 text-muted-foreground" />
          <span>
            {format(displayFrom, displayFmt, { locale: fnsLocale })} - {format(displayTo, displayFmt, { locale: fnsLocale })}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" side="bottom" sideOffset={4} className="w-[620px] p-0">
        <div className="flex min-h-[340px]">
          {/* Presets */}
          <div className="w-[140px] border-r p-3 flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">
              {t('timeRange.presets')}
            </p>
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => handlePreset(preset)}
                className={cn(
                  'flex items-center px-3 py-2 rounded-md text-sm transition-colors text-left',
                  activePreset === preset.key
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent text-foreground',
                )}
              >
                {t(`timeRange.preset.${preset.key}`)}
              </button>
            ))}
          </div>

          {/* Date pickers */}
          <div className="flex-1 p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <CalendarIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t('timeRange.customRange')}</span>
            </div>

            <div className="mb-3">
              <label className="text-xs text-muted-foreground mb-1 block">{t('timeRange.startDate')}</label>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <span>{formatDate(draftFrom)}</span>
                    <CalendarIcon className="size-4 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={4} className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={draftFrom}
                    onSelect={(d) => {
                      if (d) {
                        setDraftFrom(d);
                        setActivePreset(null);
                      }
                    }}
                    locale={fnsLocale}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="mb-4">
              <label className="text-xs text-muted-foreground mb-1 block">{t('timeRange.endDate')}</label>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <span>{formatDate(draftTo)}</span>
                    <CalendarIcon className="size-4 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={4} className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={draftTo}
                    onSelect={(d) => {
                      if (d) {
                        setDraftTo(d);
                        setActivePreset(null);
                      }
                    }}
                    locale={fnsLocale}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="rounded-md bg-muted/50 border px-3 py-2 text-xs text-muted-foreground mb-4">
              {format(draftFrom, 'yyyy-MM-dd')} 00:00:00 — {format(draftTo, 'yyyy-MM-dd')} 23:59:59
            </div>

            <div className="flex justify-end gap-2 mt-auto">
              <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
                {t('common.cancel')}
              </Button>
              <Button type="button" size="sm" onClick={handleApply}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

export function getDefaultRange(days = 30): TimeRangeValue {
  const to = today();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  return { from: formatDate(from), to: formatDate(to) };
}

export function getMonthToDateRange(): TimeRangeValue {
  const to = today();
  const from = startOfMonth(to);
  return { from: formatDate(from), to: formatDate(to) };
}

export function rangeToIsoBounds(range: TimeRangeValue): { fromIso: string; toIso: string } {
  const fromDate = parseLocalDate(range.from);
  const toDate = parseLocalDate(range.to);
  toDate.setHours(23, 59, 59, 999);
  return { fromIso: fromDate.toISOString(), toIso: toDate.toISOString() };
}
