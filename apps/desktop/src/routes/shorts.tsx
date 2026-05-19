/**
 * Smart Shorts standalone — OpusClip-style local pipeline.
 *
 * Pick any MP4 → Whisper transcribes → LLM scores 12 candidates → top N
 * non-overlapping segments cut + reframed 1080×1920 + ASS karaoke burned in
 * with the chosen caption style. 100 % local: no upload, no cloud.
 *
 * Visual: Liquid Glass (DESIGN.md v2). ALL wiring preserved (openDialog,
 * fetch /shorts/from_video, query invalidation, drag-drop, data-testid).
 */
import { createFileRoute } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Scissors, UploadSimple, CircleNotch, Warning, CheckCircle, Play, Sparkle } from '@phosphor-icons/react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@/lib/tauri-asset';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/ui-glass';

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
  { id: 'hormozi', label: 'Hormozi', desc: 'Amarillo + outline · viral' },
  { id: 'mrbeast', label: 'MrBeast', desc: 'Rojo highlight · alto contraste' },
  { id: 'xianxia', label: 'Xianxia', desc: 'Oro + jade · cinematográfico' },
  { id: 'minimal', label: 'Minimal', desc: 'Blanco simple · sin distraer' },
  { id: 'neon', label: 'Neon', desc: 'Cyan + magenta · futuristic' },
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
    <div className="route-enter page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Smart Shorts"
        subtitle={`Sube un MP4 (podcast, charla, gameplay, vlog…) y extrae ${nShorts} Shorts virales de ${duration}s con Whisper + LLM scoring.`}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 22, alignItems: 'start' }}>
        <section className="group" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
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
                const mp4 = files.find((f) => /\.(mp4|mov|mkv|webm|avi)$/i.test(f.name));
                if (mp4) {
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
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '24px 16px',
                borderRadius: 12,
                fontSize: 13,
                color: 'var(--text-secondary)',
                background: dragOver ? 'var(--accent-bg)' : 'rgba(0,0,0,0.22)',
                boxShadow: dragOver
                  ? '0 0 0 1.5px rgba(232, 201, 109,0.55)'
                  : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                transition: 'all 140ms',
              }}
            >
              <UploadSimple size={18} />
              {videoPath ? (
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 400 }} title={videoPath}>
                  {videoPath.split(/[\\/]/).pop()}
                </span>
              ) : dragOver ? (
                'Suelta el vídeo aquí'
              ) : (
                'Elegir vídeo o arrastrar (MP4 / MOV / MKV / WebM)'
              )}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Cantidad de Shorts</label>
              <input
                type="range"
                className="range"
                min={1}
                max={10}
                value={nShorts}
                onChange={(e) => setNShorts(Number(e.target.value))}
                data-testid="shorts-count"
              />
              <div className="mono" style={{ marginTop: 4 }}>{nShorts}</div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Duración objetivo (s)</label>
              <input
                type="range"
                className="range"
                min={15}
                max={60}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                data-testid="shorts-duration"
              />
              <div className="mono" style={{ marginTop: 4 }}>{duration}s</div>
            </div>
          </div>

          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Estilo de subtítulos</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {CAPTION_STYLES.map((s) => {
                const active = captionStyle === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setCaptionStyle(s.id)}
                    data-testid={`caption-style-${s.id}`}
                    style={{
                      padding: '8px 10px',
                      textAlign: 'left',
                      borderRadius: 10,
                      background: active ? 'var(--accent-bg)' : 'rgba(255,255,255,0.04)',
                      boxShadow: active
                        ? 'inset 0 0.5px 0 rgba(255,255,255,0.15), 0 0 0 0.5px rgba(232, 201, 109,0.40)'
                        : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.label}</div>
                    <div className="caption" style={{ fontSize: 10 }}>{s.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setBurnSubs(!burnSubs)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: 12,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: burnSubs ? 'var(--accent-bg)' : 'rgba(255,255,255,0.04)',
              boxShadow: burnSubs
                ? '0 0 0 0.5px rgba(232, 201, 109,0.40)'
                : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
            }}
          >
            <span className={'toggle' + (burnSubs ? ' on' : '')} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>Quemar subtítulos en el MP4</div>
              <div className="caption">El karaoke se imprime sobre el vídeo. Desactiva si solo quieres el corte.</div>
            </div>
          </button>

          <button
            onClick={run}
            data-testid="shorts-run"
            disabled={busy || !videoPath}
            className="btn-primary large"
            style={{ justifyContent: 'center', width: '100%' }}
          >
            {busy ? <CircleNotch size={13} className="pulse" /> : <Sparkle size={13} />}
            {busy ? progress || 'Procesando…' : `Extraer ${nShorts} Shorts`}
          </button>

          {error && (
            <div
              data-testid="shorts-error"
              style={{ padding: 12, borderRadius: 10, background: 'var(--red-bg)', boxShadow: '0 0 0 0.5px rgba(200,82,94,0.45)', fontSize: 12, display: 'flex', gap: 8 }}
            >
              <Warning size={15} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}
        </section>

        <aside className="group" style={{ padding: 18 }}>
          <h3 className="title" style={{ marginBottom: 10 }}>
            <Scissors size={15} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--gold-soft)' }} />
            Cómo funciona
          </h3>
          <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <li>Whisper-large-v3 transcribe con timestamps por palabra.</li>
            <li>Palabras agrupadas en frases por silencios &gt;0.4 s.</li>
            <li>El LLM puntúa 12 candidatos: hook · climax · standalone.</li>
            <li>Top {nShorts} sin solapamiento.</li>
            <li>FFmpeg corta + crop 9:16 + loudnorm -14 LUFS + NVENC p7.</li>
            <li>Karaoke ASS quemado con safe zones TikTok.</li>
          </ol>
          <div className="hr" style={{ margin: '12px 0' }} />
          <p className="caption">⏱️ ~1-2× la duración del vídeo en RTX 4060 8 GB.</p>
        </aside>
      </div>

      {results && results.length > 0 && (
        <section data-testid="shorts-results" style={{ marginTop: 22 }}>
          <h2 className="section-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle size={20} weight="fill" style={{ color: 'var(--green)' }} />
            {results.length} Shorts generados
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 16 }}>
            {results.map((s, i) => (
              <ShortResultCard key={s.output_path} short={s} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ShortResultCard({ short, index }: { short: ShortInfo; index: number }) {
  const [hover, setHover] = useState(false);
  const total = (0.4 * short.hook_score + 0.4 * short.climax_score + 0.2 * short.standalone_score) * 100;
  return (
    <article
      className="group"
      style={{ overflow: 'hidden' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ position: 'relative', aspectRatio: '9/16', background: 'rgba(0,0,0,0.5)' }}>
        <video
          src={convertFileSrc(short.output_path)}
          muted
          loop
          playsInline
          autoPlay={hover}
          preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {!hover && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}>
            <Play size={42} weight="fill" style={{ color: 'var(--gold-soft)' }} />
          </div>
        )}
        <span className="mono" style={{ position: 'absolute', top: 8, left: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.75)', color: 'var(--gold-soft)', fontSize: 11 }}>
          #{index + 1}
        </span>
        <span style={{ position: 'absolute', top: 8, right: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(212, 184, 90,0.30)', boxShadow: '0 0 0 0.5px rgba(232, 201, 109,0.50)', color: 'var(--accent-soft)', fontSize: 11, fontWeight: 700 }}>
          {total.toFixed(0)}/100
        </span>
        <span className="mono" style={{ position: 'absolute', bottom: 8, right: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.75)', color: 'var(--text-secondary)', fontSize: 10 }}>
          {Math.round(short.duration_seconds)}s
        </span>
      </div>
      <div style={{ padding: 12 }}>
        <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as CSSProperties} title={short.text_preview}>
          {short.text_preview}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
          <ScoreBar label="Hook" value={short.hook_score} />
          <ScoreBar label="Climax" value={short.climax_score} />
          <ScoreBar label="Solo" value={short.standalone_score} />
        </div>
      </div>
    </article>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)' }}>
        <span>{label}</span>
        <span className="mono">{pct}</span>
      </div>
      <div style={{ height: 3, borderRadius: 999, background: 'rgba(0,0,0,0.4)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 200ms' }} />
      </div>
    </div>
  );
}
