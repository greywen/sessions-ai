'use client';

import React from 'react';
import { Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n/provider';
import { LanguageSwitcher } from '@/components/layout/language-switcher';

export default function LoginPage() {
  const { t } = useI18n();
  const [account, setAccount] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || t('login.error.signinFailed'));
        return;
      }

      // Force a full redirect so middleware auth runs again.
      window.location.href = '/';
    } catch {
      setError(t('login.error.network'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(220,188,153,0.18)_0%,rgba(220,188,153,0)_34%),radial-gradient(circle_at_88%_12%,rgba(152,186,207,0.16)_0%,rgba(152,186,207,0)_32%)]" />

      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitcher />
      </div>

      <div className="relative w-full max-w-sm space-y-6 rounded-2xl border border-border bg-card/95 p-6 backdrop-blur">
        <div className="flex flex-col items-center gap-2">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2),inset_0_0_0_0.5px_rgba(0,0,0,0.2),0_1px_2px_rgba(0,0,0,0.05)]">
            <Shield className="h-5 w-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{t('login.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="account" className="text-sm font-medium">
              {t('login.account')}
            </label>
            <Input
              id="account"
              type="text"
              placeholder={t('login.accountPlaceholder')}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              required
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              {t('login.password')}
            </label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('login.submitting') : t('login.submit')}
          </Button>
        </form>
      </div>
    </div>
  );
}
