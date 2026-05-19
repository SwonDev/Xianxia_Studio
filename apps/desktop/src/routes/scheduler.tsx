import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CaretLeft, CaretRight, Plus, Trash } from '@phosphor-icons/react';
import { tauri, type ScheduledUpload } from '@/lib/tauri';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/ui-glass';

export const Route = createFileRoute('/scheduler')({
  component: SchedulerRoute,
});

// Real backing: `scheduled_uploads` (DB) via tauri.listScheduled. Rows are
// produced by pipeline Phase 9 after a successful YouTube upload; the
// internal cron flips `uploaded` → `published` when due. No mock data.
const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  uploaded: { label: 'Programado', color: 'var(--green)', bg: 'var(--green-bg)' },
  published: { label: 'Publicado', color: 'var(--gold-soft)', bg: 'var(--gold-bg)' },
  held: { label: 'Subido · privado', color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.06)' },
  failed: { label: 'Error', color: '#ffb1b8', bg: 'var(--red-bg)' },
};
function statusMeta(s: string) {
  return STATUS_META[s] ?? { label: s, color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.06)' };
}

function SchedulerRoute() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast, confirmDialog } = useToast();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['scheduled'],
    queryFn: tauri.listScheduled,
    refetchInterval: 8000,
  });

  const calendar = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const monthLabel = cursor.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduledUpload[]>();
    for (const it of items) {
      const k = new Date(it.scheduled_at * 1000).toDateString();
      const arr = map.get(k) ?? [];
      arr.push(it);
      map.set(k, arr);
    }
    return map;
  }, [items]);

  const cancel = async (it: ScheduledUpload) => {
    const ok = await confirmDialog({
      title: `¿Quitar "${it.title}" del planificador?`,
      body:
        it.status === 'uploaded'
          ? 'Se elimina la fila programada: el vídeo seguirá en YouTube como privado pero NO se publicará automáticamente.'
          : 'Se elimina esta entrada del planificador. No afecta al vídeo ya subido.',
      confirmLabel: 'Quitar',
      cancelLabel: 'Cancelar',
      danger: true,
    });
    if (!ok) return;
    try {
      await tauri.cancelScheduled(it.id);
      qc.invalidateQueries({ queryKey: ['scheduled'] });
      toast.success('Eliminado del planificador', it.title);
    } catch (e) {
      toast.error('No se pudo eliminar', String(e));
    }
  };

  return (
    <div className="route-enter page">
      <PageHeader
        title="Planificador"
        subtitle="Publicaciones programadas reales. Se crean al generar un vídeo con subida automática y fecha de publicación."
        action={
          <button className="btn-primary large" onClick={() => navigate({ to: '/generator' })}>
            <Plus size={11} weight="bold" />
            Programar nuevo
          </button>
        }
      />

      <div className="group" style={{ padding: 22, marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 className="title" style={{ textTransform: 'capitalize' }}>{monthLabel}</h2>
          <div className="segmented">
            <button className="segmented-btn" aria-label="Mes anterior" onClick={() => setCursor(addMonth(cursor, -1))}>
              <CaretLeft size={13} />
            </button>
            <button
              className="segmented-btn"
              onClick={() => {
                const d = new Date();
                d.setDate(1);
                setCursor(d);
              }}
            >
              Hoy
            </button>
            <button className="segmented-btn" aria-label="Mes siguiente" onClick={() => setCursor(addMonth(cursor, 1))}>
              <CaretRight size={13} />
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7,1fr)',
            gap: 4,
            textAlign: 'center',
            marginBottom: 8,
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
          }}
        >
          {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {calendar.map((day, i) => {
            const dayItems = day ? itemsByDay.get(day.toDateString()) ?? [] : [];
            const isToday = day && isSameDay(day, new Date());
            const cellStyle: CSSProperties = day
              ? {
                  minHeight: 84,
                  padding: 8,
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  background: isToday ? 'var(--gold-bg)' : 'rgba(255,255,255,0.03)',
                  boxShadow: isToday
                    ? '0 0 0 0.5px rgba(212,184,90,0.45)'
                    : 'inset 0 0.5px 0 rgba(255,255,255,0.05)',
                }
              : { minHeight: 84, opacity: 0, pointerEvents: 'none' };
            return (
              <div key={i} style={cellStyle}>
                {day && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>{day.getDate()}</div>
                    {dayItems.map((it) => {
                      const m = statusMeta(it.status);
                      return (
                        <div
                          key={it.id}
                          title={`${it.title} · ${m.label}`}
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            background: m.bg,
                            color: m.color,
                          }}
                        >
                          {it.is_short ? '▸ ' : ''}{it.title}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="group" style={{ padding: 22 }}>
        <h2 className="title" style={{ marginBottom: 14 }}>Publicaciones</h2>
        {isLoading ? (
          <p className="muted" style={{ fontSize: 13 }}>Cargando…</p>
        ) : items.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No hay publicaciones todavía. Genera un vídeo con <strong>subida automática</strong> y
            una <strong>fecha de publicación</strong> y aparecerá aquí.
          </p>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((it) => {
              const m = statusMeta(it.status);
              return (
                <li
                  key={it.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: m.bg,
                      color: m.color,
                      flexShrink: 0,
                    }}
                  >
                    {m.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.is_short ? '▸ ' : ''}{it.title}
                    </div>
                    {it.error_message && (
                      <div style={{ fontSize: 10.5, color: '#ffb1b8', marginTop: 2 }}>{it.error_message}</div>
                    )}
                  </div>
                  {it.youtube_video_id && (
                    <a
                      href={`https://youtube.com/watch?v=${it.youtube_video_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{ fontSize: 10.5, color: 'var(--gold-soft)' }}
                    >
                      ver
                    </a>
                  )}
                  <span className="mono" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                    {new Date(it.scheduled_at * 1000).toLocaleString('es-ES')}
                  </span>
                  <button
                    className="btn-ghost"
                    onClick={() => cancel(it)}
                    aria-label={`Quitar ${it.title}`}
                    style={{ padding: 6, height: 26 }}
                  >
                    <Trash size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function addMonth(d: Date, delta: number): Date {
  const r = new Date(d);
  r.setMonth(d.getMonth() + delta);
  return r;
}

function buildMonthGrid(monthCursor: Date): (Date | null)[] {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const offset = (firstDay.getDay() + 6) % 7;
  const cells: (Date | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
