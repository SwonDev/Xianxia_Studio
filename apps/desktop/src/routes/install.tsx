import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, AlertTriangle, Cpu, Zap, HardDrive, ScanSearch, XCircle } from 'lucide-react';
import { tauri, events, type InstallProgress, type DetectedTool } from '@/lib/tauri';
import { cn, formatBytes } from '@/lib/utils';

export const Route = createFileRoute('/install')({
  component: InstallWizard,
});

type Step = 'welcome' | 'detect' | 'hardware' | 'plan' | 'installing' | 'done';

function InstallWizard() {
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
  const totalRecommended = totalBytes;

  return (
    <div className="max-w-3xl mx-auto py-8">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
          Configuración inicial
        </p>
        <h1 className="font-display text-4xl font-medium">Bienvenido al cultivo</h1>
        <p className="text-paper-300 mt-3 max-w-2xl leading-relaxed">
          Antes de empezar, Xianxia Studio descargará e instalará automáticamente todos
          los componentes necesarios. Este proceso ocurre una sola vez.
        </p>
      </header>

      <Stepper step={step} />

      <AnimatePresence mode="wait">
        {step === 'welcome' && (
          <Pane key="welcome">
            <h2 className="font-display text-2xl mb-4">¿Qué se va a instalar?</h2>
            <p className="text-sm text-paper-300 mb-5">
              Stack completo, todo local, todo autoinstalable. Tamaño total ≈
              <strong className="text-gold-300"> 25–30 GB</strong> según tu GPU.
            </p>
            <ul className="space-y-2.5 text-sm text-paper-200">
              <Item icon="🐍" text="Python 3.11 embebido (~30 MB) + libs IA: torch+CUDA, diffusers, transformers, accelerate, qwen-tts, faster-whisper, mediapipe, rembg, opencv (~8–10 GB)" />
              <Item icon="📦" text="Node 22 portable + Fastify sidecar para HyperFrames (~120 MB)" />
              <Item icon="🎬" text="FFmpeg 8 con NVENC h264/hevc (~80 MB) — render + cinematic post-pass" />
              <Item icon="🦙" text="Ollama + xianxia-llm registrado desde supergemma4-e4b-abliterated GGUF Q4_K_M (~5.3 GB) — guion narrativo, modelo de la familia Gemma 4" />
              <Item icon="🐉" text="Z-Image-Turbo Q4_K_M GGUF (~4.7 GB) + Qwen3-4B FP8 encoder + AE VAE para ComfyUI — generación rápida en 8 GB VRAM (BF16 12 GB opcional para 12+ GB)" />
              <Item icon="🎙️" text="Qwen3-TTS-12Hz-1.7B-CustomVoice (~3.5 GB) — narración cinematográfica multilenguaje" />
              <Item icon="✂️" text="ComfyUI + custom node ComfyUI-GGUF (~250 MB) — runtime de inferencia para Z-Image" />
              <Item icon="🎞️" text="HyperFrames CLI (~60 MB) — render HTML/CSS/GSAP a vídeo" />
              <Item icon="📐" text="rembg + onnxruntime-gpu + MediaPipe (~700 MB) — segmentación de profundidad para parallax 2.5D y subject tracking para reframe vertical" />
              <Item icon="🔊" text="faster-whisper-large-v3 (~3 GB) — transcripción con timestamps por palabra" />
            </ul>
            <div className="mt-6 p-4 rounded-lg bg-jade-700/20 border border-jade-600/30 text-sm text-paper-200">
              <strong className="text-jade-300">Filosofía local-first:</strong> ningún
              archivo sale de tu máquina. La única conexión externa es YouTube cuando
              publicas. La descarga ahora es lo único online.
            </div>
            <Actions
              onNext={() => setStep('detect')}
              nextLabel="Empezar la detección"
            />
          </Pane>
        )}

        {step === 'detect' && (
          <Pane key="detect">
            <h2 className="font-display text-2xl mb-1">Auto-detección de tu sistema</h2>
            <p className="text-sm text-paper-300 mb-5">
              Si ya tienes alguna herramienta compatible instalada, la reutilizamos
              y te ahorramos la descarga.
            </p>

            <div className="space-y-2 mb-6">
              {detection ? (
                <>
                  <ToolRow tool={detection.python} />
                  <ToolRow tool={detection.node} />
                  <ToolRow tool={detection.ffmpeg} />
                  <ToolRow tool={detection.ollama} />
                  <ToolRow tool={detection.git} />
                </>
              ) : (
                <p className="text-sm text-paper-300">Detectando…</p>
              )}
            </div>

            <button
              onClick={() => refetchDetection()}
              className="text-xs text-gold-300 hover:text-gold-400 inline-flex items-center gap-1.5 mb-4"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              Re-escanear
            </button>

            <Actions
              onBack={() => setStep('welcome')}
              onNext={() => setStep('hardware')}
              nextLabel="Continuar"
            />
          </Pane>
        )}

        {step === 'hardware' && hw && (
          <Pane key="hardware">
            <h2 className="font-display text-2xl mb-4">Tu hardware</h2>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <Stat icon={Cpu} label="CPU" value={hw.cpu_brand} sub={`${hw.cpu_cores} cores físicos`} />
              <Stat icon={HardDrive} label="RAM" value={`${hw.total_ram_gb.toFixed(0)} GB`} sub={`${hw.available_ram_gb.toFixed(1)} disponibles`} />
              <Stat
                icon={Zap}
                label="GPU"
                value={hw.gpu?.name ?? 'Sin GPU dedicada'}
                sub={hw.gpu?.vram_gb ? `${hw.gpu.vram_gb.toFixed(1)} GB VRAM` : 'usaremos CPU + RAM'}
              />
              <Stat icon={HardDrive} label="Disco libre" value={`${hw.free_disk_gb.toFixed(0)} GB`} sub="espacio suficiente recomendado: 40 GB" />
            </div>

            <div className="rounded-xl border border-gold-500/30 bg-gradient-to-br from-obsidian-900 to-obsidian-800 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
                Recomendación automática · Tier {hw.recommendation.tier}
              </p>
              <div className="grid grid-cols-3 gap-4 mt-4 text-sm">
                <Reco label="LLM" value={hw.recommendation.llm_label} />
                <Reco label="Imagen" value={hw.recommendation.image} />
                <Reco label="Voz" value={hw.recommendation.tts} />
              </div>
              {hw.recommendation.llm_abliterated && (
                <p className="text-[11px] text-paper-300 mt-3 leading-relaxed">
                  El modelo por defecto es <strong className="text-gold-300">abliterated</strong>:
                  sin filtros de seguridad, mejor para temas oscuros del nicho xianxia.
                  Puedes cambiarlo a la variante oficial de Google con filtros desde Ajustes.
                </p>
              )}
              <p className="text-xs text-paper-300 mt-4">
                Descarga total estimada: <strong className="text-paper-100">{formatBytes(totalRecommended)}</strong>
              </p>
            </div>

            <Actions
              onBack={() => setStep('detect')}
              onNext={() => setStep('plan')}
              nextLabel="Continuar al plan"
            />
          </Pane>
        )}

        {step === 'plan' && manifest && (
          <Pane key="plan">
            <h2 className="font-display text-2xl mb-4">Plan de instalación</h2>
            <div className="space-y-2 mb-6">
              {manifest.map((c) => (
                <div key={c.id} className="flex items-center justify-between p-3 rounded-md bg-card/60 border border-border/40">
                  <div>
                    <div className="font-medium text-sm">{c.label}</div>
                    <div className="text-xs text-muted-foreground capitalize">{c.category}</div>
                  </div>
                  <div className="text-xs text-paper-300 font-mono">{formatBytes(c.size_bytes)}</div>
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
              nextIcon={Download}
            />
          </Pane>
        )}

        {step === 'installing' && manifest && (
          <Pane key="installing">
            <h2 className="font-display text-2xl mb-4">Instalando…</h2>
            <ProgressList components={manifest.map((c) => ({ id: c.id, label: c.label, size: c.size_bytes }))} onAllDone={() => setStep('done')} />
          </Pane>
        )}

        {step === 'done' && (
          <Pane key="done">
            <div className="text-center py-8">
              <CheckCircle2 className="w-16 h-16 text-jade-400 mx-auto mb-4" />
              <h2 className="font-display text-3xl font-medium mb-2">Instalación completada</h2>
              <p className="text-paper-300 max-w-md mx-auto">
                Xianxia Studio está listo. Puedes empezar a generar tu primer vídeo.
              </p>
              <a
                href="/"
                className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 rounded-md bg-gold-500 text-obsidian-950 font-medium text-sm hover:bg-gold-300 transition-colors shadow-glow-gold"
              >
                Ir al Dashboard
              </a>
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
    <div className="space-y-3">
      {components.map((c) => {
        const p = progress[c.id];
        const status = p?.status ?? 'pending';
        const percent = p?.percent ?? 0;
        return (
          <div key={c.id} className="p-4 rounded-md bg-card/60 border border-border/40">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {status === 'done' ? (
                  <CheckCircle2 className="w-4 h-4 text-jade-400" />
                ) : status === 'failed' ? (
                  <AlertTriangle className="w-4 h-4 text-crimson-400" />
                ) : (
                  <Download className={cn('w-4 h-4', status !== 'pending' ? 'text-gold-400 animate-pulse' : 'text-paper-300')} />
                )}
                {c.label}
              </div>
              <span className="text-xs text-paper-300 font-mono">{p?.message ?? formatBytes(c.size)}</span>
            </div>
            <div className="h-1 rounded-full bg-obsidian-800 overflow-hidden">
              <motion.div
                className={cn(
                  'h-full',
                  status === 'failed' ? 'bg-crimson-500' : status === 'done' ? 'bg-jade-400' : 'bg-gold-500',
                )}
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

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-border/50 bg-card/60 backdrop-blur p-8"
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
      className={cn(
        'flex items-center gap-3 p-3 rounded-md border text-sm',
        ok
          ? 'border-jade-500/40 bg-jade-700/10'
          : partial
          ? 'border-gold-500/40 bg-gold-500/5'
          : 'border-border/40 bg-obsidian-800/40',
      )}
    >
      {ok ? (
        <CheckCircle2 className="w-4 h-4 text-jade-400 shrink-0" />
      ) : partial ? (
        <AlertTriangle className="w-4 h-4 text-gold-400 shrink-0" />
      ) : (
        <XCircle className="w-4 h-4 text-paper-400 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium">{tool.label}</div>
        <div className="text-[11px] text-paper-300 truncate">
          {tool.version ? <code className="font-mono">{tool.version}</code> : 'no detectado'}
          {tool.note ? ` · ${tool.note}` : ''}
        </div>
      </div>
      {tool.path && (
        <span className="text-[10.5px] text-paper-400 font-mono truncate max-w-[260px]" title={tool.path}>
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
    <ol className="flex items-center gap-2 mb-8 text-xs">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cn(
              'w-6 h-6 rounded-full flex items-center justify-center font-medium',
              i < idx ? 'bg-jade-400 text-obsidian-950' :
              i === idx ? 'bg-gold-500 text-obsidian-950' :
              'bg-obsidian-800 text-paper-300',
            )}
          >
            {i + 1}
          </span>
          {i < steps.length - 1 && <span className="w-8 h-px bg-border/50" />}
        </li>
      ))}
    </ol>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md bg-card/60 border border-border/40 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-1">
        <Icon className="w-3.5 h-3.5 text-gold-400/70" />
        {label}
      </div>
      <div className="text-paper-100 text-sm font-medium truncate" title={value}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{sub}</div>
    </div>
  );
}

function Reco({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-paper-300 mb-1">{label}</div>
      <div className="text-paper-100 text-sm font-mono">{value}</div>
    </div>
  );
}

function Item({ icon, text }: { icon: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="text-lg leading-none mt-0.5">{icon}</span>
      <span className="leading-relaxed">{text}</span>
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
  nextIcon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex justify-end gap-2 mt-8 pt-6 border-t border-border/30">
      {onBack && (
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-md text-sm text-paper-200 hover:bg-obsidian-800 transition-colors"
        >
          Atrás
        </button>
      )}
      <button
        onClick={onNext}
        className="inline-flex items-center gap-2 px-5 py-2 rounded-md bg-gold-500 text-obsidian-950 font-medium text-sm hover:bg-gold-300 transition-colors shadow-glow-gold"
      >
        {NextIcon && <NextIcon className="w-4 h-4" />}
        {nextLabel}
      </button>
    </div>
  );
}
