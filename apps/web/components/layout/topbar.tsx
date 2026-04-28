'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Menu, User, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { LanguageSwitcher } from './language-switcher';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
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

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/90 bg-background/90 px-4 backdrop-blur md:px-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onMenuClick}>
          <Menu className="h-5 w-5" />
        </Button>
        <span className="text-sm tracking-wide text-muted-foreground">{t('topbar.title')}</span>
      </div>

      <div className="flex items-center gap-2">
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
    </header>
  );
}
