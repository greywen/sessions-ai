'use client';

import React from 'react';
import { TopBar } from './topbar';

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar />
      <main className="relative flex-1 overflow-y-auto">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(220,188,153,0.14)_0%,rgba(220,188,153,0)_38%),radial-gradient(circle_at_86%_14%,rgba(152,186,207,0.12)_0%,rgba(152,186,207,0)_32%)]" />
        <div className="relative w-full px-2 py-4 sm:px-4 md:px-6 md:py-6">
          {children}
        </div>
      </main>
      </div>
  );
}
