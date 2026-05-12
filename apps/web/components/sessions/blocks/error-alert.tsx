'use client';

import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useI18n } from '@/lib/i18n/provider';

interface ErrorAlertProps {
  message: string;
}

// Error block.
export function ErrorAlert({ message }: ErrorAlertProps) {
  const { t } = useI18n();
  return (
    <Alert variant="destructive" className="my-1">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{t('block.error')}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm">
        {message}
      </AlertDescription>
    </Alert>
  );
}
