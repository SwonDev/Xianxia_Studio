/**
 * Smart Shorts standalone — OpusClip-style local pipeline.
 *
 * Pick any MP4 → Whisper transcribes → LLM scores 12 candidates → top N
 * non-overlapping segments cut + reframed 1080×1920 + ASS karaoke burned in
 * with the chosen caption style.
 *
 * 100 % local: no upload, no cloud. Same hardware budget as the main pipeline.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Scissors, Upload, Loader2, AlertTriangle, CheckCircle2, Play, Sparkles } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/shorts')({
  component: ShortsRoute,
});

interface ShortInfo {
  output_path: string;
  start_seconds: number;
  duration_seconds: number;
  hook_score: number;
  climax_score: number;
  standalone_score: number;
  text_preview: string;
}

const CAPTION_STYLES = [
  { id: 'hormozi', label: 'Hormozi', desc: 'Amarillo + outline negro · viral' },
  { id: 'mrbeast', label: 'MrBeast', desc: 'Rojo highlight · alto contraste' },
  { id: 'xianxia', label: 'Xianxia', desc: 'Oro + jade · cinematográfico' },
  { id: 'minimal', label: 'Minimal', desc: 'Blanco simple · sin distraer' },
  { id: 'neon',    label: 'Neon',    desc: 'Cyan + magenta · gamer/futuristic' },
];

function ShortsRoute() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [nShorts, setNShorts] = useState(3);
  const [duration, setDuration] = useState(45);
  const [captionStyle, setCaptionStyle] = useState('hormozi');
  const [burnSubs, setBurnSubs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ShortInfo[] | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);

  const pickVideo = async () => {
    setError(null);
    const sel = await openDialog({
      multiple: false,
      filters: [{ name: 'Vídeo', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
    });
    if (typeof sel === 'string') setVideoPath(sel);
  };

  const run = async () => {
    if (!videoPath) {
      setError('Selecciona un vídeo primero.');
      return;
    }
    setBusy(true);
    setError(null);
    setResults(null);
    setProgress('Transcribiendo audio con Whisper…');
    try {
      const phaseTimer = setTimeout(() => setProgress('Puntuando segmentos con LLM (xianxia-llm)…'), 12_000);
      const cutTimer = setTimeout(() => setProgress('Cortando + reframe + quemando captions…'), 35_000);
      const r = await fetch('http://127.0.0.1:8731/shorts/from_video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: videoPath,
          n_shorts: nShorts,
          target_duration: duration,
          burn_subs: burnSubs,
          caption_style: captionStyle,
        }),
      });
      clearTimeout(phaseTimer);
      clearTimeout(cutTimer);
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const j = await r.json();
      setResults(j.shorts ?? []);
      setProgress('');
      qc.invalidateQueries({ queryKey: ['library'] });
    } catch (e) {
      setError(String(e));
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6 max-w-5xl"
    >
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
          Auto-edición
        </p>
        <h1 className="font-display text-4xl font-medium flex items-center gap-3">
          <Scissors className="w-9 h-9 text-gold-400" />
          Smart Shorts
        </h1>
        <p className="text-paper-300 mt-2 max-w-2xl">
          Sube un MP4 (podcast, charla, gameplay, vlog…) y la app extraerá
          automáticamente <strong>{nShorts} Shorts virales</strong> de {duration}s usando Whisper +
          LLM scoring (hook · climax · standalone). 100% local, ningún byte sale de tu máquina.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Form */}
        <section className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-6 space-y-5">
          <div>
            <label className="block text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
              Vídeo de entrada
            </label>
            <button
              onClick={pickVideo}
              data-testid="shorts-pick-video"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files ?? []);
                const mp4 = files.find((f) =>
                  /\.(mp4|mov|mkv|webm|avi)$/i.test(f.name),
                );
                if (mp4) {
                  // In Tauri webview the File object exposes `path` for dropped
                  // files (custom Tauri augmentation). In browser-mode this
                  // path is empty — fallback: ask user to use the picker.
                  const p = (mp4 as File & { path?: string }).path;
                  if (p) {
                    setVideoPath(p);
                    toast.success('Vídeo cargado', mp4.name);
                  } else {
                    toast.warning(
                      'Drag-and-drop no soportado en el navegador',
                      'Usa "Elegir vídeo" en lugar del drop.',
                    );
                  }
                }
              }}
              className={cn(
                'w-full inline-flex items-center justify-center gap-2 px-4 py-6 rounded-md text-sm text-paper-200 transition-colors border-2 border-dashed',
                dragOver
                  ? 'border-gold-500 bg-gold-500/10'
                  : 'bg-obsidian-800 border-border/60 hover:border-gold-500/60',
              )}
            >
              <Upload className="w-5 h-5" />
              {videoPath ? (
                <span className="font-mono truncate max-w-[400px]" title={videoPath}>
                  {videoPath.split(/[\\/]/).pop()}
                </span>
              ) : dragOver ? (
                'Suelta el vídeo aquí'
              ) : (
                'Elegir vídeo o arrastrar (MP4 / MOV / MKV / WebM)'
              )}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
                Cantidad de Shorts
              </label>
              <input
                type="range"
                min={1}
                max={10}
                value={nShorts}
                onChange={(e) => setNShorts(Number(e.target.value))}
                data-testid="shorts-count"
                className="w-full accent-gold-500"
              />
              <div className="text-sm text-paper-200 mt-1 font-mono">{nShorts}</div>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
                Duración objetivo (s)
              </label>
              <input
                type="range"
                min={15}
                max={60}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                data-testid="shorts-duration"
                className="w-full accent-gold-500"
              />
              <div className="text-sm text-paper-200 mt-1 font-mono">{duration}s</div>
            </div>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-paper-300 mb-2 font-medium">
              Estilo de subtítulos
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CAPTION_STYLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setCaptionStyle(s.id)}
                  data-testid={`caption-style-${s.id}`}
                  className={cn(
                    'px-3 py-2 rounded-md border text-left transition-all',
                    captionStyle === s.id
                      ? 'bg-gold-500/15 border-gold-500 text-paper-100'
                      : 'bg-obsidian-800 border-border/40 text-paper-300 hover:border-gold-500/40',
                  )}
                >
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="text-[10px] text-paper-400 leading-tight">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={burnSubs}
              onChange={(e) => setBurnSubs(e.target.checked)}
              className="mt-0.5 accent-gold-500"
            />
            <div className="text-sm">
              <div className="font-medium text-paper-100">Quemar subtítulos en el MP4</div>
              <div className="text-xs text-paper-300">
                Si está activo, el karaoke se imprime sobre el vídeo. Desactiva si solo quieres el corte.
              </div>
            </div>
          </label>

          <button
            onClick={run}
            data-testid="shorts-run"
            disabled={busy || !videoPath}
            className={cn(
              'w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md font-medium text-sm transition-colors',
              busy || !videoPath
                ? 'bg-obsidian-800 text-paper-400 cursor-not-allowed'
                : 'bg-gold-500 text-obsidian-950 hover:bg-gold-300 shadow-glow-gold',
            )}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {busy ? (progress || 'Procesando…') : `Extraer ${nShorts} Shorts`}
          </button>

          {error && (
            <div data-testid="shorts-error" className="p-3 rounded-md bg-crimson-500/15 border border-crimson-500/40 text-xs text-paper-100 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-crimson-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {/* Tips */}
        <aside className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-5 text-sm text-paper-300 space-y-3 h-fit">
          <h3 className="font-display text-lg text-paper-100">Cómo funciona</h3>
          <ol className="list-decimal list-inside space-y-1.5 text-xs leading-relaxed">
            <li>Whisper-large-v3 transcribe con timestamps por palabra (auto-detect idioma).</li>
            <li>Agrupamos las palabras en frases por silencios &gt;0.4 s.</li>
            <li>El LLM puntúa 12 segmentos candidatos en hook · climax · standalone.</li>
            <li>Seleccionamos los top {nShorts} que no se solapan.</li>
            <li>FFmpeg corta + crop 9:16 + lanczos + loudnorm -14 LUFS + NVENC p7.</li>
            <li>Karaoke ASS quemado con safe zones TikTok (top 7%, bottom 18%).</li>
          </ol>
          <div className="pt-3 border-t border-border/40">
            <p className="text-[11px] text-paper-400">
              ⏱️ Tiempo estimado: ~1-2× duración del vídeo en RTX 4060 8 GB.
            </p>
          </div>
        </aside>
      </div>

      {results && results.length > 0 && (
        <section className="space-y-3" data-testid="shorts-results">
          <h2 className="font-display text-2xl flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6 text-jade-400" />
            {results.length} Shorts generados
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((s, i) => (
              <ShortResultCard key={s.output_path} short={s} index={i} />
            ))}
          </div>
        </section>
      )}
    </motion.div>
  );
}

function ShortResultCard({ short, index }: { short: ShortInfo; index: number }) {
  const [hover, setHover] = useState(false);
  const total = (0.4 * short.hook_score + 0.4 * short.climax_score + 0.2 * short.standalone_score) * 100;
  return (
    <article
      className="rounded-lg border border-border/50 bg-card/60 overflow-hidden hover:border-gold-500/40 transition-colors"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="relative aspect-[9/16] bg-obsidian-900">
        <video
          src={convertFileSrc(short.output_path)}
          muted
          loop
          playsInline
          autoPlay={hover}
          preload="metadata"
          className="w-full h-full object-cover"
        />
        {!hover && (
          <div className="absolute inset-0 flex items-center justify-center bg-obsidian-950/40">
            <Play className="w-12 h-12 text-gold-300 drop-shadow-lg" />
          </div>
        )}
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-obsidian-950/80 text-[11px] font-mono text-gold-300">
          #{index + 1}
        </span>
        <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-jade-500/30 border border-jade-500/50 text-[11px] font-bold text-jade-200">
          {total.toFixed(0)}/100
        </span>
        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-obsidian-950/80 text-[10px] font-mono text-paper-200 tabular-nums">
          {Math.round(short.duration_seconds)}s
        </span>
      </div>
      <div className="p-3 space-y-2">
        <p className="text-xs text-paper-200 line-clamp-3" title={short.text_preview}>
          {short.text_preview}
        </p>
        <div className="grid grid-cols-3 gap-1 text-[10px] text-paper-400">
          <ScoreBar label="Hook" value={short.hook_score} />
          <ScoreBar label="Climax" value={short.climax_score} />
          <ScoreBar label="Standalone" value={short.standalone_score} />
        </div>
      </div>
    </article>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-paper-300">{pct}</span>
      </div>
      <div className="h-1 rounded-full bg-obsidian-800 overflow-hidden">
        <div
          className={cn(
            'h-full transition-all',
            pct >= 75 ? 'bg-jade-400' : pct >= 50 ? 'bg-gold-400' : 'bg-crimson-400',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
