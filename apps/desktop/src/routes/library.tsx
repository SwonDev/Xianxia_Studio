import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode, type MouseEvent, type CSSProperties } from 'react';
import {
  Books, Trash, FolderOpen, Play, X, Brain, CircleNotch, MagicWand,
  Sparkle, Scissors, MagnifyingGlass, Copy, Check, TiktokLogo,
} from '@phosphor-icons/react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { convertFileSrc } from '@/lib/tauri-asset';
import { tauri, type LibraryVideo } from '@/lib/tauri';
import { useToast } from '@/components/toast';
import { formatDuration, formatBytes } from '@/lib/utils';
import { PageHeader } from '@/components/ui-glass';

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
interface SeoChapter {
  timestamp: string;
  seconds: number;
  title: string;
}
interface SeoPack {
  title: string;
  title_variants: string[];
  primary_keyword: string;
  secondary_keywords: string[];
  descriptions: Record<string, string>;
  tags: string[];
  hashtags: string[];
  chapters: SeoChapter[];
  seo_score: number;
}

export const Route = createFileRoute('/library')({
  component: LibraryRoute,
});

/** A video is vertical (9:16 Shorts) when its height exceeds its width.
 *  Dimensions can be null while metadata is still being read — treat
 *  those as horizontal so they group with the 16:9 catalogue. */
const isVerticalVideo = (v: LibraryVideo): boolean =>
  !!(v.height && v.width && v.height > v.width);

function LibraryRoute() {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
      await tauri.libraryOpenFolder();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="route-enter page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Biblioteca"
        subtitle="Vídeos producidos en este equipo. Pasa el cursor para previsualizar, click para pantalla completa."
        action={
          <button className="btn" onClick={openFolder} data-testid="library-open-folder">
            <FolderOpen size={13} />
            Abrir carpeta
          </button>
        }
      />

      {isLoading && <div className="muted" style={{ fontSize: 13 }}>Cargando…</div>}

      {!isLoading && videos.length === 0 && (
        <div
          className="group"
          data-testid="library-empty"
          style={{
            padding: 48,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            minHeight: '40vh',
            justifyContent: 'center',
          }}
        >
          <span className="lg-tile xl" style={{ '--tint': '#e8c96d', marginBottom: 16 } as CSSProperties}>
            <Books size={18} />
          </span>
          <h2 className="section-header" style={{ marginBottom: 4 }}>Aún no hay vídeos</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 24, maxWidth: 420 }}>
            Empieza creando un vídeo desde un tema, o extrae Shorts virales de un MP4 existente.
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              className="btn-primary large"
              data-testid="library-empty-cta-generator"
              onClick={() => navigate({ to: '/generator' })}
            >
              <Sparkle size={13} />
              Crear vídeo desde un tema
            </button>
            <button className="btn large" onClick={() => navigate({ to: '/shorts' })}>
              <Scissors size={13} />
              Extraer Shorts de un MP4
            </button>
          </div>
        </div>
      )}

      {videos.length > 0 && (
        <div data-testid="library-grid" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <VideoSection
            label="Horizontal"
            hint="16:9 · YouTube"
            testid="library-grid-horizontal"
            minCardWidth={280}
            videos={videos.filter((v) => !isVerticalVideo(v))}
            onPlay={setPreviewing}
            onDelete={remove}
          />
          <VideoSection
            label="Vertical · Shorts"
            hint="9:16 · Shorts / TikTok"
            testid="library-grid-vertical"
            minCardWidth={210}
            videos={videos.filter(isVerticalVideo)}
            onPlay={setPreviewing}
            onDelete={remove}
          />
        </div>
      )}

      {previewing && <FullscreenPreview video={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  );
}

/** One labelled catalogue section (horizontal or vertical). Renders
 *  nothing when it has no videos, so a library with only one orientation
 *  shows a single clean section instead of an empty header. */
function VideoSection({
  label,
  hint,
  testid,
  minCardWidth,
  videos,
  onPlay,
  onDelete,
}: {
  label: string;
  hint: string;
  testid: string;
  minCardWidth: number;
  videos: LibraryVideo[];
  onPlay: (v: LibraryVideo) => void;
  onDelete: (v: LibraryVideo) => void;
}) {
  if (videos.length === 0) return null;
  return (
    <section data-testid={testid}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <h2 className="section-header" style={{ margin: 0 }}>{label}</h2>
        <span className="caption">
          {hint} · {videos.length} vídeo{videos.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill,minmax(${minCardWidth}px,1fr))`,
          gap: 16,
        }}
      >
        {videos.map((v) => (
          <VideoCard key={v.video_path} video={v} onPlay={() => onPlay(v)} onDelete={() => onDelete(v)} />
        ))}
      </div>
    </section>
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
  const [seo, setSeo] = useState<SeoPack | null>(null);
  const [seoLoading, setSeoLoading] = useState(false);
  const [seoError, setSeoError] = useState<string | null>(null);
  const [seoLang, setSeoLang] = useState<string | null>(null);
  const isVertical = isVerticalVideo(video);

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

  const generateSeo = async () => {
    setSeoLoading(true); setSeoError(null);
    try {
      const r = await fetch('http://127.0.0.1:8731/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: video.project_id }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(
          r.status === 422
            ? 'Sin guion guardado para este proyecto (regenéralo con esta versión)'
            : `HTTP ${r.status}: ${t.slice(0, 140)}`,
        );
      }
      const pack: SeoPack = await r.json();
      setSeo(pack);
      setSeoLang(Object.keys(pack.descriptions)[0] ?? null);
      toast.success('Metadatos SEO listos', `Score ${pack.seo_score}/100`);
    } catch (e) {
      setSeoError(String(e));
      toast.error('Error generando SEO', String(e));
    } finally {
      setSeoLoading(false);
    }
  };

  const publishTikTok = async () => {
    try {
      // Reveal the rendered vertical MP4 (pre-selected) so the user can drag
      // it straight into TikTok's web uploader, then open that uploader.
      await tauri.libraryRevealVideo(video.video_path);
      await openUrl('https://www.tiktok.com/upload');
      toast.success(
        'TikTok abierto',
        'Arrastra el MP4 seleccionado en el explorador a la página de subida.',
      );
    } catch (e) {
      toast.error('No se pudo abrir TikTok', String(e));
    }
  };

  const scoreColor = (s: number, hi: number, mid: number) =>
    s >= hi ? 'var(--green)' : s >= mid ? 'var(--gold-soft)' : 'var(--red)';

  return (
    <article
      className="group"
      style={{ overflow: 'hidden' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          position: 'relative',
          background: 'rgba(0,0,0,0.5)',
          cursor: 'pointer',
          overflow: 'hidden',
          aspectRatio: isVertical ? '9/16' : '16/9',
        }}
        onClick={onPlay}
      >
        {video.poster_path && !hover && (
          <img
            src={convertFileSrc(video.poster_path)}
            alt={video.title}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
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
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.30)',
            opacity: hover ? 1 : 0,
            transition: 'opacity 160ms',
          }}
        >
          <Play size={42} weight="fill" style={{ color: 'var(--gold-soft)' }} />
        </div>
        {video.duration_seconds !== null && (
          <span
            className="mono"
            style={{ position: 'absolute', bottom: 8, right: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.75)', color: 'var(--gold-soft)', fontSize: 10 }}
          >
            {formatDuration(video.duration_seconds!)}
          </span>
        )}
      </div>
      <div style={{ padding: 12, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }} title={video.title}>
            {video.title}
          </h3>
          <div className="caption" style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{video.width}×{video.height}</span><span>·</span>
            <span>{formatBytes(video.size_bytes)}</span><span>·</span>
            <span>{new Date(video.modified_at * 1000).toLocaleDateString('es-ES')}</span>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label={`Borrar ${video.title}`}
          data-testid={`delete-${video.project_id}`}
          className="btn-ghost"
          style={{ padding: 6, height: 26 }}
        >
          <Trash size={14} />
        </button>
      </div>

      {/* TikTok assisted publish — vertical (Shorts) only */}
      {isVertical && (
        <div style={{ padding: '0 12px 10px' }}>
          <button
            onClick={(e) => { e.stopPropagation(); publishTikTok(); }}
            data-testid={`tiktok-publish-${video.project_id}`}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', fontSize: 11.5 }}
            title="Abre el subidor de TikTok y selecciona este MP4 en el explorador"
          >
            <TiktokLogo size={12} weight="fill" />
            Publicar en TikTok
          </button>
        </div>
      )}

      {/* Engagement panel */}
      <div style={{ padding: '0 12px 12px' }} data-testid={`engagement-${video.project_id}`}>
        {!engagement && !analyzing && (
          <button
            onClick={(e) => { e.stopPropagation(); analyzeNow(); }}
            data-testid={`analyze-${video.project_id}`}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', fontSize: 11.5 }}
          >
            <Brain size={12} />
            Analizar engagement (TRIBE v2)
          </button>
        )}
        {analyzing && (
          <div className="caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CircleNotch size={12} className="pulse" style={{ color: 'var(--gold-soft)' }} />
            Analizando con TRIBE v2…
          </div>
        )}
        {engagement && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="eyebrow">Engagement</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: scoreColor(engagement.overall_score, 65, 45) }}>
                {engagement.overall_score.toFixed(0)}/100
              </span>
            </div>
            <EngagementHeatmap scores={engagement.score_per_second} />
            {engagement.boring_spots.length > 0 && (
              <div className="caption" style={{ fontSize: 10 }}>
                {engagement.boring_spots.length} valle{engagement.boring_spots.length === 1 ? '' : 's'} aburrido{engagement.boring_spots.length === 1 ? '' : 's'}:{' '}
                {engagement.boring_spots.slice(0, 3).map((s) => `${formatDuration(s.start_seconds)}-${formatDuration(s.end_seconds)}`).join(', ')}
                {engagement.boring_spots.length > 3 && '…'}
              </div>
            )}
            {engagement.boring_spots.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); optimizeNow(); }}
                disabled={optimizing}
                data-testid={`optimize-${video.project_id}`}
                className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', fontSize: 11.5 }}
              >
                {optimizing ? <CircleNotch size={12} className="pulse" /> : <MagicWand size={12} />}
                {optimizing ? 'Optimizando…' : `Auto-optimizar ${engagement.boring_spots.length} valles`}
              </button>
            )}
          </div>
        )}
        {engageError && <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>{engageError}</div>}
      </div>

      {/* SEO metadata pack panel */}
      <div style={{ padding: '8px 12px 12px', borderTop: '0.5px solid var(--separator)' }} data-testid={`seo-${video.project_id}`}>
        {!seo && !seoLoading && (
          <button
            onClick={(e) => { e.stopPropagation(); generateSeo(); }}
            data-testid={`seo-generate-${video.project_id}`}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', fontSize: 11.5 }}
          >
            <MagnifyingGlass size={12} />
            Generar metadatos SEO
          </button>
        )}
        {seoLoading && (
          <div className="caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CircleNotch size={12} className="pulse" style={{ color: 'var(--gold-soft)' }} />
            Generando metadatos SEO…
          </div>
        )}
        {seo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="eyebrow">Metadatos SEO</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: scoreColor(seo.seo_score, 70, 45) }}>
                {seo.seo_score}/100
              </span>
            </div>

            <SeoField label="Título" value={seo.title}>
              <p style={{ fontSize: 11, lineHeight: 1.4, margin: 0 }}>{seo.title}</p>
              {seo.title_variants.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 0, listStyle: 'none' }}>
                  {seo.title_variants.map((v, i) => (
                    <li key={i} className="caption" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>· {v}</li>
                  ))}
                </ul>
              )}
            </SeoField>

            {seoLang && seo.descriptions[seoLang] !== undefined && (
              <SeoField
                label="Descripción"
                value={seo.descriptions[seoLang]}
                header={
                  Object.keys(seo.descriptions).length > 1 ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {Object.keys(seo.descriptions).map((lg) => (
                        <button
                          key={lg}
                          onClick={(e) => { e.stopPropagation(); setSeoLang(lg); }}
                          style={{
                            padding: '1px 6px',
                            borderRadius: 4,
                            fontSize: 9,
                            textTransform: 'uppercase',
                            background: lg === seoLang ? 'var(--gold-bg)' : 'transparent',
                            color: lg === seoLang ? 'var(--gold-soft)' : 'var(--text-tertiary)',
                          }}
                        >
                          {lg}
                        </button>
                      ))}
                    </div>
                  ) : undefined
                }
              >
                <pre style={{ fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 128, overflowY: 'auto', fontFamily: 'var(--font-ui)', lineHeight: 1.5, margin: 0 }}>
                  {seo.descriptions[seoLang]}
                </pre>
              </SeoField>
            )}

            <SeoField label={`Tags (${seo.tags.length})`} value={seo.tags.join(', ')}>
              <p className="caption" style={{ fontSize: 10, wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: 0 } as CSSProperties}>
                {seo.tags.join(', ')}
              </p>
            </SeoField>

            {seo.hashtags.length > 0 && (
              <SeoField label="Hashtags" value={seo.hashtags.join(' ')}>
                <p style={{ fontSize: 10, color: 'var(--gold-soft)', wordBreak: 'break-word', margin: 0 }}>{seo.hashtags.join(' ')}</p>
              </SeoField>
            )}

            {seo.chapters.length > 0 && (
              <SeoField label={`Capítulos (${seo.chapters.length})`} value={seo.chapters.map((c) => `${c.timestamp} ${c.title}`).join('\n')}>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {seo.chapters.slice(0, 6).map((c, i) => (
                    <li key={i} className="caption" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="mono" style={{ color: 'var(--gold-soft)' }}>{c.timestamp}</span> {c.title}
                    </li>
                  ))}
                  {seo.chapters.length > 6 && (
                    <li className="caption" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>+{seo.chapters.length - 6} más…</li>
                  )}
                </ul>
              </SeoField>
            )}
          </div>
        )}
        {seoError && <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>{seoError}</div>}
      </div>
    </article>
  );
}

/** Labelled SEO block with a one-click copy button. */
function SeoField({
  label,
  value,
  header,
  children,
}: {
  label: string;
  value: string;
  header?: ReactNode;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };
  return (
    <div style={{ borderRadius: 8, background: 'rgba(0,0,0,0.26)', padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
        <span className="eyebrow" style={{ fontSize: 9, textTransform: 'uppercase' }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {header}
          <button
            onClick={copy}
            aria-label={`Copiar ${label}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, color: copied ? 'var(--green)' : 'var(--text-tertiary)' }}
          >
            {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

function EngagementHeatmap({ scores }: { scores: number[] }) {
  if (!scores || scores.length === 0) return null;
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
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 1, background: 'rgba(0,0,0,0.4)' }} title="Engagement por segundo">
      {cells.map((v, i) => {
        const hue = Math.round(v * 120);
        return <div key={i} style={{ flex: 1, background: `hsl(${hue} 60% 45%)` }} />;
      })}
    </div>
  );
}

function FullscreenPreview({ video, onClose }: { video: LibraryVideo; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      data-testid="fullscreen-preview"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(6,18,14,0.95)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <button
        onClick={onClose}
        aria-label="Cerrar"
        className="btn"
        style={{ position: 'absolute', top: 16, right: 16, width: 36, height: 36, padding: 0, justifyContent: 'center', borderRadius: 999 }}
      >
        <X size={18} />
      </button>
      <video
        src={convertFileSrc(video.video_path)}
        controls
        autoPlay
        style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 14, boxShadow: 'var(--shadow-popover)' }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
