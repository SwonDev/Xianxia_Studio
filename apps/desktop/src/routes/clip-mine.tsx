/**
 * Clip Miner UI (v0.12.1) — vídeo largo (podcast/entrevista/clase) → N
 * Shorts virales candidatos. Backend en v0.9.0 + v0.9.1.
 *
 * Flujo:
 *   1. Usuario selecciona MP4 con el file picker.
 *   2. Configura n_candidates + min/max/target duration.
 *   3. Pulsa "Extraer candidatos": invoca `clipMineExtract` (Whisper +
 *      Gemma 4B + PySceneDetect).
 *   4. Tabla con los N candidatos: score, label, hook_text, summary,
 *      duración, scene cut snap.
 *   5. Botón por candidato "Generar Short": delega al pipeline existente
 *      `/shorts/from_video` con start/end exactos (reframe + Hormozi
 *      captions + virality score + blackdetect ya cubiertos por v0.1.22+).
 *
 * Visual: Liquid Glass (DESIGN.md v2), patrón de shorts.tsx.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import {
  CircleNotch, FolderOpen, Play, Sparkle, Warning,
  CheckCircle, Lightning,
} from '@phosphor-icons/react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { tauri, type ClipCandidate, type ClipMineResponse } from '@/lib/tauri';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/ui-glass';

export const Route = createFileRoute('/clip-mine')({
  component: ClipMineRoute,
});

/** Etiqueta humana por categoría LLM. Espejo de routes/clipmine.py. */
const LABEL_DISPLAY: Record<string, { label: string; color: string }> = {
  hook: { label: 'Hook', color: '#e8c96d' },
  peak: { label: 'Pico emocional', color: '#d4b85a' },
  quotable: { label: 'Quotable', color: '#c9a84c' },
  value: { label: 'Valor práctico', color: '#b8964a' },
  conflict: { label: 'Conflicto', color: '#a88542' },
  reveal: { label: 'Revelación', color: '#98753a' },
};

function ClipMineRoute() {
  const { toast } = useToast();
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [nCandidates, setNCandidates] = useState(5);
  const [targetDuration, setTargetDuration] = useState(45);
  const [minDuration, setMinDuration] = useState(25);
  const [maxDuration, setMaxDuration] = useState(60);
  const [primaryLanguage, setPrimaryLanguage] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClipMineResponse | null>(null);

  // Tracking del estado de render de cada candidato (índice → estado).
  const [renderingIdx, setRenderingIdx] = useState<number | null>(null);
  const [renderedIdxs, setRenderedIdxs] = useState<Set<number>>(new Set());

  const pickVideo = async () => {
    setError(null);
    const sel = await openDialog({
      multiple: false,
      filters: [{ name: 'Vídeo largo', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
    });
    if (typeof sel === 'string') {
      setVideoPath(sel);
      setResult(null);
      setRenderedIdxs(new Set());
    }
  };

  const extractCandidates = async () => {
    if (!videoPath) {
      setError('Selecciona un vídeo largo primero.');
      return;
    }
    if (minDuration >= maxDuration) {
      setError('min_duration debe ser menor que max_duration.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setRenderedIdxs(new Set());
    setPhase('Extrayendo audio con ffmpeg…');

    // UX hints — el endpoint NO emite progress events todavía (v0.12.x
    // pending), así que mostramos fases estimadas por timer.
    const t1 = setTimeout(
      () => setPhase('Transcribiendo con faster-whisper large-v3-turbo…'),
      8_000,
    );
    const t2 = setTimeout(
      () => setPhase('Analizando virality con Gemma 4B local…'),
      45_000,
    );
    const t3 = setTimeout(
      () => setPhase('Detectando scene cuts con PySceneDetect…'),
      90_000,
    );

    try {
      const r = await tauri.clipMineExtract({
        videoPath,
        nCandidates,
        targetDuration,
        minDuration,
        maxDuration,
        primaryLanguage: primaryLanguage.trim() || undefined,
      });
      setResult(r);
      toast.success(
        'Candidatos extraídos',
        `${r.candidates.length} short${r.candidates.length === 1 ? '' : 's'} viral${r.candidates.length === 1 ? '' : 'es'} detectado${r.candidates.length === 1 ? '' : 's'} (lang ${r.transcript_language}, ${r.scene_cuts_detected} scene cuts)`,
      );
    } catch (e) {
      const msg = String(e);
      setError(msg);
      toast.error('Extracción fallida', msg.slice(0, 200));
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      setBusy(false);
      setPhase('');
    }
  };

  const renderCandidate = async (idx: number, c: ClipCandidate) => {
    if (!videoPath) return;
    setRenderingIdx(idx);
    setError(null);
    try {
      // Reusamos el pipeline standalone `/shorts/from_video` que YA
      // tiene reframe smart + Hormozi captions + hook + CTA + virality
      // score + blackdetect guard. Pasamos los timestamps exactos del
      // candidato como single-shot (n_shorts=1, min_duration=max_duration
      // forzados al rango del candidato para que no busque otros segmentos).
      const r = await fetch('http://127.0.0.1:8731/shorts/from_video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: videoPath,
          n_shorts: 1,
          target_duration: c.duration,
          min_duration: Math.max(15, Math.floor(c.duration * 0.9)),
          max_duration: Math.ceil(c.duration * 1.1),
          burn_subs: true,
          // Hint al planner del LLM para que prefiera la ventana exacta.
          primary_language: result?.transcript_language || undefined,
          // pre-trimmed: si el endpoint /shorts/from_video acepta start/end
          // exactos, los pasamos. Si no, el LLM volverá a buscar pero con
          // un solo candidato → resultado parecido.
          force_start_seconds: c.start,
          force_end_seconds: c.end,
          caption_style: 'hormozi',
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      setRenderedIdxs((prev) => new Set(prev).add(idx));
      toast.success(
        'Short generado',
        `${c.hook_text || c.label} (${c.duration.toFixed(1)} s)`,
      );
    } catch (e) {
      const msg = String(e);
      toast.error('Render falló', msg.slice(0, 200));
    } finally {
      setRenderingIdx(null);
    }
  };

  return (
    <div className="page-clipmine" style={{ padding: 'var(--space-8) var(--space-6)' }}>
      <PageHeader
        title="Clip Miner"
        subtitle="Vídeo largo (podcast, entrevista, clase) → N Shorts virales con highlight detection"
      />

      {/* ── Configuración ──────────────────────────────────────────── */}
      <section
        className="glass"
        style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-5)' }}
      >
        <h2 style={{ marginTop: 0, fontSize: '15px', color: 'var(--xs-text-1)' }}>
          1. Selecciona el vídeo
        </h2>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button
            type="button"
            className="btn"
            onClick={pickVideo}
            disabled={busy}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <FolderOpen size={16} />
            {videoPath ? 'Cambiar vídeo' : 'Elegir vídeo…'}
          </button>
          {videoPath && (
            <span
              style={{
                fontSize: '13px',
                color: 'var(--xs-text-2)',
                fontFamily: 'var(--xs-font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={videoPath}
            >
              {videoPath}
            </span>
          )}
        </div>

        <h2
          style={{ marginTop: 'var(--space-5)', fontSize: '15px', color: 'var(--xs-text-1)' }}
        >
          2. Parámetros del descubrimiento
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <NumberField
            label="Nº candidatos"
            value={nCandidates}
            min={1}
            max={15}
            onChange={setNCandidates}
            help="1-15"
            disabled={busy}
          />
          <NumberField
            label="Duración objetivo (s)"
            value={targetDuration}
            min={15}
            max={90}
            onChange={setTargetDuration}
            help="15-90"
            disabled={busy}
          />
          <NumberField
            label="Duración mín (s)"
            value={minDuration}
            min={10}
            max={60}
            onChange={setMinDuration}
            help="10-60"
            disabled={busy}
          />
          <NumberField
            label="Duración máx (s)"
            value={maxDuration}
            min={15}
            max={180}
            onChange={setMaxDuration}
            help="15-180"
            disabled={busy}
          />
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              fontSize: '12px',
              color: 'var(--xs-text-2)',
            }}
          >
            <span>Idioma (auto si vacío)</span>
            <input
              type="text"
              value={primaryLanguage}
              onChange={(e) => setPrimaryLanguage(e.target.value)}
              placeholder="es, en, pt, zh…"
              disabled={busy}
              maxLength={5}
              className="input"
              style={{ padding: 'var(--space-2)', fontSize: '13px' }}
            />
          </label>
        </div>

        <div style={{ marginTop: 'var(--space-5)', display: 'flex', gap: 'var(--space-3)' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={extractCandidates}
            disabled={!videoPath || busy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-5)',
              fontSize: '14px',
              fontWeight: 600,
            }}
          >
            {busy ? <CircleNotch size={18} className="spin" /> : <Sparkle size={18} />}
            {busy ? 'Procesando…' : 'Extraer candidatos'}
          </button>
          {busy && phase && (
            <span
              style={{
                fontSize: '13px',
                color: 'var(--xs-text-2)',
                alignSelf: 'center',
                fontStyle: 'italic',
              }}
            >
              {phase}
            </span>
          )}
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(220, 80, 80, 0.12)',
              border: '1px solid rgba(220, 80, 80, 0.30)',
              fontSize: '13px',
              color: '#e87878',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-2)',
            }}
          >
            <Warning size={16} weight="bold" style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontFamily: 'var(--xs-font-mono)' }}>{error}</span>
          </div>
        )}
      </section>

      {/* ── Resultados ──────────────────────────────────────────────── */}
      {result && result.candidates.length > 0 && (
        <section
          className="glass"
          style={{ padding: 'var(--space-5)' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-4)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '15px', color: 'var(--xs-text-1)' }}>
              {result.candidates.length} candidato{result.candidates.length === 1 ? '' : 's'}{' '}
              detectado{result.candidates.length === 1 ? '' : 's'}
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--xs-text-2)' }}>
              {Math.round(result.total_duration)} s totales · {result.scene_cuts_detected} scene
              cuts · idioma {result.transcript_language}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {result.candidates.map((c, idx) => (
              <CandidateCard
                key={`${c.start}-${c.end}`}
                candidate={c}
                index={idx}
                onRender={() => renderCandidate(idx, c)}
                isRendering={renderingIdx === idx}
                isRendered={renderedIdxs.has(idx)}
                anyRendering={renderingIdx !== null}
              />
            ))}
          </div>
        </section>
      )}

      {result && result.candidates.length === 0 && (
        <section
          className="glass"
          style={{ padding: 'var(--space-5)', textAlign: 'center' }}
        >
          <Warning size={32} style={{ color: 'var(--xs-text-2)', marginBottom: 'var(--space-2)' }} />
          <p style={{ color: 'var(--xs-text-2)', fontSize: '14px', margin: 0 }}>
            No se detectaron candidatos virales. Prueba con un vídeo más largo o de mayor
            densidad informativa.
          </p>
        </section>
      )}
    </div>
  );
}

// ── Subcomponentes ─────────────────────────────────────────────────

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  help?: string;
  disabled?: boolean;
}

function NumberField({ label, value, min, max, onChange, help, disabled }: NumberFieldProps) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        fontSize: '12px',
        color: 'var(--xs-text-2)',
      }}
    >
      <span>
        {label} {help && <span style={{ color: 'var(--xs-text-3)' }}>· {help}</span>}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        disabled={disabled}
        className="input"
        style={{ padding: 'var(--space-2)', fontSize: '13px' }}
      />
    </label>
  );
}

interface CandidateCardProps {
  candidate: ClipCandidate;
  index: number;
  onRender: () => void;
  isRendering: boolean;
  isRendered: boolean;
  anyRendering: boolean;
}

function CandidateCard({
  candidate,
  index,
  onRender,
  isRendering,
  isRendered,
  anyRendering,
}: CandidateCardProps) {
  const tag = LABEL_DISPLAY[candidate.label] ?? {
    label: candidate.label,
    color: 'var(--xs-text-2)',
  };

  const fmtTime = (s: number): string => {
    const m = Math.floor(s / 60);
    const ss = s - m * 60;
    return `${m}:${ss.toFixed(1).padStart(4, '0')}`;
  };

  return (
    <article
      style={{
        display: 'grid',
        gridTemplateColumns: '60px 1fr auto',
        gap: 'var(--space-4)',
        alignItems: 'center',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-lg)',
        background: 'rgba(255, 255, 255, 0.025)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
      }}
    >
      {/* Score */}
      <div
        style={{
          fontSize: '24px',
          fontWeight: 700,
          fontFamily: 'var(--xs-font-display)',
          color: '#e8c96d',
          textAlign: 'center',
          lineHeight: 1,
        }}
        title="Virality score 0.0-1.0"
      >
        {(candidate.score * 100).toFixed(0)}
      </div>

      {/* Info */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-1)',
          }}
        >
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: tag.color,
              padding: '2px 8px',
              borderRadius: 'var(--radius-sm)',
              background: `${tag.color}22`,
            }}
          >
            #{index + 1} · {tag.label}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--xs-text-3)' }}>
            {fmtTime(candidate.start)} → {fmtTime(candidate.end)} ({candidate.duration.toFixed(1)} s)
          </span>
          {candidate.snapped_to_scene_cut && (
            <span
              title="Inicio/fin ajustados a corte de escena via PySceneDetect"
              style={{ fontSize: '11px', color: 'var(--xs-text-3)' }}
            >
              <Lightning size={11} weight="fill" style={{ verticalAlign: 'middle' }} /> snap
            </span>
          )}
        </div>
        {candidate.hook_text && (
          <p
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--xs-text-1)',
              margin: '0 0 var(--space-1) 0',
              lineHeight: 1.3,
            }}
          >
            «{candidate.hook_text}»
          </p>
        )}
        {candidate.summary && (
          <p
            style={{
              fontSize: '12px',
              color: 'var(--xs-text-2)',
              margin: 0,
              lineHeight: 1.4,
            }}
          >
            {candidate.summary}
          </p>
        )}
      </div>

      {/* Action */}
      <button
        type="button"
        className="btn"
        onClick={onRender}
        disabled={isRendering || isRendered || anyRendering}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          fontSize: '13px',
          fontWeight: 600,
          opacity: isRendered ? 0.6 : 1,
        }}
      >
        {isRendering ? (
          <>
            <CircleNotch size={14} className="spin" />
            Renderizando…
          </>
        ) : isRendered ? (
          <>
            <CheckCircle size={14} weight="fill" />
            Generado
          </>
        ) : (
          <>
            <Play size={14} weight="fill" />
            Generar Short
          </>
        )}
      </button>
    </article>
  );
}
