'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

interface DatePickerProps {
  value: string; // yyyy-MM-dd or empty
  onChange: (value: string) => void;
  placeholder?: string;
  clearable?: boolean;
  className?: string;
  disabled?: boolean;
}

function parseLocalDate(s: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  clearable = false,
  className,
  disabled,
}: DatePickerProps) {
  const { locale } = useI18n();
  const fnsLocale = dateFnsLocale(locale);
  const [open, setOpen] = React.useState(false);
  const date = parseLocalDate(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50',
            !date && 'text-muted-foreground',
            className,
          )}
        >
          <span className="flex items-center gap-2">
            <CalendarIcon className="size-4 text-muted-foreground" />
            {date ? format(date, 'yyyy-MM-dd', { locale: fnsLocale }) : placeholder ?? 'YYYY-MM-DD'}
          </span>
          {clearable && date && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              className="rounded p-0.5 hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
            >
              <X className="size-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (d) {
              onChange(format(d, 'yyyy-MM-dd'));
              setOpen(false);
            }
          }}
          locale={fnsLocale}
        />
      </PopoverContent>
    </Popover>
  );
}
