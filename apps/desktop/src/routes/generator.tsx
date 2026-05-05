import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Sparkles, Type, Volume2, Image as ImageIcon, Music,
  Film, Layout, Subtitles, Upload, CalendarClock,
  AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { tauri, events, type PhaseUpdate, type GenerateRequest } from '@/lib/tauri';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/generator')({
  component: GeneratorWizard,
});

const TOPIC_PRESETS = [
  'The legend of the Jade Emperor',
  'Origin of the Eight Immortals',
  'The Cultivation of Lü Dongbin',
  'The fall of the Demon Empress',
  'How the Dragon Kings divided the seas',
  'The Sword Saint of Mount Hua',
];

const PHASES = [
  { phase: 1, label: 'Guion', icon: Type, hint: 'Generación con Gemma 4' },
  { phase: 2, label: 'Metadatos', icon: Type, hint: 'Título, descripción, tags' },
  { phase: 3, label: 'Voz', icon: Volume2, hint: 'Qwen3-TTS' },
  { phase: 4, label: 'Imágenes', icon: ImageIcon, hint: 'Z-Image-Turbo' },
  { phase: 5, label: 'Música', icon: Music, hint: 'Biblioteca local' },
  { phase: 6, label: 'Vídeo', icon: Film, hint: 'HyperFrames' },
  { phase: 7, label: 'Thumbnail', icon: Layout, hint: 'Bilingüe' },
  { phase: 8, label: 'Subtítulos', icon: Subtitles, hint: 'faster-whisper' },
  { phase: 9, label: 'Upload', icon: Upload, hint: 'YouTube' },
  { phase: 10, label: 'Programación', icon: CalendarClock, hint: 'Cron + Shorts' },
];

function GeneratorWizard() {
  const [topic, setTopic] = useState('');
  const [minutes, setMinutes] = useState(14);
  const [languages, setLanguages] = useState<string[]>(['en', 'es']);
  const [experimental, setExperimental] = useState(false);
  const [useMusicgen, setUseMusicgen] = useState(false);
  const [voice, setVoice] = useState('Vivian');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [phaseState, setPhaseState] = useState<Record<number, PhaseUpdate>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unListenProgress: (() => void) | null = null;
    let unListenError: (() => void) | null = null;
    events.onPipelineProgress((p) => {
      if (!activeProjectId || p.project_id === activeProjectId) {
        setPhaseState((prev) => ({ ...prev, [p.phase]: p }));
      }
    }).then((u) => (unListenProgress = u));
    events.onPipelineError((e) => {
      if (!activeProjectId || e.project_id === activeProjectId) setError(e.error);
    }).then((u) => (unListenError = u));
    return () => {
      unListenProgress?.();
      unListenError?.();
    };
  }, [activeProjectId]);

  const handleStart = async () => {
    if (!topic.trim()) return;
    setError(null);
    setPhaseState({});
    const req: GenerateRequest = {
      topic: topic.trim(),
      languages,
      target_minutes: minutes,
      experimental_llm: experimental,
    };
    try {
      const id = await tauri.startGeneration(req);
      setActiveProjectId(id);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-8"
    >
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
          Producción
        </p>
        <h1 className="font-display text-4xl font-medium">Generador</h1>
        <p className="text-paper-300 mt-2 max-w-2xl">
          Elige un tema, ajusta los parámetros y deja que las 10 fases del pipeline
          produzcan tu vídeo de forma autónoma.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Left: configuration form */}
        <section className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6">
          <h2 className="font-display text-xl mb-5">1. Configura tu vídeo</h2>

          <Field label="Tema">
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="El ascenso del Inmortal del Trueno…"
              className="w-full bg-obsidian-800 border border-border/50 rounded-md px-3 py-2 text-paper-100 placeholder:text-paper-400 focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20"
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {TOPIC_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setTopic(p)}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-obsidian-800 hover:bg-obsidian-700 border border-border/40 text-paper-300 hover:text-paper-100 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Duración aproximada">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={25}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="flex-1 accent-gold-500"
              />
              <span className="font-mono text-sm tabular-nums w-12 text-right">{minutes} min</span>
            </div>
          </Field>

          <Field label="Idiomas">
            <div className="flex gap-2">
              {(['en', 'es', 'zh'] as const).map((l) => {
                const active = languages.includes(l);
                return (
                  <button
                    key={l}
                    onClick={() =>
                      setLanguages((prev) =>
                        active ? prev.filter((x) => x !== l) : [...prev, l],
                      )
                    }
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm border transition-all',
                      active
                        ? 'bg-gold-500/20 border-gold-500 text-gold-300'
                        : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                    )}
                  >
                    {l.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Voz narradora">
            <div className="relative">
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="w-full appearance-none bg-obsidian-800 border border-border/50 rounded-md pl-3 pr-9 py-2 text-paper-100 text-sm focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 cursor-pointer"
              >
                {['Vivian', 'Serena', 'Eric', 'Dylan', 'Aiden', 'Ryan'].map((v) => (
                  <option key={v} value={v} className="bg-obsidian-800 text-paper-100">{v}</option>
                ))}
              </select>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gold-400"
                viewBox="0 0 16 16" fill="none"
              >
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </Field>

          <Toggle
            label="Modo experimental (modelo abliterated)"
            description="Sin filtros de seguridad. Útil para xianxia oscuro. Bajo tu responsabilidad."
            checked={experimental}
            onChange={setExperimental}
            warning
          />

          <Toggle
            label="Generar música con MusicGen"
            description="Más lento pero original. Por defecto se usa la biblioteca local de pistas."
            checked={useMusicgen}
            onChange={setUseMusicgen}
          />

          <button
            onClick={handleStart}
            disabled={!topic.trim() || activeProjectId !== null}
            className={cn(
              'mt-6 w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md font-medium text-sm transition-colors',
              activeProjectId
                ? 'bg-obsidian-800 text-paper-300 cursor-not-allowed'
                : 'bg-gold-500 text-obsidian-950 hover:bg-gold-300 shadow-glow-gold',
            )}
          >
            <Sparkles className="w-4 h-4" />
            {activeProjectId ? 'Generación en curso…' : 'Iniciar generación'}
          </button>
        </section>

        {/* Right: pipeline progress */}
        <aside className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6">
          <h2 className="font-display text-xl mb-5">Pipeline</h2>
          <ol className="space-y-2">
            {PHASES.map((p) => {
              const update = phaseState[p.phase];
              const status = update?.status ?? 'pending';
              const Icon = p.icon;
              return (
                <li
                  key={p.phase}
                  className={cn(
                    'p-3 rounded-md border flex items-center gap-3 transition-colors',
                    status === 'done'
                      ? 'border-jade-500/40 bg-jade-700/10'
                      : status === 'running'
                      ? 'border-gold-500/40 bg-gold-500/5'
                      : status === 'failed'
                      ? 'border-crimson-500/50 bg-crimson-500/5'
                      : 'border-border/40 bg-obsidian-800/40',
                  )}
                >
                  <PhaseIcon status={status} fallback={Icon} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{p.label}</div>
                    <div className="text-[11px] text-paper-300 truncate">
                      {update?.message ?? p.hint}
                    </div>
                  </div>
                  {update && update.progress > 0 && update.progress < 100 && (
                    <span className="text-[11px] text-paper-300 font-mono tabular-nums">
                      {Math.round(update.progress)}%
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          {error && (
            <div className="mt-4 p-3 rounded-md bg-crimson-500/15 border border-crimson-500/40 text-xs text-paper-100 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-crimson-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </aside>
      </div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  warning,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  warning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'w-full text-left p-3 rounded-md border flex items-center gap-3 mb-3 transition-colors',
        checked
          ? warning
            ? 'border-crimson-500/50 bg-crimson-500/10'
            : 'border-gold-500/40 bg-gold-500/5'
          : 'border-border/40 bg-obsidian-800/40 hover:border-border',
      )}
    >
      <span
        className={cn(
          'w-9 h-5 rounded-full relative transition-colors shrink-0',
          checked ? (warning ? 'bg-crimson-500' : 'bg-gold-500') : 'bg-obsidian-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 w-4 h-4 rounded-full bg-paper-100 transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {label}
          {warning && checked && <AlertTriangle className="w-3 h-3 text-crimson-400" />}
        </div>
        <div className="text-[11px] text-paper-300">{description}</div>
      </div>
    </button>
  );
}

function PhaseIcon({ status, fallback: Fallback }: { status: string; fallback: React.ComponentType<{ className?: string }> }) {
  if (status === 'done') return <CheckCircle2 className="w-4 h-4 text-jade-400" />;
  if (status === 'running') return <Sparkles className="w-4 h-4 text-gold-400 animate-pulse" />;
  if (status === 'failed') return <AlertTriangle className="w-4 h-4 text-crimson-400" />;
  return <Fallback className="w-4 h-4 text-paper-300" />;
}
