/**
 * Sidebar — Liquid Glass macOS source-list (DESIGN.md v2), colapsable.
 *
 * Visual port of /design/shell.jsx Sidebar with the prototype's `rail`
 * mode wired as a real, persisted collapse toggle (232 ↔ 64 px). Motion
 * (motion.dev) drives the nav-item entrance stagger and respects
 * prefers-reduced-motion. Functional wiring preserved: TanStack `<Link>`
 * + `useRouterState`, `tauri.getAppVersion`, live `usePipelineStore`.
 */
import { useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import { MacTitlebar } from '@/components/mac-titlebar';
import {
  House,
  Sparkle,
  Scissors,
  Books,
  CalendarBlank,
  DownloadSimple,
  GearSix,
  SidebarSimple,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { tauri } from '@/lib/tauri';
import { usePipelineStore } from '@/lib/pipelineStore';

const TOTAL_PHASES = 13;
const COLLAPSE_KEY = 'xianxia.sidebar.collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: PhosphorIcon;
  tint: string;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Estudio',
    items: [
      { to: '/', label: 'Resumen', icon: House, tint: '#e8c96d' },
      { to: '/generator', label: 'Generador', icon: Sparkle, tint: '#d4b85a' },
      { to: '/shorts', label: 'Smart Shorts', icon: Scissors, tint: '#c9a84c' },
    ],
  },
  {
    label: 'Contenido',
    items: [
      { to: '/library', label: 'Biblioteca', icon: Books, tint: '#d4b85a' },
      { to: '/scheduler', label: 'Planificador', icon: CalendarBlank, tint: '#c9a84c' },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { to: '/install', label: 'Instalador', icon: DownloadSimple, tint: '#7a8a8a' },
      { to: '/settings', label: 'Ajustes', icon: GearSix, tint: '#5d7575' },
    ],
  },
];

function useLivePipeline() {
  const phaseState = usePipelineStore((s) => s.phaseState);
  const phases = Object.values(phaseState);
  const running = phases.some((p) => p.status === 'running');
  const current =
    phases.filter((p) => p.status === 'running').sort((a, b) => b.phase - a.phase)[0] ??
    phases.sort((a, b) => b.phase - a.phase)[0];
  return {
    running,
    phase: current?.phase ?? 0,
    progress: Math.round(current?.progress ?? 0),
  };
}

export function Sidebar() {
  const { location } = useRouterState();
  const reduce = useReducedMotion();
  const { data: appVersion } = useQuery({
    queryKey: ['app-version'],
    queryFn: tauri.getAppVersion,
    staleTime: Infinity,
  });
  const pipeline = useLivePipeline();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* noop */
      }
      return next;
    });
  };

  let navIndex = 0;

  return (
    <aside
      style={{
        width: collapsed ? 'var(--sidebar-rail)' : 'var(--sidebar-w)',
        flexShrink: 0,
        background: 'var(--glass-sidebar)',
        backdropFilter: 'blur(80px) saturate(200%)',
        WebkitBackdropFilter: 'blur(80px) saturate(200%)',
        borderRight: '0.5px solid rgba(255,255,255,0.07)',
        boxShadow: 'inset -0.5px 0 0 rgba(0,0,0,0.20)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        transition: 'width 240ms var(--ease-spring)',
        overflow: 'hidden',
      }}
    >
      {/* macOS-style title bar. The window is frameless
          (`decorations:false`), so the traffic lights here ARE the
          window controls (functional, not decoration). The whole strip
          is the drag region; the buttons opt out by not carrying the
          attribute. Height matches the Topbar so the chrome aligns. */}
      <div
        data-tauri-drag-region
        style={{
          height: 'var(--toolbar-h)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: collapsed ? 8 : 14,
        }}
      >
        <MacTitlebar collapsed={collapsed} />
      </div>

      <nav style={{ flex: 1, padding: collapsed ? '4px 8px' : '4px 10px', overflowY: 'auto', overflowX: 'hidden' }}>
        {NAV_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            {!collapsed && (
              <div style={{ padding: '6px 8px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>
                {g.label}
              </div>
            )}
            {g.items.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.to;
              const i = navIndex++;
              return (
                <motion.div
                  key={item.to}
                  initial={reduce ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: reduce ? 0 : 0.03 * i + 0.04, duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                >
                  <Link
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: collapsed ? '5px 0' : '5px 10px',
                      height: 34,
                      borderRadius: 999,
                      color: 'var(--text-primary)',
                      background: isActive ? 'var(--sidebar-selection)' : 'transparent',
                      boxShadow: isActive
                        ? 'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -0.5px 0 rgba(0,0,0,0.18), 0 0 0 0.5px rgba(232, 201, 109,0.45), 0 2px 6px rgba(0,0,0,0.22)'
                        : 'none',
                      transition: 'background 160ms var(--ease-spring)',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span className="lg-tile md" style={{ '--tint': item.tint } as React.CSSProperties}>
                      <Icon size={13} weight={isActive ? 'fill' : 'regular'} />
                    </span>
                    {!collapsed && (
                      <span style={{ fontSize: 13, fontWeight: isActive ? 500 : 400, whiteSpace: 'nowrap' }}>
                        {item.label}
                      </span>
                    )}
                  </Link>
                </motion.div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={toggle}
        aria-label={collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
        title={collapsed ? 'Expandir' : 'Colapsar'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: collapsed ? '0 8px 8px' : '0 10px 8px',
          padding: collapsed ? '7px 0' : '6px 10px',
          height: 30,
          borderRadius: 999,
          color: 'var(--text-secondary)',
          justifyContent: collapsed ? 'center' : 'flex-start',
          transition: 'background 120ms, color 120ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          e.currentTarget.style.color = 'var(--text-primary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
      >
        <SidebarSimple size={15} weight={collapsed ? 'fill' : 'regular'} />
        {!collapsed && <span style={{ fontSize: 12 }}>Colapsar</span>}
      </button>

      {/* Footer — live activity ring + local-only note */}
      {!collapsed && (
        <div style={{ padding: '10px 12px 12px', borderTop: '0.5px solid rgba(255,255,255,0.06)' }}>
          {pipeline.running && (
            <div
              style={{
                padding: '8px 10px',
                background: 'rgba(212, 184, 90,0.08)',
                borderRadius: 8,
                boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.08), 0 0 0 0.5px rgba(232, 201, 109,0.20)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <div style={{ position: 'relative', width: 18, height: 18, flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="2" />
                  <circle
                    cx="9"
                    cy="9"
                    r="7"
                    fill="none"
                    stroke="var(--accent-soft)"
                    strokeWidth="2"
                    strokeDasharray={`${(pipeline.phase / TOTAL_PHASES) * 44} 44`}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 600ms var(--ease-spring)', filter: 'drop-shadow(0 0 3px rgba(232, 201, 109,0.85))' }}
                  />
                </svg>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 8,
                    fontWeight: 700,
                    color: 'var(--accent-soft)',
                  }}
                >
                  {pipeline.phase}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 500 }}>Generando</div>
                <div className="caption" style={{ fontSize: 10, marginTop: 0 }}>
                  fase {pipeline.phase}/{TOTAL_PHASES} · {pipeline.progress}%
                </div>
              </div>
            </div>
          )}
          <p style={{ fontSize: 10, color: 'var(--text-quaternary)', display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
            Pulsa <span className="kbd">?</span> para ver atajos
          </p>
          <p style={{ fontSize: 10, color: 'var(--text-quaternary)', margin: '6px 0 0' }}>
            v{appVersion?.version ?? '…'}
          </p>
        </div>
      )}
      {collapsed && pipeline.running && (
        <div style={{ padding: '0 0 12px', display: 'flex', justifyContent: 'center' }} title={`Generando · fase ${pipeline.phase}/${TOTAL_PHASES}`}>
          <span className="dot dot-running pulse" />
        </div>
      )}
    </aside>
  );
}
