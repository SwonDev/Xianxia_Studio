import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/scheduler')({
  component: SchedulerRoute,
});

interface ScheduledItem {
  id: string;
  title: string;
  scheduled_at: number;
  privacy: 'private' | 'unlisted' | 'public';
  is_short: boolean;
}

const MOCK_SCHEDULED: ScheduledItem[] = [
  // M6: this list will come from `tauri.listScheduled()` once wired.
];

function SchedulerRoute() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  const calendar = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const monthLabel = cursor.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduledItem[]>();
    for (const it of MOCK_SCHEDULED) {
      const k = new Date(it.scheduled_at * 1000).toDateString();
      const arr = map.get(k) ?? [];
      arr.push(it);
      map.set(k, arr);
    }
    return map;
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6"
    >
      <header className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
            Calendario
          </p>
          <h1 className="font-display text-4xl font-medium">Planificador</h1>
          <p className="text-paper-300 mt-2 max-w-2xl">
            Horarios óptimos para xianxia: jueves-sábado, 15:00 UTC.
          </p>
        </div>
        <button className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gold-500 text-obsidian-950 font-medium text-sm hover:bg-gold-300 transition-colors shadow-glow-gold">
          <Plus className="w-4 h-4" />
          Programar nuevo
        </button>
      </header>

      <section className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-xl capitalize">{monthLabel}</h2>
          <div className="flex gap-1">
            <NavBtn onClick={() => setCursor(addMonth(cursor, -1))} icon={ChevronLeft} />
            <button
              onClick={() => {
                const d = new Date();
                d.setDate(1);
                setCursor(d);
              }}
              className="px-3 py-1.5 rounded-md text-xs text-paper-300 hover:bg-obsidian-800"
            >
              Hoy
            </button>
            <NavBtn onClick={() => setCursor(addMonth(cursor, 1))} icon={ChevronRight} />
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[10.5px] uppercase tracking-wide text-paper-300 mb-2">
          {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {calendar.map((day, i) => {
            const dayItems = day ? itemsByDay.get(day.toDateString()) ?? [] : [];
            const isToday = day && isSameDay(day, new Date());
            const isOptimal = day && [4, 5, 6].includes(day.getDay()); // Thu-Sat (0=Sun)
            return (
              <div
                key={i}
                className={cn(
                  'min-h-[88px] p-2 rounded-md border flex flex-col gap-1',
                  day
                    ? isToday
                      ? 'border-gold-500/50 bg-gold-500/5'
                      : isOptimal
                      ? 'border-jade-500/20 bg-jade-700/5'
                      : 'border-border/30 bg-obsidian-800/30'
                    : 'border-transparent',
                )}
              >
                {day && (
                  <>
                    <div className="text-xs font-medium text-paper-300">{day.getDate()}</div>
                    {dayItems.map((it) => (
                      <div
                        key={it.id}
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded truncate',
                          it.is_short ? 'bg-jade-500/30 text-jade-300' : 'bg-gold-500/30 text-gold-300',
                        )}
                      >
                        {it.title}
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6">
        <h2 className="font-display text-xl mb-4">Próximas publicaciones</h2>
        {MOCK_SCHEDULED.length === 0 ? (
          <p className="text-sm text-paper-300">No hay publicaciones programadas todavía.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {MOCK_SCHEDULED.map((it) => (
              <li key={it.id} className="flex items-center justify-between p-3 rounded-md bg-obsidian-800/40 border border-border/30">
                <span>{it.title}</span>
                <span className="text-xs text-paper-300 font-mono">
                  {new Date(it.scheduled_at * 1000).toLocaleString('es-ES')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </motion.div>
  );
}

function NavBtn({ onClick, icon: Icon }: { onClick: () => void; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-md text-paper-300 hover:bg-obsidian-800 hover:text-paper-100"
    >
      <Icon className="w-4 h-4" />
    </button>
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
  // Start on Monday — JS Sunday=0
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
