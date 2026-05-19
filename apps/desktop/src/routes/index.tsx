import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Plus,
  Sparkle,
  Scissors,
  Books,
  CalendarBlank,
  DownloadSimple,
  Lightning,
  CaretRight,
} from '@phosphor-icons/react';
import { tauri } from '@/lib/tauri';
import { usePipelineStore } from '@/lib/pipelineStore';
import { PageHeader, Group, Row } from '@/components/ui-glass';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

const PHASE_LABELS = [
  'Guion', 'SEO', 'Voz', 'Imágenes', 'Música', 'Vídeo',
  'Thumbnail', 'Subtítulos', 'Subida', 'Shorts', 'Engagement',
  'SEO pack', 'Marca de agua',
];
const TOTAL_PHASES = 13;

function LivePipelineStrip({ onClick }: { onClick: () => void }) {
  const phaseState = usePipelineStore((s) => s.phaseState);
  const phases = Object.values(phaseState);
  const current =
    phases.filter((p) => p.status === 'running').sort((a, b) => b.phase - a.phase)[0] ??
    phases.sort((a, b) => b.phase - a.phase)[0];
  if (!current) return null;
  const ph = current.phase;
  return (
    <button
      onClick={onClick}
      className="fade-up"
      style={{
        width: '100%',
        background: 'var(--bg-list)',
        borderRadius: 'var(--r-lg)',
        padding: '12px 14px',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginBottom: 22,
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-list-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-list)')}
    >
      <div style={{ position: 'relative', width: 28, height: 28, flexShrink: 0 }}>
        <svg width="28" height="28" viewBox="0 0 28 28" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
          <circle
            cx="14"
            cy="14"
            r="11"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeDasharray={`${(ph / TOTAL_PHASES) * 69} 69`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 500ms var(--ease-spring)' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {ph}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dot dot-running pulse" />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Generando · {PHASE_LABELS[ph - 1] ?? `Fase ${ph}`}
          </span>
        </div>
        <div className="caption" style={{ marginTop: 2 }}>
          {current.message ?? `Fase ${ph} de ${TOTAL_PHASES}`}
        </div>
      </div>
      <CaretRight size={12} className="chev" />
    </button>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const { data: version } = useQuery({ queryKey: ['app-version'], queryFn: tauri.getAppVersion });
  const { data: hw } = useQuery({ queryKey: ['hardware'], queryFn: tauri.detectHardware });
  const running = usePipelineStore((s) =>
    Object.values(s.phaseState).some((p) => p.status === 'running'),
  );

  const hwValue = hw
    ? `${hw.cpu_cores}c · ${hw.total_ram_gb.toFixed(0)} GB${hw.gpu ? ` · ${hw.gpu.name}` : ''}`
    : 'Detectando…';

  return (
    <div className="route-enter page">
      <PageHeader
        title="Resumen"
        subtitle="Todo lo que ocurre en el estudio en una sola pantalla."
        action={
          <button className="btn-primary large" onClick={() => navigate({ to: '/generator' })}>
            <Plus size={11} weight="bold" />
            Nuevo vídeo
          </button>
        }
      />

      {running && <LivePipelineStrip onClick={() => navigate({ to: '/generator' })} />}

      <Group label="Sistema">
        <Row
          icon={Lightning}
          iconColor="#d4b85a"
          title="Hardware"
          sub={hw?.cpu_brand ?? 'Detectando…'}
          value={hwValue}
          chev
          onClick={() => navigate({ to: '/settings' })}
        />
        <Row
          icon={DownloadSimple}
          iconColor="#7a8a8a"
          title="Instalador"
          sub="Modelos y runtime local"
          chev
          onClick={() => navigate({ to: '/install' })}
        />
      </Group>

      <Group label="Contenido">
        <Row
          icon={Books}
          iconColor="#e8c96d"
          title="Biblioteca"
          sub="Vídeos producidos en este equipo"
          chev
          onClick={() => navigate({ to: '/library' })}
        />
        <Row
          icon={CalendarBlank}
          iconColor="#d4b85a"
          title="Planificador"
          sub="Cola de publicación de YouTube"
          chev
          onClick={() => navigate({ to: '/scheduler' })}
        />
      </Group>

      <Group label="Atajos">
        <Row
          icon={Sparkle}
          iconColor="#d4b85a"
          title="Generar vídeo nuevo"
          sub="Tema → vídeo cinematográfico"
          value="⌘K"
          chev
          onClick={() => navigate({ to: '/generator' })}
        />
        <Row
          icon={Scissors}
          iconColor="#c9a84c"
          title="Smart Shorts"
          sub="Extraer clips virales de un MP4"
          chev
          onClick={() => navigate({ to: '/shorts' })}
        />
      </Group>

      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 32 }}>
        Xianxia Studio {version?.version ?? '…'} · Tauri {version?.tauri ?? '…'} ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {hw?.os ?? '—'}/{hw?.arch ?? '—'}
        </span>{' '}
        · 100% local
      </div>
    </div>
  );
}
