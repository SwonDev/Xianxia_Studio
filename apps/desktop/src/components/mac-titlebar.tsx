/**
 * MacTitlebar — controles de ventana estilo macOS 2026 (semáforos
 * FUNCIONALES, no decorativos).
 *
 * Rojo = cerrar · Amarillo = minimizar · Verde = maximizar/restaurar.
 * Los glyphs (✕ ─ +) sólo aparecen al pasar el cursor por el grupo,
 * igual que macOS. La ventana es frameless (`decorations:false`), así
 * que estos botones son los únicos controles de ventana.
 *
 * Se monta dentro del strip superior del Sidebar, que es la
 * `data-tauri-drag-region`. Estos botones NO llevan ese atributo, por
 * lo que son clicables mientras el resto del strip arrastra la ventana
 * (patrón oficial de Tauri window-customization).
 *
 * En modo navegador (`pnpm dev:browser`, sin `__TAURI_INTERNALS__`) los
 * handlers son no-op seguros: el chrome se ve pero no rompe.
 */
import { useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const IS_TAURI =
  typeof window !== 'undefined' &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined;

async function runWindow(action: 'close' | 'minimize' | 'toggleMaximize') {
  if (!IS_TAURI) return; // navegador dev: no-op
  try {
    const w = getCurrentWindow();
    if (action === 'close') await w.close();
    else if (action === 'minimize') await w.minimize();
    else await w.toggleMaximize();
  } catch (e) {
    console.error('window control', action, e);
  }
}

interface LightSpec {
  key: 'close' | 'minimize' | 'toggleMaximize';
  color: string;
  label: string;
  glyph: string;
}

const LIGHTS: LightSpec[] = [
  { key: 'close', color: '#ff5f57', label: 'Cerrar', glyph: '✕' },
  { key: 'minimize', color: '#febc2e', label: 'Minimizar', glyph: '─' },
  { key: 'toggleMaximize', color: '#28c840', label: 'Maximizar', glyph: '+' },
];

export function MacTitlebar({ collapsed = false }: { collapsed?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const size = 12;

  return (
    <div
      // The buttons themselves must NOT be a drag region (they need
      // click). The surrounding strip in the Sidebar handles dragging.
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Aligned like macOS: a touch of inset from the window edge.
        paddingLeft: collapsed ? 0 : 4,
      }}
      role="group"
      aria-label="Controles de ventana"
    >
      {LIGHTS.map((l) => (
        <button
          key={l.key}
          onClick={() => void runWindow(l.key)}
          aria-label={l.label}
          title={l.label}
          style={{
            width: size,
            height: size,
            borderRadius: 999,
            background: l.color,
            // macOS-style 0.5px darkening ring for definition on light bg.
            boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.16)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            cursor: 'default',
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              fontSize: l.key === 'minimize' ? 9 : 8,
              lineHeight: 1,
              fontWeight: 700,
              color: 'rgba(0,0,0,0.58)',
              opacity: hovered ? 1 : 0,
              transition: 'opacity 120ms var(--ease, ease)',
              transform: 'translateY(-0.5px)',
              userSelect: 'none',
            }}
          >
            {l.glyph}
          </span>
        </button>
      ))}
    </div>
  );
}
