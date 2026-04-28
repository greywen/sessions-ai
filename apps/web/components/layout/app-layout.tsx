'use client';

import React from 'react';
import { Sidebar } from './sidebar';
import { TopBar } from './topbar';
import { Sheet, SheetContent } from '@/components/ui/sheet';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      console.debug('[Layout] Sidebar:', sidebarCollapsed ? 'Collapsed' : 'Open');
    }
  }, [sidebarCollapsed]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="hidden md:block">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main className="relative flex-1 overflow-y-auto">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(220,188,153,0.14)_0%,rgba(220,188,153,0)_38%),radial-gradient(circle_at_86%_14%,rgba(152,186,207,0.12)_0%,rgba(152,186,207,0)_32%)]" />
          <div className="relative mx-auto w-full max-w-[1220px] px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
