'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { LanguageSwitcher } from './language-switcher';
import { APP_NAV_ITEMS } from './nav-items';

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const [me, setMe] = React.useState<{ name?: string | null; email?: string | null } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.user) {
          setMe(json.user);
        }
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const hasProfileInfo = Boolean(me?.name);
  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-30 border-b border-border/90 bg-background/90 backdrop-blur">
      <div className="flex h-16 w-full items-center gap-4 px-2 sm:px-4 md:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-sidebar-border bg-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2),inset_0_0_0_0.5px_rgba(0,0,0,0.2),0_1px_2px_rgba(0,0,0,0.05)]">
            <Image src="/brand/logo.png" alt={t('common.appName')} width={64} height={64} className="h-full w-full object-cover" />
          </span>
          <span className="hidden text-sm font-medium md:inline">{t('common.appName')}</span>
        </Link>

        <nav className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex min-w-max items-center gap-1 pr-2">
            {APP_NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(28,28,28,0.08)] text-foreground'
                    : 'text-muted-foreground hover:bg-[rgba(28,28,28,0.03)] hover:text-foreground',
                )}
              >
                {t(item.key)}
              </Link>
            ))}
          </div>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full">
                <User className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasProfileInfo ? (
                <>
                  <DropdownMenuLabel className="max-w-[220px] truncate">
                    {me?.name}
                    {me?.email ? <span className="ml-2 text-xs font-normal text-muted-foreground">{me.email}</span> : null}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                {t('common.signOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
