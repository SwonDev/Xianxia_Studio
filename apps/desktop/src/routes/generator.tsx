import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import {
  Sparkle, TextT, SpeakerHigh, Image as ImageIcon, MusicNotes,
  FilmSlate, Layout, ClosedCaptioning, UploadSimple, CalendarBlank,
  Warning, CheckCircle, CircleNotch, Plus, CaretDown, DownloadSimple,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { type LtxCapability } from '@/lib/tauri';
import { useQuery } from '@tanstack/react-query';
import { tauri, type GenerateRequest } from '@/lib/tauri';
import { usePipelineStore } from '@/lib/pipelineStore';
import { convertFileSrc } from '@/lib/tauri-asset';
import { useToast } from '@/components/toast';
import { VoiceWizard } from '@/components/voice-wizard';
import { PageHeader } from '@/components/ui-glass';
import { ChapterPreview } from '@/components/chapter-preview';

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

// v0.1.28: presets diversos. Antes eran todos xianxia y eso reforzaba el
// sesgo. La app genera cualquier temática; los chips deben demostrarlo.
const TOPIC_PRESETS = [
  'La historia de los dioses egipcios',
  'Norse mythology — Ragnarök and the fall of the gods',
  'The lost civilization of Atlantis',
  'The rise and fall of the Roman Empire',
  'Black holes and the limits of physics',
  'La leyenda del Emperador de Jade',
];

// v0.1.38: topic-aware duration recommender. YouTube monetises videos of
// 8+ min, but each topic class has its own viral sweet spot — biographies
// and history reward longer arcs (12-15 min), while tech/curiosities
// max out around 8-10 before viewers churn. We classify the topic by
// keywords and recommend a length that maximises both retention and
// monetisation eligibility. The user can always override the slider.
function recommendMinutesFor(topic: string): { minutes: number; reason: string } {
  const t = (topic || '').toLowerCase();
  if (/\b(biograf|biograph|vida de|life of|historia de un|the story of|legacy of|legado de)\b/.test(t)) {
    return { minutes: 14, reason: 'Biografías virales: 12-15 min para arco completo' };
  }
  if (/\b(historia|history|civilization|civilizaci|empire|imperio|guerra|war|battle|batalla|ancient|antigua|antiguo|dynasty|dinast|reino|kingdom|emperor|faraón|pharaoh|tomb|tumba|descubrim|discover)\b/.test(t)) {
    return { minutes: 13, reason: 'Documental histórico: 12-15 min retiene mejor' };
  }
  if (/\b(mito|myth|legend|leyenda|gods?|dioses?|ragnarok|valhalla|olimpo|olympus|atlantis|nordic|norse|griega|greek|hindú|hindu)\b/.test(t)) {
    return { minutes: 12, reason: 'Mitología: 10-14 min para desarrollar el lore' };
  }
  if (/\b(misterio|mystery|conspirac|conspiraci|unsolved|sin resolver|paranormal|sobrenatural|leyenda urbana|urban legend|cripto|crypto|secret)\b/.test(t)) {
    return { minutes: 10, reason: 'Misterio/conspiración: 10-12 min mantiene la tensión' };
  }
  if (/\b(crimen|crime|asesin|murder|killer|caso|case|true crime)\b/.test(t)) {
    return { minutes: 12, reason: 'True crime: 12-15 min para el arco completo' };
  }
  if (/\b(ciencia|science|fisica|physics|quantum|cuántic|astronom|cosmos|black hole|agujero negro|relativ|big bang|space|espacio|universe|universo|galax)\b/.test(t)) {
    return { minutes: 10, reason: 'Divulgación científica: 8-12 min, suficiente densidad' };
  }
  if (/\b(tech|tecnolog|ia|ai\b|inteligencia artificial|computer|computing|machine learning|programaci|coding)\b/.test(t)) {
    return { minutes: 9, reason: 'Tech: 8-10 min, ritmo ágil' };
  }
  if (/\b(top \d|los \d|the \d|curiosidades|curiosities|datos sorprendentes|amazing facts|did you know)\b/.test(t)) {
    return { minutes: 8, reason: 'Top/curiosidades: 8 min mínimo monetización' };
  }
  if (/\b(película|movie|film|serie|series|anime|videojuego|videogame|character|personaje|saga|universe)\b/.test(t)) {
    return { minutes: 11, reason: 'Cultura pop: 10-13 min para análisis con peso' };
  }
  return { minutes: 10, reason: 'Sugerencia por defecto: 10 min · ≥ 8 min para monetizar' };
}

const PHASES: { phase: number; label: string; icon: PhosphorIcon; hint: string }[] = [
  { phase: 1, label: 'Guion', icon: TextT, hint: 'Generación con Gemma 4' },
  { phase: 2, label: 'Metadatos', icon: TextT, hint: 'Título, descripción, tags' },
  { phase: 3, label: 'Voz', icon: SpeakerHigh, hint: 'Qwen3-TTS' },
  { phase: 4, label: 'Imágenes', icon: ImageIcon, hint: 'Z-Image-Turbo' },
  { phase: 5, label: 'Música', icon: MusicNotes, hint: 'Biblioteca local' },
  { phase: 6, label: 'Vídeo', icon: FilmSlate, hint: 'HyperFrames' },
  { phase: 7, label: 'Thumbnail', icon: Layout, hint: 'Bilingüe' },
  { phase: 8, label: 'Subtítulos', icon: ClosedCaptioning, hint: 'faster-whisper' },
  { phase: 9, label: 'Upload', icon: UploadSimple, hint: 'YouTube' },
  { phase: 10, label: 'Programación', icon: CalendarBlank, hint: 'Cron + Shorts' },
];

// v0.7.0 — Tipos de vídeo. narrative_epic === comportamiento v0.6.x byte
// por byte (defecto). El resto cambian la directiva LLM, el estilo de
// imagen, y (en v0.7.1) voz y música.
type PresetId =
  | 'narrative_epic'
  | 'documentary'
  | 'explainer'
  | 'listicle'
  | 'comparative'
  | 'deep_dive';

const PRESET_OPTIONS: ReadonlyArray<{ id: PresetId; label: string; desc: string }> = [
  { id: 'narrative_epic', label: 'Narrativa épica', desc: 'Historia dramatizada con beats virales' },
  { id: 'documentary',    label: 'Documental',      desc: 'Tono BBC/Nat Geo, contexto factual' },
  { id: 'explainer',      label: 'Divulgativo',     desc: 'Explica como un profesor, sin drama' },
  { id: 'listicle',       label: 'Listicle (Top N)', desc: 'Estructura de lista numerada' },
  { id: 'comparative',    label: 'Comparativa',     desc: 'A vs B, paralelismos y contrastes' },
  { id: 'deep_dive',      label: 'Deep dive',       desc: 'Largo por capítulos, análisis exhaustivo' },
] as const;

const STORAGE_KEY = 'xianxia.generator.draft';
function loadDraft(): {
  topic: string; minutes: number; languages: string[];
  audio_language?: string;
  subtitle_languages?: string[];
  voice: string; vertical: boolean;
  animation: 'cinematic' | 'dynamic' | 'minimal' | 'dramatic';
  caption: 'xianxia' | 'hormozi' | 'mrbeast' | 'minimal' | 'neon';
  preset?: PresetId;
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

const selBtn = (active: boolean): CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 500,
  background: active ? 'var(--accent-bg)' : 'rgba(255,255,255,0.04)',
  color: active ? 'var(--accent-soft)' : 'var(--text-secondary)',
  boxShadow: active
    ? 'inset 0 0.5px 0 rgba(255,255,255,0.15), 0 0 0 0.5px rgba(232, 201, 109,0.40)'
    : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
  transition: 'all 140ms',
});

function GeneratorWizard() {
  const draft = loadDraft();
  const [topic, setTopic] = useState(draft?.topic ?? '');
  const [minutes, setMinutes] = useState(draft?.minutes ?? 14);
  const [audioLanguage, setAudioLanguage] = useState<string>(
    draft?.audio_language ?? draft?.languages?.[0] ?? 'en',
  );
  const [subtitleLanguages, setSubtitleLanguages] = useState<string[]>(() => {
    const seed = draft?.subtitle_languages ?? draft?.languages ?? ['en', 'es'];
    const unique = Array.from(new Set([draft?.audio_language ?? draft?.languages?.[0] ?? 'en', ...seed]));
    return unique;
  });
  const languages = Array.from(new Set([audioLanguage, ...subtitleLanguages]));
  const [experimental, setExperimental] = useState(false);
  // v0.6.6 — música IA y auto-optimización ON por defecto (petición del
  // usuario). ACE-Step preferido con fallback automático MusicGen →
  // biblioteca; auto-optimizar depende de analyzeEngagement (ya ON).
  const [useMusicgen, setUseMusicgen] = useState(true);
  const [autoShorts, setAutoShorts] = useState(false);
  const [analyzeEngagement, setAnalyzeEngagement] = useState(true);
  const [autoOptimizeEngagement, setAutoOptimizeEngagement] = useState(true);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [animationPreset, setAnimationPreset] = useState<'cinematic' | 'dynamic' | 'minimal' | 'dramatic'>(draft?.animation ?? 'cinematic');
  const [captionStyle, setCaptionStyle] = useState<'xianxia' | 'hormozi' | 'mrbeast' | 'minimal' | 'neon'>(draft?.caption ?? 'xianxia');
  // v0.7.0 — Tipo de vídeo. Por defecto narrative_epic (== legacy v0.6.x).
  const [videoPreset, setVideoPreset] = useState<PresetId>(draft?.preset ?? 'narrative_epic');
  const [voice, setVoice] = useState(draft?.voice ?? 'vivian');
  const [vertical, setVertical] = useState(draft?.vertical ?? false);
  const [suggesting, setSuggesting] = useState(false);
  const [topicIdeas, setTopicIdeas] = useState<{ title: string; hook: string }[] | null>(null);
  const { toast, confirmDialog } = useToast();
  const activeProjectId = usePipelineStore((s) => s.activeProjectId);
  const phaseState = usePipelineStore((s) => s.phaseState);
  const error = usePipelineStore((s) => s.error);
  const imageThumbs = usePipelineStore((s) => s.imageThumbs);
  const pipeSeedStarting = usePipelineStore((s) => s.seedStarting);
  const pipeSetActiveProject = usePipelineStore((s) => s.setActiveProject);
  const pipeReset = usePipelineStore((s) => s.reset);
  const setError = usePipelineStore((s) => s.setError);

  const primaryLang = audioLanguage;

  const { data: voices, refetch: refetchVoices } = useQuery<VoiceProfile[]>({
    queryKey: ['voices', primaryLang],
    queryFn: async () => {
      const res = await fetch(`http://127.0.0.1:8731/tts/voices?language=${primaryLang}`);
      if (!res.ok) throw new Error(`voices: ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const isCloneVoice = voice.startsWith('clone:');
  const { data: cloningStatus, refetch: refetchCloningStatus } = useQuery<{
    base_model_installed: boolean;
    component_id: string;
    repo_id: string;
    download_size_gb: number;
    registered_clones: number;
    hint: string;
  }>({
    queryKey: ['cloning-status'],
    queryFn: async () => {
      const r = await fetch('http://127.0.0.1:8731/tts/cloning/status');
      if (!r.ok) throw new Error(`cloning status: ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
    retry: 1,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.base_model_installed) return false;
      return 5000;
    },
  });

  const [installingVoiceClone, setInstallingVoiceClone] = useState(false);
  const [voiceWizardOpen, setVoiceWizardOpen] = useState(false);
  const autoInstallAttempted = useRef(false);

  const handleInstallVoiceClone = async (silent = false) => {
    if (installingVoiceClone) return;
    setInstallingVoiceClone(true);
    if (!silent) {
      toast.info(
        'Descargando Qwen3-TTS Base (≈7 GB)…',
        'Esto puede tardar varios minutos en función de tu conexión.',
      );
    }
    try {
      await tauri.installOptionalComponent('model-qwen-tts-base');
      toast.success(
        'Voice cloning instalado',
        'Ahora puedes generar vídeos con voces clonadas.',
      );
      await refetchCloningStatus();
    } catch (e) {
      if (!silent) {
        toast.error('No se pudo instalar voice cloning', String(e));
      } else {
        autoInstallAttempted.current = false;
      }
    } finally {
      setInstallingVoiceClone(false);
    }
  };

  useEffect(() => {
    if (!cloningStatus) return;
    if (cloningStatus.base_model_installed) return;
    if (cloningStatus.registered_clones === 0) return;
    if (autoInstallAttempted.current) return;
    autoInstallAttempted.current = true;
    handleInstallVoiceClone(true /* silent */);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloningStatus?.base_model_installed, cloningStatus?.registered_clones]);

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

  // v0.6.0 — LTX-2.3 opt-in gate queries (cached, low priority)
  const { data: ltxCapability } = useQuery<LtxCapability>({
    queryKey: ['ltx-capability'],
    queryFn: tauri.ltxCapability,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const { data: ltxInstalled, refetch: refetchLtxInstalled } = useQuery<boolean>({
    queryKey: ['ltx-models-installed'],
    queryFn: tauri.ltxModelsInstalled,
    staleTime: 30_000,
    retry: 1,
    // Only poll while capability is known and models not yet installed
    refetchInterval: (q) => {
      if (ltxCapability === 'none' || ltxCapability === undefined) return false;
      if (q.state.data === true) return false;
      return 10_000;
    },
  });
  const [useLtxVideo, setUseLtxVideo] = useState(false);
  const [installingLtx, setInstallingLtx] = useState(false);
  const [ltxInstallProgress, setLtxInstallProgress] = useState<string>('');
  // v0.12.4 — opt-in SFX/Foley layer (Stable Audio 3 small-sfx).
  // Default false. Best-effort post-render: si falla en cualquier paso
  // del pipeline (modelo no instalado, ComfyUI sin VRAM, LLM down) se
  // omite con un log warn y el vídeo sale sin SFX — NUNCA bloquea.
  const [enableSfx, setEnableSfx] = useState(false);

  useEffect(() => {
    if (!voices || voices.length === 0) return;
    const ok = voices.some((v) => v.id === voice);
    if (!ok && voices[0]) setVoice(voices[0].id);
  }, [voices, voice]);

  useEffect(() => {
    saveDraft({
      topic, minutes, languages,
      audio_language: audioLanguage,
      subtitle_languages: subtitleLanguages,
      voice, vertical,
      animation: animationPreset, caption: captionStyle,
      preset: videoPreset,
    });
  }, [topic, minutes, languages, audioLanguage, subtitleLanguages, voice, vertical, animationPreset, captionStyle, videoPreset]);

  const handleInstallLtx = async () => {
    if (installingLtx) return;
    setInstallingLtx(true);
    setLtxInstallProgress('Iniciando descarga…');
    try {
      await tauri.installOptionalComponent('ltx23-video');
      setLtxInstallProgress('Instalado. Verificando modelos…');
      await refetchLtxInstalled();
      setLtxInstallProgress('');
    } catch (e) {
      setLtxInstallProgress('');
      toast.error('No se pudieron instalar los modelos LTX-2.3', String(e));
    } finally {
      setInstallingLtx(false);
    }
  };

  const handleStart = async () => {
    if (!topic.trim()) return;
    pipeSeedStarting();
    // v0.6.0: only send use_ltx_video=true when all three gates pass on the
    // client side too (defensive — the pipeline Rust layer has the same gate).
    const ltxOptIn =
      useLtxVideo &&
      ltxCapability !== undefined && ltxCapability !== 'none' &&
      ltxInstalled === true;
    const req: GenerateRequest = {
      topic: topic.trim(),
      languages,
      audio_language: audioLanguage,
      subtitle_languages: subtitleLanguages,
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
      use_ltx_video: ltxOptIn,
      preset_id: videoPreset,
      enable_sfx: enableSfx,
    };
    try {
      const id = await tauri.startGeneration(req);
      pipeSetActiveProject(id);
    } catch (e) {
      pipeReset();
      setError(String(e));
    }
  };

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
  const LANGS = ['en', 'es', 'zh', 'ja', 'ko', 'de', 'fr', 'it', 'pt', 'ru'] as const;

  return (
    <div className="route-enter page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Generador"
        subtitle="Elige un tema, ajusta los parámetros y deja que el pipeline produzca tu vídeo de forma autónoma."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 360px',
          gap: 22,
          alignItems: 'start',
        }}
      >
        {/* Left: configuration */}
        <section className="group" style={{ padding: 22 }}>
          <h2 className="section-header" style={{ fontSize: 15 }}>1 · Configura tu vídeo</h2>

          <Field label="Tema">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="input"
                style={{ flex: 1, height: 30 }}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="El ascenso del Inmortal del Trueno…"
                data-testid="topic-input"
              />
              <button
                className="btn"
                style={{ flexShrink: 0 }}
                disabled={suggesting}
                data-testid="suggest-topics"
                title="Generar ideas con LLM"
                onClick={async () => {
                  setSuggesting(true);
                  setTopicIdeas(null);
                  try {
                    const r = await fetch('http://127.0.0.1:8731/script/suggest', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        niche: topic.trim() || 'diverse storytelling',
                        count: 6,
                        language: primaryLang,
                      }),
                    });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const j = await r.json();
                    const ideas = (j.ideas ?? []).map((x: { title: string; hook: string }) => ({ title: x.title, hook: x.hook }));
                    if (ideas.length === 0) {
                      toast.warning('Sin ideas', 'El LLM no devolvió ninguna sugerencia. Reintenta en unos segundos.');
                    } else {
                      setTopicIdeas(ideas);
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    toast.error(
                      'No se pudieron generar ideas',
                      `${msg}. Verifica que llama.cpp y el sidecar Python estén verdes en el topbar.`,
                    );
                  } finally {
                    setSuggesting(false);
                  }
                }}
              >
                {suggesting ? <CircleNotch size={13} className="spin" /> : <Sparkle size={13} />}
                Ideas IA
              </button>
            </div>
            {topicIdeas && topicIdeas.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="topic-ideas">
                {topicIdeas.map((idea, i) => (
                  <button
                    key={i}
                    onClick={() => { setTopic(idea.title); setTopicIdeas(null); }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.04)',
                      boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idea.title}</div>
                    <div className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idea.hook}</div>
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {TOPIC_PRESETS.map((p) => (
                <button key={p} className="chip" onClick={() => setTopic(p)}>{p}</button>
              ))}
            </div>
          </Field>

          <Field label="Duración aproximada">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                className="range"
                min={4}
                max={45}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                data-testid="minutes-slider"
              />
              <span className="mono" style={{ fontSize: 13, width: 52, textAlign: 'right' }}>{minutes} min</span>
            </div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              {(() => {
                const reco = recommendMinutesFor(topic);
                const isCurrent = minutes === reco.minutes;
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => setMinutes(reco.minutes)}
                      disabled={isCurrent}
                      data-testid="suggest-duration"
                      style={{
                        padding: '3px 10px',
                        borderRadius: 999,
                        fontSize: 11,
                        background: isCurrent ? 'rgba(212, 184, 90,0.15)' : 'var(--gold-bg)',
                        color: isCurrent ? 'var(--accent-soft)' : 'var(--gold-soft)',
                        boxShadow: '0 0 0 0.5px rgba(255,255,255,0.10)',
                      }}
                    >
                      {isCurrent ? `✓ Óptima · ${reco.minutes} min` : `Sugerir ${reco.minutes} min`}
                    </button>
                    <span className="muted">{reco.reason}</span>
                  </>
                );
              })()}
            </div>
            {minutes < 8 && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gold-soft)' }}>
                <Warning size={12} />
                <span>Por debajo de 8 min YouTube no permite monetizar con mid-roll.</span>
              </div>
            )}
          </Field>

          <Field label="Idioma del audio (narración)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LANGS.map((l) => (
                <button
                  key={l}
                  data-testid={`audio-lang-${l}`}
                  style={selBtn(audioLanguage === l)}
                  onClick={() => {
                    setAudioLanguage(l);
                    setSubtitleLanguages((prev) => (prev.includes(l) ? prev : [l, ...prev]));
                  }}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="caption" style={{ marginTop: 6 }}>
              El TTS narrará en este idioma y filtrará el catálogo de voces.
            </p>
          </Field>

          <Field label="Idiomas de subtítulos (multi)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LANGS.map((l) => {
                const active = subtitleLanguages.includes(l);
                const isAudio = audioLanguage === l;
                return (
                  <button
                    key={l}
                    data-testid={`sub-lang-${l}`}
                    style={selBtn(active)}
                    title={isAudio ? 'Idioma del audio — siempre incluido' : ''}
                    onClick={() => {
                      if (isAudio && active) return;
                      setSubtitleLanguages((prev) =>
                        active ? prev.filter((x) => x !== l) : [...prev, l],
                      );
                    }}
                  >
                    {l.toUpperCase()}
                    {isAudio && <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--gold-soft)' }}>·audio</span>}
                  </button>
                );
              })}
            </div>
            <p className="caption" style={{ marginTop: 6 }}>
              SRT y ASS por idioma. El del audio se quema en el vídeo; el resto van como pistas externas.
            </p>
          </Field>

          {cloningStatus && !cloningStatus.base_model_installed && (cloningStatus.registered_clones > 0 || isCloneVoice) && (
            installingVoiceClone ? (
              <div style={{ borderRadius: 10, padding: 12, marginBottom: 16, background: 'rgba(212, 184, 90,0.10)', boxShadow: '0 0 0 0.5px rgba(232, 201, 109,0.30)', display: 'flex', gap: 8, fontSize: 12 }}>
                <CircleNotch size={16} className="spin" style={{ color: 'var(--accent-soft)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--accent-soft)', marginBottom: 2 }}>Instalando voice cloning automáticamente…</div>
                  <div className="muted">Descargando Qwen3-TTS Base (≈{cloningStatus.download_size_gb} GB). Cuando termine, las voces clonadas aparecerán solas.</div>
                </div>
              </div>
            ) : (
              <div style={{ borderRadius: 10, padding: 12, marginBottom: 16, background: 'var(--gold-bg)', boxShadow: '0 0 0 0.5px rgba(212,184,90,0.35)', display: 'flex', gap: 8, fontSize: 12 }}>
                <Warning size={16} style={{ color: 'var(--gold-soft)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: 'var(--gold-soft)', marginBottom: 2 }}>Voice cloning no se pudo instalar</div>
                  <div className="muted" style={{ marginBottom: 8 }}>{cloningStatus.hint} Reintenta cuando tengas conexión.</div>
                  <button className="btn-primary" onClick={() => handleInstallVoiceClone(false)}>
                    Reintentar instalación ({cloningStatus.download_size_gb} GB)
                  </button>
                </div>
              </div>
            )
          )}

          <Field label={`Voz narradora (${primaryLang.toUpperCase()})`}>
            <div style={{ position: 'relative' }}>
              <select
                className="input"
                value={voice}
                data-testid="voice-select"
                onChange={(e) => setVoice(e.target.value)}
                style={{ height: 30, appearance: 'none', paddingRight: 30, cursor: 'pointer' }}
              >
                {(voices ?? []).map((v) => (
                  <option key={v.id} value={v.id} style={{ background: '#1b1b22' }}>
                    {v.label} — {v.description}
                  </option>
                ))}
                {(!voices || voices.length === 0) && (
                  <option value="vivian" style={{ background: '#1b1b22' }}>Cargando voces…</option>
                )}
              </select>
              <CaretDown size={13} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-soft)', pointerEvents: 'none' }} />
            </div>
            {voices && voices.length > 0 && (
              <p className="caption" style={{ marginTop: 6 }}>
                {voices.length} voces compatibles con {primaryLang.toUpperCase()}.
                {voices.find((v) => v.id === voice)?.tone && ` Tono: ${voices.find((v) => v.id === voice)?.tone}`}
              </p>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => setVoiceWizardOpen(true)}
              style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
            >
              <Plus size={12} weight="bold" />
              Crear voz nueva (grabar / archivo / URL)
            </button>
          </Field>

          {/* v0.7.0 — Tipo de vídeo / preset narrativo. Cambia la directiva
             *  LLM y el estilo de imagen. narrative_epic === byte-idéntico
             *  al comportamiento de v0.6.x. */}
          <Field label="Tipo de vídeo">
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6 }}
              data-testid="video-preset-grid"
            >
              {PRESET_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  data-testid={`preset-${p.id}`}
                  onClick={() => setVideoPreset(p.id)}
                  aria-pressed={videoPreset === p.id}
                  style={{
                    padding: '8px 10px',
                    textAlign: 'left',
                    borderRadius: 10,
                    background: videoPreset === p.id ? 'var(--accent-bg)' : 'rgba(255,255,255,0.04)',
                    boxShadow: videoPreset === p.id
                      ? 'inset 0 0.5px 0 rgba(255,255,255,0.15), 0 0 0 0.5px rgba(232, 201, 109,0.40)'
                      : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{p.label}</div>
                  <div className="caption" style={{ fontSize: 10 }}>{p.desc}</div>
                </button>
              ))}
            </div>
            <p className="caption" style={{ marginTop: 6 }}>
              Cambia el tono de la narración y la estética de las imágenes.
              Narrativa épica es el comportamiento por defecto.
            </p>
          </Field>

          <Field label="Formato">
            <div className="segmented">
              <button
                className={'segmented-btn' + (!vertical ? ' active' : '')}
                data-testid="aspect-horizontal"
                onClick={() => setVertical(false)}
              >
                Horizontal 1920×1080
              </button>
              <button
                className={'segmented-btn' + (vertical ? ' active' : '')}
                data-testid="aspect-vertical"
                onClick={() => setVertical(true)}
              >
                Vertical 1080×1920
              </button>
            </div>
          </Field>

          {/* v0.6.0 — Motor de vídeo: solo visible cuando capability !== 'none' */}
          {ltxCapability !== undefined && ltxCapability !== 'none' && (
            <Field label="Motor de vídeo">
              {!ltxInstalled ? (
                /* Capability ok pero modelos no instalados → ofrecer instalación */
                <div
                  data-testid="ltx-install-row"
                  style={{
                    borderRadius: 10,
                    padding: 12,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    background: 'rgba(255,255,255,0.04)',
                    boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>
                      Vídeo real LTX-2.3
                      <span className="caption" style={{ marginLeft: 8, fontSize: 10 }}>
                        · {ltxCapability === 'gguf' ? '≈60 GB (GGUF Q4)' : '≈70 GB (fp8)'}
                      </span>
                    </div>
                    <div className="caption" style={{ lineHeight: 1.5 }}>
                      Requiere instalar los modelos LTX-2.3 ({ltxCapability === 'gguf' ? 'GGUF cuantizado' : 'fp8 completo'}).
                      El control se activará cuando la descarga termine.
                    </div>
                    {ltxInstallProgress && (
                      <div className="mono" style={{ fontSize: 11, color: 'var(--gold-soft)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ltxInstallProgress}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn-primary"
                    disabled={installingLtx}
                    data-testid="ltx-install-btn"
                    onClick={handleInstallLtx}
                    style={{ flexShrink: 0 }}
                  >
                    {installingLtx
                      ? <CircleNotch size={13} className="spin" />
                      : <DownloadSimple size={13} />}
                    {installingLtx ? 'Instalando…' : 'Instalar'}
                  </button>
                </div>
              ) : (
                /* Modelos instalados → toggle habilitado */
                <Toggle
                  label="LTX-2.3 vídeo real"
                  description={`Motor de vídeo neuronal (${ltxCapability === 'gguf' ? 'GGUF cuantizado, ≥24 GB VRAM' : 'fp8 completo, ≥32 GB VRAM'}). Por defecto: Imágenes + HyperFrames.`}
                  checked={useLtxVideo}
                  onChange={setUseLtxVideo}
                />
              )}
            </Field>
          )}

          {/* v0.12.4 — SFX/Foley layer (Stable Audio 3 small-sfx).
              Toggle siempre visible; backend hace best-effort y omite
              silenciosamente si los pesos no están instalados o
              ComfyUI no tiene VRAM. NUNCA bloquea el render. */}
          <Field label="Capa SFX cinematográfica (Stable Audio 3, opt-in)">
            <Toggle
              label="Generar capa de SFX/foley sincronizada con el guion"
              description="Añade impacto, ambient, foley, whoosh y momentos místicos en los timestamps que el LLM detecta como pico narrativo. Best-effort: si los pesos no están instalados o ComfyUI no tiene VRAM, el vídeo sale sin SFX (skip silencioso, NO bloquea). Requiere instalar el componente opcional «Stable Audio 3 SFX» desde el Instalador."
              checked={enableSfx}
              onChange={setEnableSfx}
            />
          </Field>

          <details data-testid="advanced-options" style={{ marginTop: 8 }}>
            <summary
              className="caption"
              style={{ cursor: 'default', listStyle: 'none', padding: '8px 0', fontWeight: 600, color: 'var(--text-secondary)' }}
            >
              ▸ Opciones avanzadas · animación · subs · música · engagement
            </summary>
            <div style={{ paddingTop: 8 }}>
              <Field label="Estilo de animación · transiciones">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6 }} data-testid="animation-presets">
                  {([
                    { id: 'cinematic', label: 'Cinematográfico', desc: 'Ken Burns suave + xfade variado' },
                    { id: 'dynamic', label: 'Dinámico', desc: 'Zooms fuertes + transiciones rápidas' },
                    { id: 'minimal', label: 'Minimal', desc: 'Movimiento sutil, fades simples' },
                    { id: 'dramatic', label: 'Dramático', desc: 'Steadicam intenso + radial/circle' },
                  ] as const).map((p) => (
                    <button
                      key={p.id}
                      data-testid={`anim-${p.id}`}
                      onClick={() => setAnimationPreset(p.id)}
                      style={{
                        padding: '8px 10px',
                        textAlign: 'left',
                        borderRadius: 10,
                        background: animationPreset === p.id ? 'var(--accent-bg)' : 'rgba(255,255,255,0.04)',
                        boxShadow: animationPreset === p.id
                          ? 'inset 0 0.5px 0 rgba(255,255,255,0.15), 0 0 0 0.5px rgba(232, 201, 109,0.40)'
                          : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                      }}
                    >
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{p.label}</div>
                      <div className="caption" style={{ fontSize: 10 }}>{p.desc}</div>
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Estilo de subtítulos">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-testid="caption-style-presets">
                  {(['xianxia', 'hormozi', 'mrbeast', 'minimal', 'neon'] as const).map((s) => (
                    <button
                      key={s}
                      data-testid={`cap-${s}`}
                      style={selBtn(captionStyle === s)}
                      onClick={() => setCaptionStyle(s)}
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </Field>

              <Toggle label="Quemar subtítulos sobre el vídeo" description="El karaoke ASS se imprime en el master MP4. Los SRT siempre se generan para upload separado." checked={burnSubtitles} onChange={setBurnSubtitles} />
              <Toggle label="Modo experimental (modelo abliterated)" description="Sin filtros de seguridad. Útil para xianxia oscuro. Bajo tu responsabilidad." checked={experimental} onChange={setExperimental} warning />
              <Toggle
                label="Generar música con IA"
                description={
                  musicBackends?.preferred === 'acestep'
                    ? 'ACE-Step v1.5 (instrumental cinematográfico, GPU-only). Fallback automático a MusicGen → biblioteca.'
                    : 'ACE-Step v1.5 es el generador principal — su entorno se autoinstala en segundo plano. Mientras, usa MusicGen → biblioteca automáticamente.'
                }
                checked={useMusicgen}
                onChange={setUseMusicgen}
              />
              <Toggle label="Auto-Shorts virales tras render" description="Tras el long-form, extrae 3 Shorts de 25-60s con LLM scoring sobre los timestamps de Whisper. Solo modo horizontal." checked={autoShorts} onChange={setAutoShorts} />
              <Toggle label="Analizar engagement con TRIBE v2" description="Predice respuestas fMRI y mapea a redes funcionales. Score 0-100 + valles. ~30-90s extra. 8 GB VRAM-friendly." checked={analyzeEngagement} onChange={setAnalyzeEngagement} />
              <Toggle label="Auto-optimizar valles aburridos" description="Si hay valles, corta segmentos con DMN alto y sube música en valles auditivos. Requiere análisis activo." checked={autoOptimizeEngagement} onChange={setAutoOptimizeEngagement} warning={!analyzeEngagement} />
            </div>
          </details>

          <div style={{ marginTop: 18, display: 'grid', gap: 8, gridTemplateColumns: activeProjectId ? '1fr auto' : '1fr' }}>
            <button
              className="btn-primary large"
              data-testid="start-generation"
              disabled={!topic.trim() || activeProjectId !== null}
              onClick={handleStart}
              style={{ justifyContent: 'center' }}
            >
              <Sparkle size={13} />
              {activeProjectId ? 'Generación en curso…' : 'Iniciar generación'}
            </button>
            {activeProjectId && (
              <button
                className="btn-destructive"
                title="Interrumpir la generación en curso"
                onClick={async () => {
                  if (!activeProjectId) return;
                  const ok = await confirmDialog({
                    title: 'Cancelar generación',
                    body: 'Se interrumpirá la generación en curso. Los modelos cargados en VRAM permanecerán activos para tu próximo intento.',
                    confirmLabel: 'Cancelar generación',
                    cancelLabel: 'Continuar',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await tauri.abortGeneration(activeProjectId);
                    pipeReset();
                    toast.info('Generación cancelada');
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    toast.error('No se pudo cancelar', msg);
                  }
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        </section>

        {/* Right: pipeline */}
        <aside className="group" style={{ padding: 18 }} data-testid="pipeline-aside">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 className="title">Pipeline</h2>
            {activeProjectId && (
              <span className="mono" style={{ color: 'var(--gold-soft)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }} title={activeProjectId}>
                #{activeProjectId.slice(0, 8)}
              </span>
            )}
          </div>
          {activePhase && (
            <div
              data-testid="active-phase-banner"
              style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: 'var(--gold-bg)', boxShadow: '0 0 0 0.5px rgba(212,184,90,0.35)', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <CircleNotch size={15} className="spin" style={{ color: 'var(--gold-soft)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gold-soft)' }}>
                  Fase {activePhase}/10 · {PHASES[activePhase - 1]?.label ?? '…'}
                </div>
                <div className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeMessage ?? 'Procesando…'}
                </div>
              </div>
            </div>
          )}
          <ol style={{ display: 'flex', flexDirection: 'column', gap: 6, listStyle: 'none', margin: 0, padding: 0 }} data-testid="pipeline-list">
            {PHASES.map((p) => {
              const update = phaseState[p.phase];
              const status = update?.status ?? 'pending';
              const Icon = p.icon;
              const tint =
                status === 'done' ? '#7fa8d8' : status === 'running' ? '#d4b85a' : status === 'failed' ? '#c8525e' : '#7a8a8a';
              return (
                <li
                  key={p.phase}
                  data-testid={`phase-${p.phase}`}
                  data-status={status}
                  data-message={update?.message ?? ''}
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    background: status === 'pending' ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)',
                    boxShadow:
                      status === 'running'
                        ? '0 0 0 0.5px rgba(212,184,90,0.40)'
                        : status === 'done'
                        ? '0 0 0 0.5px rgba(127, 168, 216,0.30)'
                        : status === 'failed'
                        ? '0 0 0 0.5px rgba(200,82,94,0.45)'
                        : 'inset 0 0.5px 0 rgba(255,255,255,0.05)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="lg-tile md" style={{ '--tint': tint } as CSSProperties}>
                      {status === 'done' ? <CheckCircle size={13} weight="fill" /> : status === 'failed' ? <Warning size={13} /> : status === 'running' ? <CircleNotch size={13} className="spin" /> : <Icon size={13} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</div>
                      <div className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {update?.message ?? p.hint}
                      </div>
                    </div>
                    {update && update.progress > 0 && update.progress < 100 && (
                      <span className="mono" style={{ fontSize: 11 }}>{Math.round(update.progress)}%</span>
                    )}
                  </div>
                  {status === 'running' && (
                    <PhaseDetail
                      phase={p.phase}
                      progress={update?.progress ?? 0}
                      imageCount={imageThumbs.length}
                      imageTotal={imageThumbs[0]?.total ?? 0}
                    />
                  )}
                </li>
              );
            })}
          </ol>

          {imageThumbs.length > 0 && (
            <div style={{ marginTop: 18 }} data-testid="image-thumbs">
              <div className="caption" style={{ marginBottom: 8, fontWeight: 600 }}>
                Imágenes generadas <span style={{ color: 'var(--gold-soft)' }}>({imageThumbs.length})</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
                {imageThumbs.map((t) => (
                  <div
                    key={t.index}
                    style={{ position: 'relative', aspectRatio: '3/4', borderRadius: 8, overflow: 'hidden', background: 'rgba(0,0,0,0.4)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.06)' }}
                    title={t.prompt}
                  >
                    <img
                      src={convertFileSrc(t.image_path)}
                      alt={`Imagen ${t.index + 1}`}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <div className="mono" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '1px 4px', background: 'rgba(0,0,0,0.7)', color: 'var(--gold-soft)', fontSize: 9 }}>
                      {t.index + 1}/{t.total}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <ChapterPreview />

          {error && (
            <div
              data-testid="pipeline-error"
              style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--red-bg)', boxShadow: '0 0 0 0.5px rgba(200,82,94,0.45)', fontSize: 12, display: 'flex', gap: 8 }}
            >
              <Warning size={15} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}
        </aside>
      </div>

      <VoiceWizard
        open={voiceWizardOpen}
        onClose={() => setVoiceWizardOpen(false)}
        onCreated={(cloneId) => {
          setVoice(`clone:${cloneId}`);
          refetchVoices();
        }}
        defaultPrimary={primaryLang}
      />
    </div>
  );
}

/* ─── Premium per-phase feedback (ported from design/screens/generator.jsx
   PhaseDetail + Waveform, wired to REAL pipeline signals — no fabricated
   numbers). The bar visualisers are a visual IDIOM (like a spinner), not
   a sample-accurate render of the audio; the image count, progress bar
   and phase are real. JS-tick driven so they keep animating even under
   prefers-reduced-motion (functional feedback, not decoration). */
function useTick(ms = 120): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

const DETAIL_BOX: CSSProperties = {
  background: 'rgba(0,0,0,0.22)',
  borderRadius: 6,
  boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.05)',
};

function Waveform() {
  const tick = useTick(110);
  const bars = Array.from(
    { length: 30 },
    (_, i) => 3 + Math.abs(Math.sin((i + tick) * 0.4) * 13 + Math.sin((i + tick * 0.5) * 0.7) * 4),
  );
  return (
    <div style={{ ...DETAIL_BOX, display: 'flex', alignItems: 'center', gap: 2, height: 26, padding: '0 7px' }}>
      {bars.map((h, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: h,
            background: 'var(--accent)',
            borderRadius: 1,
            opacity: 0.32 + (h / 17) * 0.68,
            transition: 'height 110ms linear',
          }}
        />
      ))}
    </div>
  );
}

function MusicBars() {
  const tick = useTick(150);
  // Fewer, chunkier columns with a syncopated beat — visually distinct
  // from the narration waveform so the two phases never look the same.
  const bars = Array.from({ length: 14 }, (_, i) => {
    const beat = Math.sin((tick + i * 1.7) * 0.5) + Math.sin((tick * 0.6 + i) * 1.1) * 0.5;
    return 4 + Math.abs(beat) * 11;
  });
  return (
    <div style={{ ...DETAIL_BOX, display: 'flex', alignItems: 'flex-end', gap: 3, height: 28, padding: '4px 8px' }}>
      {bars.map((h, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: h,
            background: 'linear-gradient(180deg, var(--gold-soft), var(--accent-deep))',
            borderRadius: 2,
            transition: 'height 150ms ease',
          }}
        />
      ))}
    </div>
  );
}

function ScriptSkeleton() {
  const tick = useTick(450);
  const widths = ['92%', '78%', '85%', '64%'];
  return (
    <div style={{ ...DETAIL_BOX, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {widths.map((w, i) => (
        <div
          key={i}
          style={{
            height: 7,
            width: w,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.10)',
            opacity: i === tick % widths.length ? 0.9 : 0.35,
            transition: 'opacity 420ms ease',
          }}
        />
      ))}
      <span
        style={{
          width: 6,
          height: 11,
          marginTop: 1,
          background: 'var(--accent-soft)',
          borderRadius: 1,
          opacity: tick % 2 ? 1 : 0.15,
          transition: 'opacity 220ms steps(1)',
        }}
      />
    </div>
  );
}

function FilmProgress({ progress }: { progress: number }) {
  return (
    <div
      style={{
        ...DETAIL_BOX,
        height: 32,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 8px',
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <div
          key={i}
          style={{ flex: 1, height: 18, borderRadius: 2, background: 'rgba(255,255,255,0.06)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.06)' }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: 2,
          width: `${Math.max(2, Math.min(100, progress))}%`,
          background: 'var(--accent)',
          transition: 'width 500ms var(--ease)',
        }}
      />
    </div>
  );
}

function CaptionFrame({ progress }: { progress: number }) {
  const tick = useTick(600);
  // Honest placeholder: we have no subtitle text in the store. Show a
  // caption-styled frame (what the burned-in subs will look like) with
  // a live cursor + real progress underline — never fabricated text.
  return (
    <div style={{ ...DETAIL_BOX, padding: '10px 10px 8px', position: 'relative' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'center' }}>
        <div style={{ height: 6, width: '70%', borderRadius: 999, background: 'rgba(255,255,255,0.14)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ height: 6, width: 90, borderRadius: 999, background: 'rgba(255,255,255,0.10)' }} />
          <span
            style={{
              width: 5,
              height: 9,
              background: 'var(--accent-soft)',
              borderRadius: 1,
              opacity: tick % 2 ? 1 : 0.2,
              transition: 'opacity 260ms steps(1)',
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: 2,
          width: `${Math.max(2, Math.min(100, progress))}%`,
          background: 'var(--accent)',
          transition: 'width 500ms var(--ease)',
        }}
      />
    </div>
  );
}

function PhaseDetail({
  phase,
  progress,
  imageCount,
  imageTotal,
}: {
  phase: number;
  progress: number;
  imageCount: number;
  imageTotal: number;
}) {
  if (phase === 1) return <ScriptSkeleton />;
  if (phase === 3) return <Waveform />;
  if (phase === 5) return <MusicBars />;
  if (phase === 4) {
    const total = imageTotal > 0 ? imageTotal : Math.max(imageCount, 1);
    const pct = total > 0 ? (imageCount / total) * 100 : 0;
    return (
      <div style={{ ...DETAIL_BOX, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--gold-soft)', flexShrink: 0 }}>
          {imageCount}{imageTotal > 0 ? `/${imageTotal}` : ''}
        </span>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: 'var(--accent)', transition: 'width 500ms var(--ease)' }} />
        </div>
      </div>
    );
  }
  if (phase === 6) return <FilmProgress progress={progress} />;
  if (phase === 8) return <CaptionFrame progress={progress} />;
  return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label className="eyebrow" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
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
      style={{
        width: '100%',
        textAlign: 'left',
        padding: 12,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 8,
        background: checked ? (warning ? 'var(--red-bg)' : 'var(--accent-bg)') : 'rgba(255,255,255,0.04)',
        boxShadow: checked
          ? `0 0 0 0.5px ${warning ? 'rgba(200,82,94,0.45)' : 'rgba(232, 201, 109,0.40)'}`
          : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
      }}
    >
      <span className={'toggle' + (checked ? ' on' : '')} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {warning && checked && <Warning size={12} style={{ color: 'var(--red)' }} />}
        </div>
        <div className="caption">{description}</div>
      </div>
    </button>
  );
}
