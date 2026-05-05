import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden relative">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0 relative">
        <Topbar />
        <main className="flex-1 overflow-y-auto relative">
          <div className="px-8 py-8 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
