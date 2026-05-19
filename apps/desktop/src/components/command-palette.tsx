/**
 * Command Palette (⌘K / Ctrl-K) — Liquid Glass overlay (DESIGN.md v2).
 *
 * Pure navigation/actions surface. Preserves the real router: items
 * dispatch TanStack `navigate(...)` and existing global hooks. No demo
 * data. Mounted once at the app root; opens via ⌘K / Ctrl-K, closes on
 * Esc / backdrop / selection.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  MagnifyingGlass,
  House,
  Sparkle,
  Scissors,
  Books,
  CalendarBlank,
  DownloadSimple,
  GearSix,
  Keyboard,
  CaretRight,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

interface CmdItem {
  id: string;
  icon: PhosphorIcon;
  label: string;
  sub: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const go = (to: string) => () => {
    void navigate({ to });
    setOpen(false);
  };

  const items: CmdItem[] = [
    { id: 'generator', icon: Sparkle, label: 'Nuevo vídeo', sub: 'Empezar generación desde un tema', run: go('/generator') },
    { id: 'shorts', icon: Scissors, label: 'Smart Shorts', sub: 'Extraer clips de un MP4 existente', run: go('/shorts') },
    { id: 'library', icon: Books, label: 'Abrir biblioteca', sub: 'Ver vídeos producidos', run: go('/library') },
    { id: 'scheduler', icon: CalendarBlank, label: 'Planificador', sub: 'Cola de YouTube', run: go('/scheduler') },
    { id: 'dashboard', icon: House, label: 'Resumen', sub: 'Estado general del estudio', run: go('/') },
    { id: 'install', icon: DownloadSimple, label: 'Instalador', sub: 'Modelos y runtime', run: go('/install') },
    { id: 'settings', icon: GearSix, label: 'Ajustes', sub: 'Servicios, modelos, hardware', run: go('/settings') },
    {
      id: 'shortcuts',
      icon: Keyboard,
      label: 'Atajos de teclado',
      sub: 'Ver toda la lista (⇧?)',
      run: () => {
        setOpen(false);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true }));
      },
    },
  ];
  const filtered = items.filter((i) =>
    (i.label + ' ' + i.sub).toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          onClick={() => setOpen(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(8,8,12,0.62)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh',
          }}
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 480, damping: 30, mass: 0.7 }}
            style={{
              width: 560,
              background: 'var(--bg-popover)',
              borderRadius: 16,
              boxShadow: 'var(--shadow-popover)',
              overflow: 'hidden',
              transformOrigin: 'top center',
            }}
          >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 18px',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <MagnifyingGlass size={16} style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar comando, sección, ajuste…"
            aria-label="Buscar comando"
            style={{
              flex: 1,
              background: 'transparent',
              border: 0,
              outline: 0,
              fontSize: 16,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.005em',
              color: 'var(--text-primary)',
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 && (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              Sin resultados para "{q}"
            </div>
          )}
          {filtered.map((it, idx) => {
            const Icon = it.icon;
            return (
              <motion.button
                key={it.id}
                onClick={it.run}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.022 * idx + 0.05, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  textAlign: 'left',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span className="lg-tile md" style={{ '--tint': '#d4b85a' } as React.CSSProperties}>
                  <Icon size={14} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{it.sub}</div>
                </div>
                <CaretRight size={11} style={{ color: 'var(--text-quaternary)' }} />
              </motion.button>
            );
          })}
        </div>
        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          <span>
            <span className="kbd" style={{ marginRight: 4 }}>↵</span> abrir
          </span>
          <span style={{ marginLeft: 'auto' }}>Xianxia Studio</span>
        </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
