/**
 * ChapterPreview — muestra el estado de cada capítulo del pipeline
 * long-form y la ETA calculada en Rust. Se monta siempre en el aside
 * del generador; retorna null cuando no hay capítulos (no hay datos demo).
 *
 * Primitivos: .group / .row / .lg-tile / tokens semánticos de globals.css
 * (DESIGN.md v2 · Liquid Glass). Sin partículas, sin Math.random decorativo.
 */
import type { CSSProperties } from 'react';
import {
  CheckCircle,
  CircleNotch,
  Warning,
  Article,
} from '@phosphor-icons/react';
import { usePipelineStore } from '@/lib/pipelineStore';

export function ChapterPreview() {
  const chapters = usePipelineStore((s) => s.chapters);
  const eta = usePipelineStore((s) => s.eta);

  if (Object.keys(chapters).length === 0) return null;

  // Orden ascendente por índice (1-based)
  const sorted = Object.entries(chapters)
    .map(([k, v]) => ({ index: Number(k), ...v }))
    .sort((a, b) => a.index - b.index);

  // ETA formateada: mm:ss
  let etaLine: string | null = null;
  if (eta !== null) {
    const secs = Math.max(0, Math.round(eta.secondsLeft));
    const mm = Math.floor(secs / 60);
    const ss = secs % 60;
    etaLine = `≈ ${mm}m ${ss.toString().padStart(2, '0')}s restantes · ${eta.basis}`;
  }

  return (
    <div style={{ marginTop: 16 }} data-testid="chapter-preview">
      <div
        className="section-header sub"
        style={{ marginBottom: 8 }}
      >
        Capítulos
      </div>

      {etaLine && (
        <div
          style={{
            marginBottom: 8,
            fontSize: 11,
            color: 'var(--accent-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
          data-testid="chapter-eta"
        >
          <CircleNotch size={11} className="spin" />
          {etaLine}
        </div>
      )}

      <div className="group">
        {sorted.map((ch) => {
          const tint = statusTint(ch.status);
          return (
            <div
              key={ch.index}
              className="row with-icon"
              data-testid={`chapter-row-${ch.index}`}
            >
              {/* Icono de estado con lg-tile */}
              <span
                className="lg-tile sm"
                style={{ '--tint': tint, flexShrink: 0 } as CSSProperties}
              >
                <StatusIcon status={ch.status} />
              </span>

              {/* Título + palabras */}
              <div className="row-label">
                <div
                  className="row-title"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {ch.index}.{' '}
                  </span>
                  {ch.title || <span style={{ color: 'var(--text-tertiary)' }}>Capítulo {ch.index}</span>}
                </div>
              </div>

              {/* Pill de estado + palabras */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {ch.words > 0 && (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: 'var(--text-tertiary)' }}
                  >
                    {ch.words}p
                  </span>
                )}
                <StatusPill status={ch.status} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type ChapterStatus = 'pending' | 'writing' | 'done' | 'failed';

function statusTint(status: ChapterStatus): string {
  switch (status) {
    case 'done':    return '#7fa8d8'; // --green (azul sereno)
    case 'writing': return '#d4b85a'; // --accent
    case 'failed':  return '#c8525e'; // --red
    default:        return '#7a8a8a'; // --nephrite (pending)
  }
}

function StatusIcon({ status }: { status: ChapterStatus }) {
  switch (status) {
    case 'done':    return <CheckCircle size={11} weight="fill" />;
    case 'writing': return <CircleNotch size={11} className="spin" />;
    case 'failed':  return <Warning size={11} />;
    default:        return <Article size={11} />;
  }
}

function StatusPill({ status }: { status: ChapterStatus }) {
  const styles: Record<ChapterStatus, CSSProperties> = {
    done: {
      color: 'var(--green)',
      background: 'var(--green-bg)',
    },
    writing: {
      color: 'var(--accent-soft)',
      background: 'var(--accent-bg)',
    },
    failed: {
      color: 'var(--red)',
      background: 'var(--red-bg)',
    },
    pending: {
      color: 'var(--text-tertiary)',
      background: 'rgba(255,255,255,0.05)',
    },
  };

  const labels: Record<ChapterStatus, string> = {
    done:    'listo',
    writing: 'escribiendo',
    failed:  'error',
    pending: 'pendiente',
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 500,
        ...styles[status],
      }}
    >
      {labels[status]}
    </span>
  );
}
