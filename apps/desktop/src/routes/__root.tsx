import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { CommandPalette } from '@/components/command-palette';
import { ensurePipelineSubscription } from '@/lib/pipelineStore';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  const { location } = useRouterState();
  const reduce = useReducedMotion();

  // Subscribe to pipeline events ONCE at the app root (this layout never
  // unmounts during navigation). Keeps generation progress flowing into
  // the global store even when the generator route isn't mounted.
  useEffect(() => {
    ensurePipelineSubscription();
  }, []);

  // Liquid Glass shell (DESIGN.md v2): glass source-list Sidebar +
  // NSToolbar Topbar + scrollable main. Routing stays TanStack (Outlet);
  // motion.dev gives a coordinated per-route entrance over the existing
  // CSS layer. NO particles / decorative canvas in this project — ever.
  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden', position: 'relative' }}>
      <Sidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Topbar />
        <main style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              style={{ minHeight: '100%' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <CommandPalette />
      <KeyboardShortcuts />
    </div>
  );
}
