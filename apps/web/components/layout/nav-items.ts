import type React from 'react';
import {
  CreditCard,
  DollarSign,
  LayoutDashboard,
  MessageSquare,
  Monitor,
  Settings2,
  Users,
} from 'lucide-react';

export interface NavDef {
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const APP_NAV_ITEMS: NavDef[] = [
  { key: 'nav.dashboard', href: '/', icon: LayoutDashboard },
  { key: 'nav.sessions', href: '/sessions', icon: MessageSquare },
  { key: 'nav.devices', href: '/devices', icon: Monitor },
  { key: 'nav.costs', href: '/costs', icon: DollarSign },
  { key: 'nav.configs', href: '/configs', icon: Settings2 },
  { key: 'nav.users', href: '/users', icon: Users },
  { key: 'nav.pricing', href: '/settings/pricing', icon: CreditCard },
];
