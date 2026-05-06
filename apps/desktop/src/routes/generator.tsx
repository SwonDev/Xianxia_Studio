import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Sparkles, Type, Volume2, Image as ImageIcon, Music,
  Film, Layout, Subtitles, Upload, CalendarClock,
  AlertTriangle, CheckCircle2, Loader2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { tauri, events, type PhaseUpdate, type GenerateRequest, type ImageReadyEvent } from '@/lib/tauri';
import { convertFileSrc } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils';

interface VoiceProfile {
  id: string;
  label: string;
  gender: string;
  tone: string;
  languages: string[];
  primary: string;
  description: string;
}

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

// Persisted across reloads so the user doesn't lose their topic if they
// accidentally close the window or the dev server reloads.
const STORAGE_KEY = 'xianxia.generator.draft';
function loadDraft(): {
  topic: string; minutes: number; languages: string[];
  voice: string; vertical: boolean;
  animation: 'cinematic' | 'dynamic' | 'minimal' | 'dramatic';
  caption: 'xianxia' | 'hormozi' | 'mrbeast' | 'minimal' | 'neon';
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveDraft(d: ReturnType<typeof loadDraft>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch { /* */ }
}

function GeneratorWizard() {
  const draft = loadDraft();
  const [topic, setTopic] = useState(draft?.topic ?? '');
  const [minutes, setMinutes] = useState(draft?.minutes ?? 14);
  const [languages, setLanguages] = useState<string[]>(draft?.languages ?? ['en', 'es']);
  const [experimental, setExperimental] = useState(false);
  const [useMusicgen, setUseMusicgen] = useState(false);
  const [autoShorts, setAutoShorts] = useState(false);
  const [analyzeEngagement, setAnalyzeEngagement] = useState(true);
  const [autoOptimizeEngagement, setAutoOptimizeEngagement] = useState(false);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [animationPreset, setAnimationPreset] = useState<'cinematic' | 'dynamic' | 'minimal' | 'dramatic'>(draft?.animation ?? 'cinematic');
  const [captionStyle, setCaptionStyle] = useState<'xianxia' | 'hormozi' | 'mrbeast' | 'minimal' | 'neon'>(draft?.caption ?? 'xianxia');
  const [voice, setVoice] = useState(draft?.voice ?? 'vivian');
  const [vertical, setVertical] = useState(draft?.vertical ?? false);
  const [suggesting, setSuggesting] = useState(false);
  const [topicIdeas, setTopicIdeas] = useState<{ title: string; hook: string }[] | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [phaseState, setPhaseState] = useState<Record<number, PhaseUpdate>>({});
  const [error, setError] = useState<string | null>(null);
  const [imageThumbs, setImageThumbs] = useState<ImageReadyEvent[]>([]);

  // Primary language drives the voice catalog. Defaults to first selected.
  const primaryLang = languages[0] ?? 'en';

  // Fetch voices contextual to the primary language.
  const { data: voices } = useQuery<VoiceProfile[]>({
    queryKey: ['voices', primaryLang],
    queryFn: async () => {
      const res = await fetch(`http://127.0.0.1:8731/tts/voices?language=${primaryLang}`);
      if (!res.ok) throw new Error(`voices: ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Music backend availability — drives the toggle label so the user knows
  // whether ACE-Step v1.5 (preferred) or MusicGen-medium (fallback) will run.
  const { data: musicBackends } = useQuery<{
    acestep_available: boolean;
    musicgen_available: boolean;
    preferred: 'acestep' | 'musicgen' | null;
  }>({
    queryKey: ['music-backends'],
    queryFn: async () => {
      const r = await fetch('http://127.0.0.1:8731/music/backends');
      if (!r.ok) throw new Error(`music backends: ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Auto-pick a sensible default when language changes and current voice doesn't fit.
  useEffect(() => {
    if (!voices || voices.length === 0) return;
    const ok = voices.some((v) => v.id === voice);
    if (!ok && voices[0]) setVoice(voices[0].id);
  }, [voices, voice]);

  // Use a ref so the listener callback always sees the current activeProjectId
  // without needing to re-subscribe on every change (which races with events).
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeProjectId;

  // Auto-save form state to localStorage so reload doesn't lose work in progress.
  useEffect(() => {
    saveDraft({
      topic, minutes, languages, voice, vertical,
      animation: animationPreset, caption: captionStyle,
    });
  }, [topic, minutes, languages, voice, vertical, animationPreset, captionStyle]);

  useEffect(() => {
    let unListenProgress: (() => void) | null = null;
    let unListenError: (() => void) | null = null;
    let unListenImage: (() => void) | null = null;
    events.onPipelineProgress((p) => {
      const aid = activeRef.current;
      if (!aid || p.project_id === aid) {
        setPhaseState((prev) => ({ ...prev, [p.phase]: p }));
      }
    }).then((u) => (unListenProgress = u));
    events.onPipelineError((e) => {
      const aid = activeRef.current;
      if (!aid || e.project_id === aid) setError(e.error);
    }).then((u) => (unListenError = u));
    events.onImageReady((p) => {
      const aid = activeRef.current;
      if (!aid || p.project_id === aid) {
        setImageThumbs((prev) => {
          // dedupe by index, replace if newer
          const filtered = prev.filter((x) => x.index !== p.index);
          return [...filtered, p].sort((a, b) => a.index - b.index);
        });
      }
    }).then((u) => (unListenImage = u));
    return () => {
      unListenProgress?.();
      unListenError?.();
      unListenImage?.();
    };
  }, []); // mount once, ref carries the latest project id

  const handleStart = async () => {
    if (!topic.trim()) return;
    setError(null);
    setImageThumbs([]);
    setPhaseState({
      // Seed an immediate "running" indicator on phase 1 so the user sees
      // feedback before the backend emits its first event.
      1: { project_id: '', phase: 1, status: 'running', progress: 1, message: 'Iniciando…' },
    });
    const req: GenerateRequest = {
      topic: topic.trim(),
      languages,
      target_minutes: minutes,
      experimental_llm: experimental,
      vertical,
      voice_speaker: voice,
      use_musicgen: useMusicgen,
      auto_shorts: autoShorts && !vertical,
      burn_subtitles: burnSubtitles,
      animation_preset: animationPreset,
      caption_style: captionStyle,
      analyze_engagement: analyzeEngagement,
      auto_optimize_engagement: autoOptimizeEngagement,
    };
    try {
      const id = await tauri.startGeneration(req);
      setActiveProjectId(id);
    } catch (e) {
      setError(String(e));
      setPhaseState({});
    }
  };

  // Active phase = highest running phase, or the highest done if everything is done.
  const activePhase =
    Object.values(phaseState)
      .filter((p) => p.status === 'running')
      .map((p) => p.phase)
      .sort((a, b) => b - a)[0] ??
    Object.values(phaseState)
      .filter((p) => p.status === 'done')
      .map((p) => p.phase)
      .sort((a, b) => b - a)[0];

  const activeMessage = activePhase ? phaseState[activePhase]?.message : null;

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
            <div className="flex gap-2">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="El ascenso del Inmortal del Trueno…"
                data-testid="topic-input"
                className="flex-1 bg-obsidian-800 border border-border/50 rounded-md px-3 py-2 text-paper-100 placeholder:text-paper-400 focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20"
              />
              <button
                onClick={async () => {
                  setSuggesting(true);
                  setTopicIdeas(null);
                  try {
                    const r = await fetch('http://127.0.0.1:8731/script/suggest', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ niche: 'xianxia', count: 6, language: primaryLang }),
                    });
                    if (r.ok) {
                      const j = await r.json();
                      setTopicIdeas((j.ideas ?? []).map((x: { title: string; hook: string }) => ({ title: x.title, hook: x.hook })));
                    }
                  } catch { /* */ }
                  finally { setSuggesting(false); }
                }}
                data-testid="suggest-topics"
                disabled={suggesting}
                className={cn(
                  'shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors',
                  suggesting
                    ? 'bg-obsidian-800 text-paper-400 cursor-wait'
                    : 'bg-obsidian-800 border border-gold-500/40 text-gold-300 hover:bg-gold-500/10',
                )}
                title="Generar ideas con LLM"
              >
                {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Ideas IA
              </button>
            </div>
            {topicIdeas && topicIdeas.length > 0 && (
              <div className="mt-2 space-y-1" data-testid="topic-ideas">
                {topicIdeas.map((idea, i) => (
                  <button
                    key={i}
                    onClick={() => { setTopic(idea.title); setTopicIdeas(null); }}
                    className="w-full text-left text-[11px] px-2.5 py-1.5 rounded-md bg-obsidian-800 hover:bg-gold-500/10 border border-border/40 hover:border-gold-500/50 text-paper-200 transition-colors"
                  >
                    <div className="font-medium text-paper-100 truncate">{idea.title}</div>
                    <div className="text-[10px] text-paper-400 truncate">{idea.hook}</div>
                  </button>
                ))}
              </div>
            )}
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
                min={1}
                max={25}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                data-testid="minutes-slider"
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
                    data-testid={`lang-${l}`}
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

          <Field label={`Voz narradora (${primaryLang.toUpperCase()})`}>
            <div className="relative">
              <select
                value={voice}
                data-testid="voice-select"
                onChange={(e) => setVoice(e.target.value)}
                className="w-full appearance-none bg-obsidian-800 border border-border/50 rounded-md pl-3 pr-9 py-2 text-paper-100 text-sm focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 cursor-pointer"
              >
                {(voices ?? []).map((v) => (
                  <option key={v.id} value={v.id} className="bg-obsidian-800 text-paper-100">
                    {v.label} — {v.description}
                  </option>
                ))}
                {(!voices || voices.length === 0) && (
                  <option value="vivian" className="bg-obsidian-800 text-paper-100">
                    Cargando voces…
                  </option>
                )}
              </select>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gold-400"
                viewBox="0 0 16 16" fill="none"
              >
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            {voices && voices.length > 0 && (
              <p className="text-[10px] text-paper-400 mt-1.5">
                {voices.length} voces compatibles con {primaryLang.toUpperCase()}.
                {voices.find((v) => v.id === voice)?.tone &&
                  ` Tono: ${voices.find((v) => v.id === voice)?.tone}`}
              </p>
            )}
          </Field>

          <Field label="Formato">
            <div className="flex gap-2">
              <button
                onClick={() => setVertical(false)}
                data-testid="aspect-horizontal"
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm border transition-all',
                  !vertical
                    ? 'bg-gold-500/20 border-gold-500 text-gold-300'
                    : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                )}
              >
                Horizontal 1920×1080
              </button>
              <button
                onClick={() => setVertical(true)}
                data-testid="aspect-vertical"
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm border transition-all',
                  vertical
                    ? 'bg-gold-500/20 border-gold-500 text-gold-300'
                    : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                )}
              >
                Vertical 1080×1920
              </button>
            </div>
          </Field>

          <details className="rounded-md border border-border/40 bg-obsidian-800/30 group" data-testid="advanced-options">
            <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none select-none hover:bg-obsidian-800/50 rounded-md text-sm font-medium text-paper-200">
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5 text-gold-400 transition-transform group-open:rotate-90"
                viewBox="0 0 16 16" fill="none"
              >
                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Opciones avanzadas
              <span className="ml-auto text-[10px] text-paper-400">animación · subs · música · engagement</span>
            </summary>
            <div className="px-4 pb-4 pt-1 space-y-4">

          <Field label="Estilo de animación · transiciones">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="animation-presets">
              {([
                { id: 'cinematic', label: 'Cinematográfico', desc: 'Ken Burns suave + xfade variado' },
                { id: 'dynamic',   label: 'Dinámico',         desc: 'Zooms más fuertes + transiciones rápidas' },
                { id: 'minimal',   label: 'Minimal',          desc: 'Movimiento sutil, fades simples' },
                { id: 'dramatic',  label: 'Dramático',        desc: 'Steadicam intenso + radial/circle' },
              ] as const).map((p) => (
                <button
                  key={p.id}
                  onClick={() => setAnimationPreset(p.id)}
                  data-testid={`anim-${p.id}`}
                  className={cn(
                    'px-3 py-2 rounded-md text-left border transition-all',
                    animationPreset === p.id
                      ? 'bg-gold-500/15 border-gold-500 text-paper-100'
                      : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                  )}
                >
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className="text-[10px] text-paper-400 leading-tight">{p.desc}</div>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Estilo de subtítulos">
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2" data-testid="caption-style-presets">
              {([
                { id: 'xianxia',  label: 'Xianxia' },
                { id: 'hormozi',  label: 'Hormozi' },
                { id: 'mrbeast',  label: 'MrBeast' },
                { id: 'minimal',  label: 'Minimal' },
                { id: 'neon',     label: 'Neon' },
              ] as const).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setCaptionStyle(s.id)}
                  data-testid={`cap-${s.id}`}
                  className={cn(
                    'px-2 py-1.5 rounded-md text-xs border transition-all',
                    captionStyle === s.id
                      ? 'bg-gold-500/15 border-gold-500 text-paper-100'
                      : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Field>

          <Toggle
            label="Quemar subtítulos sobre el vídeo"
            description="Si está activo, el karaoke ASS se imprime en el master MP4. Los SRT siempre se generan para upload separado a YouTube."
            checked={burnSubtitles}
            onChange={setBurnSubtitles}
          />

          <Toggle
            label="Modo experimental (modelo abliterated)"
            description="Sin filtros de seguridad. Útil para xianxia oscuro. Bajo tu responsabilidad."
            checked={experimental}
            onChange={setExperimental}
            warning
          />

          <Toggle
            label={
              musicBackends?.preferred === 'acestep'
                ? 'Generar música con ACE-Step v1.5'
                : musicBackends?.preferred === 'musicgen'
                ? 'Generar música con MusicGen-medium'
                : 'Generar música con IA (no instalada — biblioteca local)'
            }
            description={
              musicBackends?.preferred === 'acestep'
                ? 'ACE-Step v1.5 (Apache 2.0) — calidad cinematográfica oriental superior, hasta 4 min nativos. ~2.6× realtime en RTX 4060 con cpu_offload.'
                : musicBackends?.preferred === 'musicgen'
                ? 'MusicGen-medium fp16 (~3.5 GB VRAM). Chunks 30s con crossfade 4s para vídeos largos. Pre-master EQ + compresor + loudnorm -16 LUFS.'
                : 'Instala ACE-Step y/o MusicGen vía el wizard (componente python-deps-music). Mientras tanto, usa la biblioteca local.'
            }
            checked={useMusicgen}
            onChange={setUseMusicgen}
            warning={!musicBackends?.preferred}
          />

          <Toggle
            label="Auto-Shorts virales tras render"
            description="Tras el long-form, extrae automáticamente 3 Shorts de 25-60s usando LLM scoring (hook + climax + standalone) sobre los timestamps de Whisper. Solo aplica al modo horizontal."
            checked={autoShorts}
            onChange={setAutoShorts}
          />

          <Toggle
            label="Analizar engagement con TRIBE v2"
            description="Meta TRIBE v2 (CC-BY-NC) predice respuestas cerebrales fMRI a tu vídeo y mapea a redes funcionales (Salience + FPN + Visual + Auditory − DMN). Devuelve score 0-100 + valles aburridos. Tarda ~30-90s extra al final del render. Modo light: 8 GB VRAM-friendly."
            checked={analyzeEngagement}
            onChange={setAnalyzeEngagement}
          />

          <Toggle
            label="Auto-optimizar valles aburridos"
            description="Si el análisis detecta valles, aplica fixes automáticos: cortar segmentos con DMN alto (mente vagando), subir música en valles auditivos. Requiere análisis activo."
            checked={autoOptimizeEngagement}
            onChange={setAutoOptimizeEngagement}
            warning={!analyzeEngagement}
          />
            </div>
          </details>

          <button
            onClick={handleStart}
            data-testid="start-generation"
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
        <aside className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6" data-testid="pipeline-aside">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-xl">Pipeline</h2>
            {activeProjectId && (
              <span className="text-[10px] font-mono text-gold-400 truncate max-w-[150px]" title={activeProjectId}>
                #{activeProjectId.slice(0, 8)}
              </span>
            )}
          </div>
          {activePhase && (
            <div
              data-testid="active-phase-banner"
              className="mb-4 p-3 rounded-md border border-gold-500/40 bg-gold-500/5 flex items-center gap-3"
            >
              <Loader2 className="w-4 h-4 text-gold-400 shrink-0 animate-spin" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-gold-300 uppercase tracking-wide">
                  Fase {activePhase}/10 · {PHASES[activePhase - 1]?.label ?? '…'}
                </div>
                <div className="text-[11px] text-paper-200 truncate">
                  {activeMessage ?? 'Procesando…'}
                </div>
              </div>
            </div>
          )}
          <ol className="space-y-2" data-testid="pipeline-list">
            {PHASES.map((p) => {
              const update = phaseState[p.phase];
              const status = update?.status ?? 'pending';
              const Icon = p.icon;
              return (
                <li
                  key={p.phase}
                  data-testid={`phase-${p.phase}`}
                  data-status={status}
                  data-message={update?.message ?? ''}
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

          {imageThumbs.length > 0 && (
            <div className="mt-5" data-testid="image-thumbs">
              <div className="text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
                Imágenes generadas <span className="text-gold-300">({imageThumbs.length})</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {imageThumbs.map((t) => (
                  <div
                    key={t.index}
                    className="relative aspect-[3/4] rounded-md overflow-hidden border border-border/40 bg-obsidian-900"
                    title={t.prompt}
                  >
                    <img
                      src={convertFileSrc(t.image_path)}
                      alt={`Imagen ${t.index + 1}`}
                      loading="lazy"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        // Fallback: hide if Tauri webview can't load the file
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-obsidian-950/80 text-[9px] font-mono tabular-nums text-gold-300">
                      {t.index + 1}/{t.total}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div data-testid="pipeline-error" className="mt-4 p-3 rounded-md bg-crimson-500/15 border border-crimson-500/40 text-xs text-paper-100 flex items-start gap-2">
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
