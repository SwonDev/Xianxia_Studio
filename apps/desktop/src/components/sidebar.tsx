import { Link, useRouterState } from '@tanstack/react-router';
import {
  LayoutDashboard,
  Sparkles,
  Library,
  CalendarClock,
  Settings,
  Download,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'Estado general' },
  { to: '/generator', label: 'Generador', icon: Sparkles, description: 'Crear vídeo' },
  { to: '/library', label: 'Biblioteca', icon: Library, description: 'Vídeos producidos' },
  { to: '/scheduler', label: 'Planificador', icon: CalendarClock, description: 'Programación' },
  { to: '/install', label: 'Instalador', icon: Download, description: 'Modelos y runtime' },
  { to: '/settings', label: 'Ajustes', icon: Settings, description: 'Configuración' },
];

export function Sidebar() {
  const { location } = useRouterState();

  return (
    <aside className="w-60 shrink-0 border-r border-border/50 bg-sidebar relative overflow-hidden">
      <div className="flex flex-col h-full p-4 relative z-10">
        {/* Brand */}
        <div className="mb-8 px-2">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg overflow-hidden flex items-center justify-center shadow-glow-gold bg-paper-50 ring-1 ring-gold-500/40">
              <img src="/logo.svg" alt="Xianxia Studio" className="w-full h-full object-contain" />
            </div>
            <div className="flex flex-col">
              <span className="font-display text-lg leading-tight text-shimmer-gold font-semibold">
                Xianxia Studio
              </span>
              <span className="text-xs text-muted-foreground tracking-wide">v0.1.0</span>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 flex-1">
          {NAV.map((item) => {
            const isActive = location.pathname === item.to;
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'group flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-all duration-150',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-l-gold-500 pl-[10px]'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'w-4 h-4 transition-colors',
                    isActive ? 'text-gold-300' : 'text-paper-300 group-hover:text-gold-400',
                  )}
                />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="font-medium leading-tight">{item.label}</span>
                  <span className="text-[10.5px] text-muted-foreground tracking-wide truncate">
                    {item.description}
                  </span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="pt-4 border-t border-border/40 px-2">
          <p className="text-[10.5px] text-muted-foreground leading-relaxed">
            Procesamiento 100% local. Sin APIs de IA externas.
          </p>
        </div>
      </div>
    </aside>
  );
}
