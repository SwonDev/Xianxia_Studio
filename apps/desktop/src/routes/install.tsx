import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle, DownloadSimple, Warning, Cpu, Lightning, HardDrives,
  MagnifyingGlass, XCircle, type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { tauri, events, type InstallProgress, type DetectedTool } from '@/lib/tauri';
import { formatBytes } from '@/lib/utils';
import { PageHeader } from '@/components/ui-glass';

export const Route = createFileRoute('/install')({
  component: InstallWizard,
});

type Step = 'welcome' | 'detect' | 'hardware' | 'plan' | 'installing' | 'done';

function InstallWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('welcome');
  const { data: hw } = useQuery({ queryKey: ['hardware'], queryFn: tauri.detectHardware });
  const { data: detection, refetch: refetchDetection } = useQuery({
    queryKey: ['detection'],
    queryFn: tauri.detectInstalledTools,
  });
  const { data: workspace } = useQuery({
    queryKey: ['workspace'],
    queryFn: tauri.getWorkspaceRoot,
  });

  const installOptions = hw && {
    llm_hf_repo: hw.recommendation.llm_hf_repo,
    llm_gguf_file: hw.recommendation.llm_gguf_file,
    llm_label: hw.recommendation.llm_label,
    llm_abliterated: hw.recommendation.llm_abliterated,
    llm_size_bytes: Math.round(hw.recommendation.estimated_download_gb * 1024 * 1024 * 1024 * 0.5),
    workspace_root: workspace ?? null,
  };

  const { data: manifest } = useQuery({
    queryKey: ['install-manifest', installOptions],
    queryFn: () => tauri.getInstallManifest(installOptions!),
    enabled: !!installOptions,
  });

  const totalBytes = (manifest ?? []).reduce((sum, c) => sum + c.size_bytes, 0);

  return (
    <div className="route-enter page">
      <PageHeader
        title="Bienvenido al cultivo"
        subtitle="Xianxia Studio descargará e instalará automáticamente todos los componentes necesarios. Una sola vez."
      />

      <Stepper step={step} />

      <AnimatePresence mode="wait">
        {step === 'welcome' && (
          <Pane key="welcome">
            <h2 className="section-header">¿Qué se va a instalar?</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Stack completo, todo local, todo autoinstalable. Tamaño total ≈{' '}
              <strong style={{ color: 'var(--gold-soft)' }}>25–30 GB</strong> según tu GPU.
            </p>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0, fontSize: 12.5 }}>
              <Item icon="🐍" text="Python 3.11 embebido + libs IA: torch+CUDA, diffusers, transformers, accelerate, qwen-tts, faster-whisper, mediapipe, rembg, opencv, ultralytics (~8–10 GB)" />
              <Item icon="📦" text="Node 22 portable + Fastify sidecar para HyperFrames (~120 MB)" />
              <Item icon="🎬" text="FFmpeg 8 con NVENC h264/hevc (~80 MB) — render Steadicam 60fps + loudnorm -14 LUFS" />
              <Item icon="🦙" text="llama.cpp llama-server (~110 MB) + supergemma4-e4b-abliterated GGUF Q4_K_M (~5.3 GB). Ollama opcional desde Ajustes." />
              <Item icon="🐉" text="Z-Image-Turbo Q4_K_M GGUF (~4.7 GB) + Qwen3-4B FP8 encoder + AE VAE (8 GB VRAM, sin offload)" />
              <Item icon="🎙️" text="Qwen3-TTS-12Hz-1.7B-CustomVoice (~3.5 GB) — 9 voces nativas multilenguaje" />
              <Item icon="✂️" text="ComfyUI + ComfyUI-GGUF + rgthree-comfy (~252 MB) — runtime de inferencia para Z-Image" />
              <Item icon="🎞️" text="HyperFrames CLI (~60 MB) — render HTML/CSS/GSAP a vídeo" />
              <Item icon="📐" text="rembg + onnxruntime-gpu + MediaPipe + YOLO11n-pose (~720 MB) — parallax 2.5D + tracking Shorts" />
              <Item icon="🔊" text="faster-whisper-large-v3 (~3 GB) — transcripción palabra-a-palabra para karaoke ASS" />
              <Item icon="🎵" text="MusicGen-medium (~3-4 GB, opcional, GPU-only). Sin él, /music usa la biblioteca local." />
            </ul>
            <div style={{ marginTop: 24, padding: 16, borderRadius: 12, background: 'rgba(212, 184, 90,0.10)', boxShadow: '0 0 0 0.5px rgba(232, 201, 109,0.25)', fontSize: 13 }}>
              <strong style={{ color: 'var(--accent-soft)' }}>Filosofía local-first:</strong> ningún
              archivo sale de tu máquina. La única conexión externa es YouTube cuando publicas.
            </div>
            <Actions onNext={() => setStep('detect')} nextLabel="Empezar la detección" />
          </Pane>
        )}

        {step === 'detect' && (
          <Pane key="detect">
            <h2 className="section-header">Auto-detección de tu sistema</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Si ya tienes alguna herramienta compatible, la reutilizamos y te ahorramos la descarga.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {detection ? (
                <>
                  <ToolRow tool={detection.python} />
                  <ToolRow tool={detection.node} />
                  <ToolRow tool={detection.ffmpeg} />
                  <ToolRow tool={detection.ollama} />
                  <ToolRow tool={detection.git} />
                </>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>Detectando…</p>
              )}
            </div>
            <button
              className="btn-ghost"
              onClick={() => refetchDetection()}
              style={{ marginBottom: 14, color: 'var(--gold-soft)' }}
            >
              <MagnifyingGlass size={13} />
              Re-escanear
            </button>
            <Actions onBack={() => setStep('welcome')} onNext={() => setStep('hardware')} nextLabel="Continuar" />
          </Pane>
        )}

        {step === 'hardware' && hw && (
          <Pane key="hardware">
            <h2 className="section-header">Tu hardware</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
              <Stat icon={Cpu} label="CPU" value={hw.cpu_brand} sub={`${hw.cpu_cores} cores físicos`} />
              <Stat icon={HardDrives} label="RAM" value={`${hw.total_ram_gb.toFixed(0)} GB`} sub={`${hw.available_ram_gb.toFixed(1)} disponibles`} />
              <Stat
                icon={Lightning}
                label="GPU"
                value={hw.gpu?.name ?? 'Sin GPU dedicada'}
                sub={hw.gpu?.vram_gb ? `${hw.gpu.vram_gb.toFixed(1)} GB VRAM` : 'usaremos CPU + RAM'}
              />
              <Stat icon={HardDrives} label="Disco libre" value={`${hw.free_disk_gb.toFixed(0)} GB`} sub="recomendado: 40 GB" />
            </div>
            <div className="group" style={{ padding: 22 }}>
              <p className="eyebrow" style={{ color: 'var(--gold-soft)', fontWeight: 600, marginBottom: 8 }}>
                Recomendación automática · Tier {hw.recommendation.tier}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginTop: 12 }}>
                <Reco label="LLM" value={hw.recommendation.llm_label} />
                <Reco label="Imagen" value={hw.recommendation.image} />
                <Reco label="Voz" value={hw.recommendation.tts} />
              </div>
              {hw.recommendation.llm_abliterated && (
                <p className="caption" style={{ marginTop: 12, lineHeight: 1.5 }}>
                  El modelo por defecto es <strong style={{ color: 'var(--gold-soft)' }}>abliterated</strong>:
                  sin filtros, mejor para temas oscuros del nicho xianxia. Cambiable desde Ajustes.
                </p>
              )}
              <p className="caption" style={{ marginTop: 14 }}>
                Descarga total estimada: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(totalBytes)}</strong>
              </p>
            </div>
            <Actions onBack={() => setStep('detect')} onNext={() => setStep('plan')} nextLabel="Continuar al plan" />
          </Pane>
        )}

        {step === 'plan' && manifest && (
          <Pane key="plan">
            <h2 className="section-header">Plan de instalación</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {manifest.map((c) => (
                <div
                  key={c.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)' }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{c.label}</div>
                    <div className="caption" style={{ textTransform: 'capitalize' }}>{c.category}</div>
                  </div>
                  <div className="mono" style={{ color: 'var(--text-secondary)' }}>{formatBytes(c.size_bytes)}</div>
                </div>
              ))}
            </div>
            <Actions
              onBack={() => setStep('hardware')}
              onNext={() => {
                if (!installOptions) return;
                setStep('installing');
                tauri.runInstall(installOptions);
              }}
              nextLabel="Comenzar instalación"
              nextIcon={DownloadSimple}
            />
          </Pane>
        )}

        {step === 'installing' && manifest && (
          <Pane key="installing">
            <h2 className="section-header">Instalando…</h2>
            <ProgressList
              components={manifest.map((c) => ({ id: c.id, label: c.label, size: c.size_bytes }))}
              onAllDone={() => setStep('done')}
            />
          </Pane>
        )}

        {step === 'done' && (
          <Pane key="done">
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <span className="lg-tile xl" style={{ '--tint': '#7fa8d8', margin: '0 auto 16px' } as CSSProperties}>
                <CheckCircle size={20} weight="fill" />
              </span>
              <h2 className="title-l" style={{ marginBottom: 8 }}>Instalación completada</h2>
              <p className="muted" style={{ maxWidth: 420, margin: '0 auto', fontSize: 13 }}>
                Xianxia Studio está listo. Puedes empezar a generar tu primer vídeo.
              </p>
              <button className="btn-primary large" style={{ marginTop: 24 }} onClick={() => navigate({ to: '/' })}>
                Ir al Resumen
              </button>
            </div>
          </Pane>
        )}
      </AnimatePresence>
    </div>
  );
}

function ProgressList({
  components,
  onAllDone,
}: {
  components: { id: string; label: string; size: number }[];
  onAllDone: () => void;
}) {
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    events.onInstallProgress((p) => setProgress((prev) => ({ ...prev, [p.component]: p }))).then((u) => (unlisten = u));
    events.onInstallDone(() => onAllDone()).then((u) => (unlistenDone = u));
    return () => {
      unlisten?.();
      unlistenDone?.();
    };
  }, [onAllDone]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {components.map((c) => {
        const p = progress[c.id];
        const status = p?.status ?? 'pending';
        const percent = p?.percent ?? 0;
        const barColor = status === 'failed' ? 'var(--red)' : status === 'done' ? 'var(--green)' : 'var(--accent)';
        return (
          <div key={c.id} style={{ padding: 14, borderRadius: 10, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
                {status === 'done' ? (
                  <CheckCircle size={15} weight="fill" style={{ color: 'var(--green)' }} />
                ) : status === 'failed' ? (
                  <Warning size={15} style={{ color: 'var(--red)' }} />
                ) : (
                  <DownloadSimple size={15} className={status !== 'pending' ? 'pulse' : ''} style={{ color: status !== 'pending' ? 'var(--gold-soft)' : 'var(--text-tertiary)' }} />
                )}
                {c.label}
              </div>
              <span className="mono" style={{ color: 'var(--text-secondary)' }}>{p?.message ?? formatBytes(c.size)}</span>
            </div>
            <div style={{ height: 4, borderRadius: 999, background: 'rgba(0,0,0,0.4)', overflow: 'hidden' }}>
              <motion.div
                style={{ height: '100%', background: barColor }}
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pane({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="group"
      style={{ padding: 28 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

function ToolRow({ tool }: { tool: DetectedTool }) {
  const ok = tool.installed && tool.compatible;
  const partial = tool.installed && !tool.compatible;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        fontSize: 13,
        background: 'rgba(255,255,255,0.04)',
        boxShadow: ok
          ? '0 0 0 0.5px rgba(127, 168, 216,0.35)'
          : partial
          ? '0 0 0 0.5px rgba(212,184,90,0.35)'
          : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
      }}
    >
      {ok ? (
        <CheckCircle size={15} weight="fill" style={{ color: 'var(--green)', flexShrink: 0 }} />
      ) : partial ? (
        <Warning size={15} style={{ color: 'var(--gold-soft)', flexShrink: 0 }} />
      ) : (
        <XCircle size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{tool.label}</div>
        <div className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tool.version ? <code className="mono">{tool.version}</code> : 'no detectado'}
          {tool.note ? ` · ${tool.note}` : ''}
        </div>
      </div>
      {tool.path && (
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }} title={tool.path}>
          {tool.path}
        </span>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: Step[] = ['welcome', 'detect', 'hardware', 'plan', 'installing', 'done'];
  const idx = steps.indexOf(step);
  return (
    <ol style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, listStyle: 'none', padding: 0 }}>
      {steps.map((s, i) => (
        <li key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 600,
              background: i < idx ? 'var(--green)' : i === idx ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
              color: i <= idx ? '#1a1a22' : 'var(--text-secondary)',
            }}
          >
            {i + 1}
          </span>
          {i < steps.length - 1 && <span style={{ width: 28, height: 1, background: 'var(--separator)' }} />}
        </li>
      ))}
    </ol>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: PhosphorIcon; label: string; value: string; sub: string }) {
  return (
    <div style={{ borderRadius: 10, background: 'rgba(255,255,255,0.04)', padding: 14 }}>
      <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icon size={13} style={{ color: 'var(--gold-soft)' }} />
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</div>
      <div className="caption" style={{ marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Reco({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function Item({ icon, text }: { icon: string; text: string }) {
  return (
    <li style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <span style={{ fontSize: 18, lineHeight: 1, marginTop: 2 }}>{icon}</span>
      <span style={{ lineHeight: 1.5, color: 'var(--text-secondary)' }}>{text}</span>
    </li>
  );
}

function Actions({
  onBack,
  onNext,
  nextLabel,
  nextIcon: NextIcon,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextIcon?: PhosphorIcon;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24, paddingTop: 18, borderTop: '0.5px solid var(--separator)' }}>
      {onBack && (
        <button className="btn" onClick={onBack}>
          Atrás
        </button>
      )}
      <button className="btn-primary large" onClick={onNext}>
        {NextIcon && <NextIcon size={13} />}
        {nextLabel}
      </button>
    </div>
  );
}
