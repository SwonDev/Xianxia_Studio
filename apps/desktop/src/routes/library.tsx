import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Library as LibraryIcon, Trash2, FolderOpen, Play, X, Brain, Loader2, Wand2, Sparkles, Scissors as ScissorsIcon } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { tauri, type LibraryVideo } from '@/lib/tauri';
import { useToast } from '@/components/toast';
import { cn, formatDuration, formatBytes } from '@/lib/utils';

interface BoringSpot {
  start_seconds: number;
  end_seconds: number;
  intensity: number;
  dominant_issue: string;
  suggested_fix: string;
}
interface EngagementReport {
  overall_score: number;
  score_per_second: number[];
  boring_spots: BoringSpot[];
  peak_moments: number[];
  duration_seconds: number;
}

export const Route = createFileRoute('/library')({
  component: LibraryRoute,
});

function LibraryRoute() {
  const qc = useQueryClient();
  const { toast, confirmDialog } = useToast();
  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['library'],
    queryFn: tauri.libraryListVideos,
    refetchInterval: 8000,
  });
  const [previewing, setPreviewing] = useState<LibraryVideo | null>(null);

  const remove = async (v: LibraryVideo) => {
    const ok = await confirmDialog({
      title: `¿Borrar "${v.title}"?`,
      body: 'Esta acción no se puede deshacer. Se eliminará el MP4 y la miniatura.',
      confirmLabel: 'Borrar',
      cancelLabel: 'Cancelar',
      danger: true,
    });
    if (!ok) return;
    try {
      await tauri.libraryDeleteVideo(v.video_path);
      qc.invalidateQueries({ queryKey: ['library'] });
      toast.success('Vídeo borrado', v.title);
    } catch (e) {
      toast.error('Error al borrar', String(e));
    }
  };

  const openFolder = async () => {
    try {
      // Rust command opens the OS explorer directly — no shell:open scope dance.
      await tauri.libraryOpenFolder();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
            Archivo
          </p>
          <h1 className="font-display text-4xl font-medium">Biblioteca</h1>
          <p className="text-paper-300 mt-2 max-w-2xl">
            Todos los vídeos producidos. Pasa el cursor para previsualizar, click para reproducir a pantalla completa.
          </p>
        </div>
        <button
          onClick={openFolder}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-obsidian-800 border border-border/50 hover:border-gold-500/50 text-sm text-paper-200"
          data-testid="library-open-folder"
        >
          <FolderOpen className="w-4 h-4" />
          Abrir carpeta
        </button>
      </header>

      {isLoading && <div className="text-sm text-paper-300">Cargando…</div>}

      {!isLoading && videos.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-12 flex flex-col items-center justify-center text-center min-h-[40vh]" data-testid="library-empty">
          <LibraryIcon className="w-10 h-10 text-gold-400/50 mb-4" />
          <h2 className="font-display text-2xl text-paper-100 mb-1">Aún no hay vídeos</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Empieza creando un vídeo desde un tema, o extrae Shorts virales de un MP4 existente.
          </p>
          <div className="flex gap-3">
            <a
              href="/generator"
              data-testid="library-empty-cta-generator"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-gold-500 text-obsidian-950 hover:bg-gold-300 text-sm font-medium shadow-glow-gold transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Crear vídeo desde un tema
            </a>
            <a
              href="/shorts"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-obsidian-800 border border-border/60 hover:border-gold-500/50 text-paper-200 text-sm transition-colors"
            >
              <ScissorsIcon className="w-4 h-4" />
              Extraer Shorts de un MP4
            </a>
          </div>
        </div>
      )}

      {videos.length > 0 && (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          data-testid="library-grid"
        >
          {videos.map((v) => (
            <VideoCard
              key={v.video_path}
              video={v}
              onPlay={() => setPreviewing(v)}
              onDelete={() => remove(v)}
            />
          ))}
        </div>
      )}

      {previewing && (
        <FullscreenPreview video={previewing} onClose={() => setPreviewing(null)} />
      )}
    </motion.div>
  );
}

function VideoCard({
  video,
  onPlay,
  onDelete,
}: {
  video: LibraryVideo;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [hover, setHover] = useState(false);
  const [engagement, setEngagement] = useState<EngagementReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [engageError, setEngageError] = useState<string | null>(null);
  const isVertical = video.height && video.width && video.height > video.width;
  const aspect = isVertical ? 'aspect-[9/16]' : 'aspect-video';

  const analyzeNow = async () => {
    setAnalyzing(true); setEngageError(null);
    try {
      const r = await fetch('http://127.0.0.1:8731/engagement/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_path: video.video_path, mode: 'light' }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(r.status === 503 ? 'TRIBE v2 no instalado' : `HTTP ${r.status}: ${t.slice(0, 120)}`);
      }
      setEngagement(await r.json());
    } catch (e) {
      setEngageError(String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const optimizeNow = async () => {
    if (!engagement) return;
    setOptimizing(true); setEngageError(null);
    try {
      const r = await fetch('http://127.0.0.1:8731/engagement/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: video.video_path,
          boring_spots: engagement.boring_spots,
          allow_cut: true,
          allow_audio_swell: true,
          allow_broll: false,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      toast.success(
        `${j.spots_fixed} valles arreglados`,
        `Vídeo optimizado guardado en ${j.out_path.split(/[\\/]/).pop()}`,
      );
    } catch (e) {
      setEngageError(String(e));
      toast.error('Error optimizando', String(e));
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <article
      className="rounded-lg border border-border/50 bg-card/60 hover:border-gold-500/40 transition-colors duration-200 overflow-hidden group"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={cn('relative bg-obsidian-900 cursor-pointer overflow-hidden', aspect)}
        onClick={onPlay}
      >
        {video.poster_path && !hover && (
          <img
            src={convertFileSrc(video.poster_path)}
            alt={video.title}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
        {hover && (
          <video
            src={convertFileSrc(video.video_path)}
            muted
            loop
            playsInline
            autoPlay
            preload="metadata"
            className="w-full h-full object-cover"
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-obsidian-950/30">
          <Play className="w-12 h-12 text-gold-300 drop-shadow-lg" />
        </div>
        {video.duration_seconds !== null && (
          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-obsidian-950/80 text-[10px] font-mono text-gold-300 tabular-nums">
            {formatDuration(video.duration_seconds!)}
          </span>
        )}
      </div>
      <div className="p-3 flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-paper-100 truncate" title={video.title}>
            {video.title}
          </h3>
          <div className="text-[11px] text-paper-400 mt-0.5 flex items-center gap-2">
            <span>{video.width}×{video.height}</span>
            <span>·</span>
            <span>{formatBytes(video.size_bytes)}</span>
            <span>·</span>
            <span>{new Date(video.modified_at * 1000).toLocaleDateString('es-ES')}</span>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1.5 rounded text-paper-300 hover:text-crimson-400 hover:bg-crimson-500/10 transition-colors"
          aria-label={`Borrar ${video.title}`}
          data-testid={`delete-${video.project_id}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Engagement panel */}
      <div className="px-3 pb-3 -mt-1" data-testid={`engagement-${video.project_id}`}>
        {!engagement && !analyzing && (
          <button
            onClick={(e) => { e.stopPropagation(); analyzeNow(); }}
            data-testid={`analyze-${video.project_id}`}
            className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md bg-obsidian-800 border border-border/40 hover:border-gold-500/50 hover:bg-gold-500/5 text-paper-300"
          >
            <Brain className="w-3 h-3" />
            Analizar engagement (TRIBE v2)
          </button>
        )}
        {analyzing && (
          <div className="text-[11px] text-paper-300 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin text-gold-400" />
            Analizando con TRIBE v2…
          </div>
        )}
        {engagement && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-paper-400">Engagement</span>
              <span className={cn(
                'text-sm font-bold tabular-nums',
                engagement.overall_score >= 65 ? 'text-jade-300' :
                engagement.overall_score >= 45 ? 'text-gold-300' : 'text-crimson-300',
              )}>
                {engagement.overall_score.toFixed(0)}/100
              </span>
            </div>
            <EngagementHeatmap scores={engagement.score_per_second} />
            {engagement.boring_spots.length > 0 && (
              <div className="text-[10px] text-paper-300">
                {engagement.boring_spots.length} valle{engagement.boring_spots.length === 1 ? '' : 's'} aburrido{engagement.boring_spots.length === 1 ? '' : 's'}:{' '}
                {engagement.boring_spots.slice(0, 3).map((s) =>
                  `${formatDuration(s.start_seconds)}-${formatDuration(s.end_seconds)}`).join(', ')}
                {engagement.boring_spots.length > 3 && '…'}
              </div>
            )}
            {engagement.boring_spots.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); optimizeNow(); }}
                disabled={optimizing}
                data-testid={`optimize-${video.project_id}`}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md transition-colors',
                  optimizing
                    ? 'bg-obsidian-800 text-paper-400 cursor-wait'
                    : 'bg-gold-500/15 border border-gold-500/40 text-gold-300 hover:bg-gold-500/25',
                )}
              >
                {optimizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                {optimizing ? 'Optimizando…' : `Auto-optimizar ${engagement.boring_spots.length} valles`}
              </button>
            )}
          </div>
        )}
        {engageError && (
          <div className="text-[10px] text-crimson-400 mt-1">{engageError}</div>
        )}
      </div>
    </article>
  );
}

function EngagementHeatmap({ scores }: { scores: number[] }) {
  // Render scores as a horizontal heatmap bar (8 px tall)
  if (!scores || scores.length === 0) return null;
  // Downsample to ~80 cells max
  const target = 80;
  const step = Math.max(1, Math.floor(scores.length / target));
  const cells: number[] = [];
  for (let i = 0; i < scores.length; i += step) {
    let sum = 0; let n = 0;
    for (let j = i; j < Math.min(i + step, scores.length); j++) {
      sum += scores[j] ?? 0; n++;
    }
    cells.push(sum / Math.max(1, n));
  }
  return (
    <div className="flex h-2 rounded overflow-hidden gap-px bg-obsidian-900" title="Engagement por segundo">
      {cells.map((v, i) => {
        // v is 0-1
        const hue = Math.round(v * 120); // 0=red 60=yellow 120=green
        return (
          <div
            key={i}
            className="flex-1"
            style={{ background: `hsl(${hue} 70% 45%)` }}
          />
        );
      })}
    </div>
  );
}

function FullscreenPreview({ video, onClose }: { video: LibraryVideo; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-obsidian-950/95 backdrop-blur flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="fullscreen-preview"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-obsidian-800 hover:bg-obsidian-700 text-paper-100"
        aria-label="Cerrar"
      >
        <X className="w-5 h-5" />
      </button>
      <video
        src={convertFileSrc(video.video_path)}
        controls
        autoPlay
        className="max-w-full max-h-full rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
