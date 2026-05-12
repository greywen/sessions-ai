import type React from 'react';
import {
  LayoutDashboard,
  MessageSquare,
  Monitor,
  Settings2,
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
  { key: 'nav.configs', href: '/configs', icon: Settings2 },
];
