/**
 * Originality Gate component (v0.12.3) — modal standalone para el flujo
 * anti-templating + EU AI Act Article 50 compliance.
 *
 * Backend: routes/originality.py (v0.10.0) + Tauri commands (v0.12.0).
 *
 * Cómo se usa (standalone, NO integrado al pipeline core todavía —
 * v0.12.4 lo integrará automáticamente entre Planner y Script):
 *
 *   <OriginalityGate
 *     projectId="proj_xyz"
 *     topic="Caída del Imperio Romano"
 *     scriptText={fullScript}
 *     chapters={chapterTitles}
 *     previousScripts={previousFromDb}
 *     primaryLanguage="es"
 *     onApproved={(manifest) => { ... continúa el render ... }}
 *     onCancel={() => { ... }}
 *   />
 *
 * Flujo:
 *   1. Pide check_structural al backend → muestra warnings + score.
 *   2. Si score < blocking_threshold y user no aporta thesis → modo
 *      "permissive" (sugerencia, no bloqueo).
 *   3. Si score ≥ blocking → modo "blocking", exige thesis + elegir
 *      uno de 3 hooks alternativos + 1 edit del outline antes de
 *      permitir continuar.
 *   4. Cuando el usuario completa los gates, llama build_manifest.
 *   5. Devuelve el OriginalityManifest al caller, que lo persistirá
 *      junto al proyecto (v0.12.4 cableará esto al pipeline).
 */
import { useEffect, useState } from 'react';
import {
  ShieldCheck, Warning, X, CircleNotch, Quotes, Lightbulb,
  CheckCircle, Sparkle,
} from '@phosphor-icons/react';
import {
  tauri,
  type StructuralCheckResponse,
  type StructuralWarning,
  type HookAlternative,
  type OriginalityManifest,
  type PreviousScript,
  type ManifestSource,
} from '@/lib/tauri';

export interface OriginalityGateProps {
  projectId: string;
  topic: string;
  scriptText: string;
  chapters?: string[];
  previousScripts: PreviousScript[];
  primaryLanguage: string;
  /** Fuentes extraídas del RAG (Wikipedia, etc.) que ya tiene el caller. */
  sources?: ManifestSource[];
  /** Llamado cuando user completa el gate con éxito. */
  onApproved: (manifest: OriginalityManifest) => void;
  /** Llamado si user cancela (back / X). */
  onCancel: () => void;
}

type Stage = 'checking' | 'review' | 'building' | 'done' | 'error';

export function OriginalityGate(props: OriginalityGateProps) {
  const {
    projectId,
    topic,
    scriptText,
    chapters,
    previousScripts,
    primaryLanguage,
    sources = [],
    onApproved,
    onCancel,
  } = props;

  const [stage, setStage] = useState<Stage>('checking');
  const [check, setCheck] = useState<StructuralCheckResponse | null>(null);
  const [hookAlts, setHookAlts] = useState<HookAlternative[] | null>(null);
  const [hookLoading, setHookLoading] = useState(false);
  const [chosenHook, setChosenHook] = useState<string>('');
  const [thesis, setThesis] = useState<string>('');
  const [edit, setEdit] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // 1. Initial check on mount.
  useEffect(() => {
    let cancelled = false;
    setStage('checking');
    tauri
      .originalityCheckStructural({
        projectId,
        scriptText,
        chapters,
        previousScripts,
      })
      .then((c) => {
        if (cancelled) return;
        setCheck(c);
        setStage('review');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Comprobación estructural falló: ${e}`);
        setStage('error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, scriptText, chapters, previousScripts]);

  const loadHooks = async () => {
    setHookLoading(true);
    setError(null);
    try {
      const r = await tauri.originalityHookAlternatives({
        topic,
        outline: chapters?.join(' · '),
        primaryLanguage,
        nAlternatives: 3,
      });
      setHookAlts(r.alternatives);
    } catch (e) {
      setError(`Generación de hooks falló: ${e}`);
    } finally {
      setHookLoading(false);
    }
  };

  const recommended = check?.recommended_status ?? 'approved';
  const isBlocking = recommended === 'rejected';
  const needsReview = recommended === 'pending' || isBlocking;

  // Validación local: si recommended=rejected o pending, exigimos
  // thesis≥20 chars + hookChosen + edit. Si approved, basta confirm.
  const canContinue =
    !needsReview ||
    (thesis.trim().length >= 20 &&
      chosenHook.trim().length >= 10 &&
      edit.trim().length >= 5);

  const buildAndApprove = async () => {
    setStage('building');
    setError(null);
    try {
      const manifest = await tauri.originalityBuildManifest({
        projectId,
        topic,
        thesisUser: thesis.trim() || `Sin tesis personal (similarity ${((check?.score ?? 0) * 100).toFixed(0)}%, aprobado automáticamente).`,
        hookChosen:
          chosenHook.trim() ||
          `(uso del hook generado por el planner; similarity bajo, no se solicitó alternativa)`,
        sources,
        humanEdits: edit.trim() ? [edit.trim()] : [],
      });
      setStage('done');
      onApproved(manifest);
    } catch (e) {
      setError(`Build manifest falló: ${e}`);
      setStage('error');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div
        className="glass"
        style={{
          width: '100%',
          maxWidth: 720,
          maxHeight: '88vh',
          overflow: 'auto',
          padding: 'var(--space-6)',
        }}
      >
        {/* ─── Header ──────────────────────────────────────────────── */}
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
          }}
        >
          <ShieldCheck
            size={24}
            weight="duotone"
            style={{ color: '#e8c96d', flexShrink: 0, marginTop: 2 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: '17px',
                fontWeight: 700,
                color: 'var(--xs-text-1)',
              }}
            >
              Comprobación de originalidad
            </h2>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: '12px',
                color: 'var(--xs-text-2)',
                lineHeight: 1.4,
              }}
            >
              Detecta templating estructural frente a vídeos previos del canal y
              cumple con EU AI Act Article 50 (enforcement 2 ago 2026) +
              política YouTube «inauthentic content».
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancelar"
            className="btn-icon"
            style={{ flexShrink: 0 }}
          >
            <X size={18} />
          </button>
        </header>

        {stage === 'checking' && (
          <div
            style={{
              padding: 'var(--space-6)',
              textAlign: 'center',
              color: 'var(--xs-text-2)',
            }}
          >
            <CircleNotch
              size={28}
              className="spin"
              style={{ marginBottom: 'var(--space-2)' }}
            />
            <p style={{ margin: 0, fontSize: '13px' }}>
              Analizando similitud estructural con tus vídeos previos…
            </p>
          </div>
        )}

        {stage === 'review' && check && (
          <>
            {/* ─── Score + warnings ─────────────────────────────────── */}
            <ScoreBlock check={check} />

            {check.warnings.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  marginBottom: 'var(--space-4)',
                }}
              >
                {check.warnings.map((w, i) => (
                  <WarningRow key={i} warning={w} />
                ))}
              </div>
            )}

            {/* ─── Gate de aportación humana ────────────────────────── */}
            {needsReview && (
              <section
                style={{
                  marginTop: 'var(--space-4)',
                  padding: 'var(--space-4)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'rgba(232, 201, 109, 0.06)',
                  border: '1px solid rgba(232, 201, 109, 0.18)',
                }}
              >
                <h3
                  style={{
                    margin: '0 0 var(--space-3) 0',
                    fontSize: '13px',
                    color: '#e8c96d',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {isBlocking ? 'Aportación humana obligatoria' : 'Aportación humana recomendada'}
                </h3>

                {/* Tesis personal */}
                <label style={fieldLabel}>
                  <span>
                    1. Tu ángulo personal sobre el tema{' '}
                    <span style={{ color: 'var(--xs-text-3)' }}>(mín. 20 caracteres)</span>
                  </span>
                  <textarea
                    value={thesis}
                    onChange={(e) => setThesis(e.target.value)}
                    rows={3}
                    placeholder="Ej: «Lo que ningún historiador cuenta sobre la caída es que…»"
                    className="input"
                    style={{
                      padding: 'var(--space-3)',
                      fontSize: '13px',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                    }}
                  />
                  <span
                    style={{
                      fontSize: '11px',
                      color:
                        thesis.trim().length >= 20
                          ? 'var(--xs-text-3)'
                          : '#e88c8c',
                    }}
                  >
                    {thesis.trim().length} / 20
                  </span>
                </label>

                {/* Hook alternatives */}
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      marginBottom: 'var(--space-2)',
                    }}
                  >
                    <span style={fieldLabelText}>
                      2. Elige tu hook entre 3 alternativas
                    </span>
                    {!hookAlts && (
                      <button
                        type="button"
                        onClick={loadHooks}
                        disabled={hookLoading}
                        className="btn"
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                      >
                        {hookLoading ? (
                          <>
                            <CircleNotch size={12} className="spin" /> Generando…
                          </>
                        ) : (
                          <>
                            <Sparkle size={12} /> Generar hooks
                          </>
                        )}
                      </button>
                    )}
                  </div>
                  {hookAlts && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-2)',
                      }}
                    >
                      {hookAlts.map((h, i) => (
                        <HookRow
                          key={i}
                          alt={h}
                          checked={chosenHook === h.text}
                          onSelect={() => setChosenHook(h.text)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Edit del outline */}
                <label style={{ ...fieldLabel, marginTop: 'var(--space-4)' }}>
                  <span>
                    3. Un cambio que TÚ aplicaste al outline{' '}
                    <span style={{ color: 'var(--xs-text-3)' }}>(mín. 5 caracteres)</span>
                  </span>
                  <input
                    type="text"
                    value={edit}
                    onChange={(e) => setEdit(e.target.value)}
                    placeholder="Ej: «Cambié el orden de los capítulos 3 y 4 para abrir con el conflicto…»"
                    className="input"
                    style={{ padding: 'var(--space-3)', fontSize: '13px' }}
                  />
                </label>
              </section>
            )}

            {/* ─── Acciones ──────────────────────────────────────────── */}
            <footer
              style={{
                marginTop: 'var(--space-5)',
                display: 'flex',
                gap: 'var(--space-3)',
                justifyContent: 'flex-end',
              }}
            >
              <button type="button" className="btn" onClick={onCancel}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={buildAndApprove}
                disabled={!canContinue}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-4)',
                  fontSize: '13px',
                  fontWeight: 600,
                  opacity: canContinue ? 1 : 0.45,
                }}
              >
                <CheckCircle size={16} weight="bold" />
                {needsReview ? 'Aprobar y continuar' : 'Continuar (sin warnings)'}
              </button>
            </footer>
          </>
        )}

        {stage === 'building' && (
          <div
            style={{
              padding: 'var(--space-6)',
              textAlign: 'center',
              color: 'var(--xs-text-2)',
            }}
          >
            <CircleNotch
              size={28}
              className="spin"
              style={{ marginBottom: 'var(--space-2)' }}
            />
            <p style={{ margin: 0, fontSize: '13px' }}>
              Construyendo Originality Manifest…
            </p>
          </div>
        )}

        {stage === 'error' && (
          <div
            role="alert"
            style={{
              padding: 'var(--space-4)',
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
            <div>
              <strong>Error</strong>
              <div style={{ marginTop: 4, fontFamily: 'var(--xs-font-mono)' }}>{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subcomponentes ─────────────────────────────────────────────────

const fieldLabelText = {
  fontSize: '12px',
  color: 'var(--xs-text-2)',
  fontWeight: 500,
};

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-1)',
  fontSize: '12px',
  color: 'var(--xs-text-2)',
};

function ScoreBlock({ check }: { check: StructuralCheckResponse }) {
  const score = check.score;
  const pct = (score * 100).toFixed(0);
  const tone: { bg: string; color: string; label: string } =
    check.recommended_status === 'rejected'
      ? { bg: 'rgba(220, 80, 80, 0.12)', color: '#e87878', label: 'Bloqueante' }
      : check.recommended_status === 'pending'
        ? { bg: 'rgba(232, 201, 109, 0.10)', color: '#e8c96d', label: 'Aviso' }
        : { bg: 'rgba(120, 200, 120, 0.10)', color: '#88c878', label: 'OK' };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-lg)',
        background: tone.bg,
        marginBottom: 'var(--space-4)',
      }}
    >
      <div
        style={{
          fontSize: '34px',
          fontWeight: 700,
          fontFamily: 'var(--xs-font-display)',
          color: tone.color,
          lineHeight: 1,
        }}
      >
        {pct}%
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '11px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: tone.color,
            marginBottom: 4,
          }}
        >
          {tone.label} · {check.recommended_status}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--xs-text-2)' }}>
          Similitud con vídeo previo más parecido del canal{' '}
          {check.most_similar_project_id && (
            <span style={{ fontFamily: 'var(--xs-font-mono)' }}>
              ({check.most_similar_project_id.slice(0, 8)}…)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function WarningRow({ warning }: { warning: StructuralWarning }) {
  const tone =
    warning.severity === 'blocking'
      ? { color: '#e87878', bg: 'rgba(220, 80, 80, 0.10)' }
      : warning.severity === 'warning'
        ? { color: '#e8c96d', bg: 'rgba(232, 201, 109, 0.08)' }
        : { color: 'var(--xs-text-2)', bg: 'rgba(255, 255, 255, 0.03)' };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: tone.bg,
        fontSize: '12px',
      }}
    >
      <Warning
        size={14}
        weight={warning.severity === 'blocking' ? 'fill' : 'regular'}
        style={{ color: tone.color, flexShrink: 0, marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: tone.color,
            fontWeight: 600,
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 2,
          }}
        >
          {warning.code}
        </div>
        <div style={{ color: 'var(--xs-text-1)', lineHeight: 1.4 }}>{warning.detail}</div>
      </div>
    </div>
  );
}

function HookRow({
  alt,
  checked,
  onSelect,
}: {
  alt: HookAlternative;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: 'left',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: checked
          ? 'rgba(232, 201, 109, 0.12)'
          : 'rgba(255, 255, 255, 0.03)',
        border: checked
          ? '1px solid rgba(232, 201, 109, 0.40)'
          : '1px solid rgba(255, 255, 255, 0.06)',
        cursor: 'pointer',
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: checked
            ? '4px solid #e8c96d'
            : '2px solid rgba(255, 255, 255, 0.20)',
          flexShrink: 0,
          marginTop: 4,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '11px',
            color: '#e8c96d',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 700,
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Lightbulb size={11} /> {alt.kind}
        </div>
        <div
          style={{
            fontSize: '14px',
            fontWeight: 500,
            color: 'var(--xs-text-1)',
            lineHeight: 1.35,
            marginBottom: 4,
            display: 'flex',
            gap: 4,
          }}
        >
          <Quotes size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{alt.text}</span>
        </div>
        {alt.rationale && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--xs-text-2)',
              fontStyle: 'italic',
              lineHeight: 1.4,
            }}
          >
            {alt.rationale}
          </div>
        )}
      </div>
    </button>
  );
}
