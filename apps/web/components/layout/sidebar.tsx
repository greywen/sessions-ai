'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Monitor,
  MessageSquare,
  DollarSign,
  Settings2,
  Users,
  CreditCard,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/lib/i18n/provider';

interface NavDef {
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const mainNavItems: NavDef[] = [
  { key: 'nav.dashboard', href: '/', icon: LayoutDashboard },
  { key: 'nav.devices', href: '/devices', icon: Monitor },
  { key: 'nav.sessions', href: '/sessions', icon: MessageSquare },
  { key: 'nav.costs', href: '/costs', icon: DollarSign },
  { key: 'nav.configs', href: '/configs', icon: Settings2 },
  { key: 'nav.users', href: '/users', icon: Users },
];

const settingsNavItems: NavDef[] = [
  { key: 'nav.pricing', href: '/settings/pricing', icon: CreditCard },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const { t } = useI18n();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const NavItem = ({ item }: { item: NavDef }) => {
    const active = isActive(item.href);
    const Icon = item.icon;
    const label = t(item.key);

    const link = (
      <Link
        href={item.href}
        className={cn(
          'flex items-center gap-3 rounded-full px-3 py-2 text-sm font-normal transition-colors',
          active
            ? 'bg-[rgba(28,28,28,0.07)] text-foreground'
            : 'text-muted-foreground hover:bg-[rgba(28,28,28,0.03)] hover:text-foreground',
          collapsed && 'justify-center px-2',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed && <span>{label}</span>}
      </Link>
    );

    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    }

    return link;
  };

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300',
          collapsed ? 'w-16' : 'w-52',
        )}
      >
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-sidebar-border bg-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2),inset_0_0_0_0.5px_rgba(0,0,0,0.2),0_1px_2px_rgba(0,0,0,0.05)]">
              <Image src="/brand/logo.png" alt={t('common.appName')} width={64} height={64} className="h-full w-full object-cover" />
            </span>
            {!collapsed && (
              <div className="leading-tight">
                <span className="block text-[15px] tracking-[-0.02em]">{t('common.appName')}</span>
              </div>
            )}
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-2 py-4">
          {mainNavItems.map((item) => (
            <NavItem key={item.href} item={item} />
          ))}

          <Separator className="my-4" />

          {settingsNavItems.map((item) => (
            <NavItem key={item.href} item={item} />
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <Button variant="outline" size="icon" className="w-full" onClick={onToggle}>
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
