'use client';

import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/Sidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import StatusBar from '@/components/layout/StatusBar';
import GlobalNotifications from '@/components/layout/GlobalNotifications';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPos = pathname === '/pos' || pathname === '/kds';

  return (
    <AuthGuard>
      <SidebarProvider defaultOpen>
        <AppSidebar />
        <SidebarInset className="h-screen overflow-hidden flex flex-col">
          {!isPos && <GlobalNotifications />}
          {/* The till gets a faint grey ground, the management screens keep the
              white one. Product tiles are white cards: on a white page they
              would be separated by a hairline alone, which is fine for a table
              of figures but not for something a cashier has to hit with a
              finger without looking. */}
          <div className={isPos
            ? 'flex-1 min-h-0 flex flex-col overflow-hidden p-4 bg-muted/40'
            : 'flex-1 p-4 overflow-auto min-w-0'
          }>
            {children}
          </div>
          <StatusBar />
        </SidebarInset>
      </SidebarProvider>
    </AuthGuard>
  );
}
