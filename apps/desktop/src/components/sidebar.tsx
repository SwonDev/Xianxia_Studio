import { Link, useRouterState } from '@tanstack/react-router';
import {
  LayoutDashboard,
  Sparkles,
  Library,
  CalendarClock,
  Settings,
  Download,
  Scissors,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Resumen',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'Estado general' },
    ],
  },
  {
    label: 'Producir',
    items: [
      { to: '/generator', label: 'Generador', icon: Sparkles, description: 'Vídeo desde un tema' },
      { to: '/shorts',    label: 'Smart Shorts', icon: Scissors, description: 'Extraer Shorts de un MP4' },
    ],
  },
  {
    label: 'Gestionar',
    items: [
      { to: '/library',   label: 'Biblioteca',   icon: Library, description: 'Vídeos producidos' },
      { to: '/scheduler', label: 'Planificador', icon: CalendarClock, description: 'Programación YouTube' },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { to: '/install',  label: 'Instalador', icon: Download, description: 'Modelos y runtime' },
      { to: '/settings', label: 'Ajustes',    icon: Settings, description: 'Configuración' },
    ],
  },
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
        <nav className="flex flex-col gap-3 flex-1 overflow-y-auto pr-1">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="px-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-paper-400/70 font-semibold">
                {group.label}
              </span>
              {group.items.map((item) => {
                const isActive = location.pathname === item.to;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      'group flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all duration-150',
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
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="pt-4 border-t border-border/40 px-2 space-y-2">
          <p className="text-[10.5px] text-muted-foreground leading-relaxed">
            Procesamiento 100% local. Sin APIs de IA externas.
          </p>
          <p className="text-[10px] text-paper-400 flex items-center gap-1.5">
            Pulsa
            <kbd className="font-mono text-[9px] bg-obsidian-800 border border-border/50 rounded px-1 py-0.5 text-gold-300">
              ?
            </kbd>
            para ver atajos
          </p>
        </div>
      </div>
    </aside>
  );
}
