/**
 * Topbar — Liquid Glass NSToolbar (DESIGN.md v2).
 *
 * Visual port of /design/shell.jsx Topbar + SystemPopover. ALL real
 * wiring preserved: hardware/sidecars/llama/appSettings react-query
 * probes feed a real System popover (no demo data); breadcrumb derives
 * from the active route; the ⌘K pill opens the real CommandPalette; the
 * status pill reflects the live `usePipelineStore`.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { MagnifyingGlass, CaretDown } from '@phosphor-icons/react';
import { tauri, type SidecarState, type LlamaCppStatus } from '@/lib/tauri';
import { usePipelineStore } from '@/lib/pipelineStore';

type DotState = 'running' | 'idle' | 'missing';

const ROUTE_LABELS: Record<string, string> = {
  '/': 'Resumen',
  '/generator': 'Generador',
  '/shorts': 'Smart Shorts',
  '/library': 'Biblioteca',
  '/scheduler': 'Planificador',
  '/install': 'Instalador',
  '/settings': 'Ajustes',
};

function dotClass(state: DotState): string {
  return state === 'running' ? 'dot dot-running' : state === 'idle' ? 'dot dot-idle' : 'dot dot-missing';
}

function openCommandPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }));
}

export function Topbar() {
  const { location } = useRouterState();
  const breadcrumb = ROUTE_LABELS[location.pathname] ?? 'Xianxia Studio';

  const running = usePipelineStore((s) =>
    Object.values(s.phaseState).some((p) => p.status === 'running'),
  );

  const { data: hw } = useQuery({
    queryKey: ['hardware'],
    queryFn: tauri.detectHardware,
    staleTime: 60_000,
  });
  const { data: sidecars } = useQuery<SidecarState>({
    queryKey: ['sidecars'],
    queryFn: tauri.getSidecarState,
    refetchInterval: 4000,
  });
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: tauri.appSettingsGet,
    staleTime: 60_000,
  });
  const { data: llama } = useQuery<LlamaCppStatus>({
    queryKey: ['llamacpp', 'status'],
    queryFn: tauri.llamacppStatus,
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const llamaState: DotState =
    sidecars?.llamacpp === 'running' ? 'running' : llama?.installed ? 'idle' : 'missing';

  const services: { state: DotState; label: string; href?: string }[] = [
    { state: llamaState, label: 'llama.cpp', href: '/settings' },
    ...(appSettings?.ollama_enabled
      ? [{ state: (sidecars?.ollama === 'running' ? 'running' : 'missing') as DotState, label: 'Ollama' }]
      : []),
    { state: sidecars?.python === 'running' ? 'running' : 'missing', label: 'Python' },
    { state: sidecars?.node === 'running' ? 'running' : 'missing', label: 'Node' },
    { state: sidecars?.comfyui === 'running' ? 'running' : 'missing', label: 'ComfyUI' },
  ];

  const [sysOpen, setSysOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setSysOpen(false);
    }
    if (sysOpen) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sysOpen]);

  const ramUsed = hw ? hw.total_ram_gb - hw.available_ram_gb : 0;
  const ramPct = hw && hw.total_ram_gb ? (ramUsed / hw.total_ram_gb) * 100 : 0;

  return (
    <header
      data-tauri-drag-region
      style={{
        height: 'var(--toolbar-h)',
        flexShrink: 0,
        background: 'var(--glass-toolbar)',
        backdropFilter: 'blur(80px) saturate(200%)',
        WebkitBackdropFilter: 'blur(80px) saturate(200%)',
        borderBottom: '0.5px solid rgba(255,255,255,0.07)',
        boxShadow: 'inset 0 -0.5px 0 rgba(0,0,0,0.14)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 18px',
        gap: 14,
        position: 'relative',
        zIndex: 20,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.005em' }}>
        {breadcrumb}
      </div>

      <div style={{ flex: 1 }} />

      <button
        onClick={openCommandPalette}
        aria-label="Abrir buscador de comandos"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 12px',
          height: 28,
          borderRadius: 999,
          background: 'rgba(0,0,0,0.26)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
          minWidth: 220,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 0.5px rgba(255,255,255,0.10)',
        }}
      >
        <MagnifyingGlass size={12} />
        <span>Buscar</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          <span className="kbd">⌘</span>
          <span className="kbd">K</span>
        </span>
      </button>

      <button
        onClick={() => setSysOpen((o) => !o)}
        aria-label="Estado del sistema"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 12px',
          height: 28,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.12)',
          backdropFilter: 'blur(30px) saturate(200%)',
          WebkitBackdropFilter: 'blur(30px) saturate(200%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.26), inset 0 -0.5px 0 rgba(0,0,0,0.18), 0 0 0 0.5px rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.22)',
        }}
      >
        <span className={running ? 'dot dot-running pulse' : 'dot dot-idle'} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>{running ? 'Generando' : 'Listo'}</span>
        <CaretDown size={10} style={{ color: 'var(--text-tertiary)' }} />
      </button>

      <AnimatePresence>
      {sysOpen && (
        <motion.div
          ref={popRef}
          initial={{ opacity: 0, y: -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 520, damping: 32, mass: 0.7 }}
          style={{
            position: 'absolute',
            top: 'calc(var(--toolbar-h) + 6px)',
            right: 16,
            width: 320,
            background: 'var(--bg-popover)',
            borderRadius: 14,
            boxShadow: 'var(--shadow-popover)',
            zIndex: 50,
            overflow: 'hidden',
            transformOrigin: 'top right',
          }}
        >
          <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={running ? 'dot dot-running pulse' : 'dot dot-idle'} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{running ? 'Generando vídeo' : 'Estudio listo'}</div>
              <div className="caption" style={{ marginTop: 1 }}>
                {running ? 'Pipeline en curso' : 'Sin tareas en curso'}
              </div>
            </div>
          </div>
          <div className="hr" />
          <div style={{ padding: '8px 6px' }}>
            {services.map((s) => {
              const body = (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', borderRadius: 5 }}>
                  <span className={dotClass(s.state)} />
                  <span style={{ flex: 1, fontSize: 12.5 }}>{s.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {s.state === 'running' ? 'Activo' : s.state === 'idle' ? 'Inactivo' : '—'}
                  </span>
                </div>
              );
              return s.href && s.state !== 'running' ? (
                <Link key={s.label} to={s.href} onClick={() => setSysOpen(false)} style={{ display: 'block' }}>
                  {body}
                </Link>
              ) : (
                <div key={s.label}>{body}</div>
              );
            })}
          </div>
          <div className="hr" />
          <div style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
              <span className="muted">CPU</span>
              <span className="mono" title={hw?.cpu_brand}>{hw ? `${hw.cpu_cores} cores` : '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', gap: 12 }}>
              <span className="muted">GPU</span>
              <span
                className="mono"
                title={hw?.gpu?.name}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {hw?.gpu
                  ? `${hw.gpu.name}${hw.gpu.vram_gb ? ` · ${hw.gpu.vram_gb} GB` : ''}`
                  : '—'}
              </span>
            </div>
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span className="muted">RAM</span>
                <span className="mono">
                  {hw ? `${ramUsed.toFixed(1)} / ${hw.total_ram_gb.toFixed(1)} GB` : '—'}
                </span>
              </div>
              <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 999, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${ramPct}%`,
                    height: '100%',
                    background: ramPct > 80 ? 'var(--red)' : 'var(--accent)',
                    transition: 'width 500ms var(--ease)',
                  }}
                />
              </div>
            </div>
          </div>
          <div className="hr" />
          <div style={{ padding: '6px 8px', display: 'flex', gap: 2 }}>
            <Link
              to="/settings"
              onClick={() => setSysOpen(false)}
              className="btn-ghost"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Abrir Ajustes
            </Link>
            <Link
              to="/install"
              onClick={() => setSysOpen(false)}
              className="btn-ghost"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              Instalador
            </Link>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </header>
  );
}
