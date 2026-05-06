/**
 * Settings panel: check for updates from the latest GitHub Release.
 *
 * Flow:
 *   idle → checking → up-to-date | available
 *   available → downloading (progress) → ready → relaunch
 */
import { useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  Download,
  RefreshCw,
  Sparkles,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; update: Update; received: number; total: number | null }
  | { kind: 'ready'; update: Update }
  | { kind: 'error'; message: string };

export function UpdaterPanel() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const { toast } = useToast();

  const { data: currentVersion } = useQuery({
    queryKey: ['app-version'],
    queryFn: () => getVersion(),
    staleTime: Infinity,
  });

  async function handleCheck() {
    setState({ kind: 'checking' });
    try {
      const update = await check();
      if (update) {
        setState({ kind: 'available', update });
      } else {
        setState({ kind: 'up-to-date' });
        toast.success('Ya tienes la última versión.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
    }
  }

  async function handleInstall(update: Update) {
    setState({ kind: 'downloading', update, received: 0, total: null });
    try {
      await update.downloadAndInstall((evt) => {
        switch (evt.event) {
          case 'Started':
            setState({
              kind: 'downloading',
              update,
              received: 0,
              total: evt.data.contentLength ?? null,
            });
            break;
          case 'Progress':
            setState((s) =>
              s.kind === 'downloading'
                ? { ...s, received: s.received + evt.data.chunkLength }
                : s,
            );
            break;
          case 'Finished':
            setState({ kind: 'ready', update });
            break;
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
      toast.error('Falló la descarga', message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm text-paper-200">
            Versión instalada
            <span className="ml-2 font-mono text-gold-300">
              {currentVersion ? `v${currentVersion}` : '—'}
            </span>
          </p>
          <p className="text-xs text-paper-400 mt-0.5">
            Las actualizaciones se descargan firmadas desde GitHub Releases.
          </p>
        </div>

        {(state.kind === 'idle' || state.kind === 'up-to-date' || state.kind === 'error') && (
          <button
            onClick={handleCheck}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-gold-500/10 border border-gold-500/30 text-gold-300 text-sm hover:bg-gold-500/15 transition-colors"
            data-testid="updater-check"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Buscar actualizaciones
          </button>
        )}
        {state.kind === 'checking' && (
          <span className="inline-flex items-center gap-2 text-sm text-paper-300">
            <RotateCw className="w-3.5 h-3.5 animate-spin" />
            Comprobando…
          </span>
        )}
      </div>

      {state.kind === 'up-to-date' && (
        <Banner level="success" icon={CheckCircle2}>
          Estás en la versión más reciente.
        </Banner>
      )}

      {state.kind === 'error' && (
        <Banner level="error" icon={AlertTriangle}>
          No se pudo comprobar:&nbsp;
          <span className="font-mono text-xs">{state.message}</span>
        </Banner>
      )}

      {state.kind === 'available' && (
        <div className="rounded-md border border-gold-500/40 bg-gold-500/5 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-gold-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-paper-100">
                Hay una versión nueva:&nbsp;
                <span className="font-mono text-gold-300">v{state.update.version}</span>
                {state.update.date && (
                  <span className="text-paper-400 text-xs ml-2">
                    publicada {new Date(state.update.date).toLocaleDateString()}
                  </span>
                )}
              </p>
              {state.update.body && (
                <details className="mt-2">
                  <summary className="text-xs text-gold-300 cursor-pointer hover:underline">
                    Ver notas de la versión
                  </summary>
                  <pre className="mt-2 text-xs whitespace-pre-wrap text-paper-200 font-sans leading-relaxed max-h-48 overflow-y-auto">
                    {state.update.body}
                  </pre>
                </details>
              )}
            </div>
          </div>
          <button
            onClick={() => handleInstall(state.update)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-gold-500 text-obsidian-950 text-sm font-medium hover:bg-gold-400 transition-colors"
            data-testid="updater-install"
          >
            <Download className="w-3.5 h-3.5" />
            Descargar e instalar
          </button>
        </div>
      )}

      {state.kind === 'downloading' && (
        <Progress
          received={state.received}
          total={state.total}
          versionLabel={`v${state.update.version}`}
        />
      )}

      {state.kind === 'ready' && (
        <div className="rounded-md border border-jade-500/40 bg-jade-500/5 p-4 space-y-3">
          <p className="text-sm text-jade-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Actualización lista. Reinicia para aplicarla.
          </p>
          <button
            onClick={() => relaunch()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-jade-500 text-obsidian-950 text-sm font-medium hover:bg-jade-400 transition-colors"
            data-testid="updater-relaunch"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Reiniciar ahora
          </button>
        </div>
      )}
    </div>
  );
}

function Banner({
  level,
  icon: Icon,
  children,
}: {
  level: 'success' | 'error' | 'info';
  icon: typeof CheckCircle2;
  children: React.ReactNode;
}) {
  const cls = {
    success: 'border-jade-500/40 bg-jade-500/5 text-jade-300',
    error: 'border-crimson-500/40 bg-crimson-500/5 text-crimson-400',
    info: 'border-gold-500/40 bg-gold-500/5 text-gold-300',
  }[level];
  return (
    <div className={cn('rounded-md border p-3 text-sm flex items-center gap-2', cls)}>
      <Icon className="w-4 h-4 shrink-0" />
      <span className="text-paper-100">{children}</span>
    </div>
  );
}

function Progress({
  received,
  total,
  versionLabel,
}: {
  received: number;
  total: number | null;
  versionLabel: string;
}) {
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : null;
  const fmt = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };
  return (
    <div className="rounded-md border border-gold-500/30 bg-obsidian-800/50 p-4 space-y-2">
      <div className="flex items-center justify-between text-xs text-paper-200">
        <span className="flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5 text-gold-400 animate-pulse" />
          Descargando {versionLabel}
        </span>
        <span className="font-mono">
          {fmt(received)}
          {total ? ` / ${fmt(total)}` : ''}
          {pct !== null ? ` · ${pct}%` : ''}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-obsidian-900 overflow-hidden">
        <div
          className="h-full bg-gold-400 transition-[width] duration-200"
          style={{ width: pct !== null ? `${pct}%` : '20%' }}
        />
      </div>
    </div>
  );
}
