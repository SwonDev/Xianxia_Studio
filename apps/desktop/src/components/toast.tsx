/**
 * Lightweight toast system — replaces window.alert / confirm with non-blocking
 * non-modal notifications + a confirmDialog promise that returns boolean.
 *
 * Usage from any component:
 *   const { toast, confirmDialog } = useToast();
 *   toast.success('Vídeo creado', 'Disponible en biblioteca');
 *   const ok = await confirmDialog({ title: 'Borrar?', body: '...' });
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  ttlMs: number;
}

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ToastApi {
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
  warning: (title: string, body?: string) => void;
}

interface Ctx {
  toast: ToastApi;
  confirmDialog: (opts: ConfirmOptions) => Promise<boolean>;
}

const ToastCtx = createContext<Ctx | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider live together intentionally
export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    opts: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ttlMs = kind === 'error' ? 8_000 : 4_000;
    setToasts((prev) => [...prev, { id, kind, title, body, ttlMs }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttlMs);
  }, []);

  const toast: ToastApi = {
    success: (t, b) => push('success', t, b),
    error:   (t, b) => push('error', t, b),
    info:    (t, b) => push('info', t, b),
    warning: (t, b) => push('warning', t, b),
  };

  const confirmDialog = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ open: true, opts, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    if (confirmState) {
      confirmState.resolve(ok);
      setConfirmState(null);
    }
  };

  return (
    <ToastCtx.Provider value={{ toast, confirmDialog }}>
      {children}

      {/* Toast stack (top-right) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed top-4 right-4 z-[100] flex flex-col gap-2 w-80"
        data-testid="toast-stack"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid={`toast-${t.kind}`}
            className={cn(
              'pointer-events-auto rounded-md border bg-card/95 backdrop-blur shadow-xl p-3 flex items-start gap-2.5 animate-in slide-in-from-right-4 fade-in duration-200',
              t.kind === 'success' && 'border-jade-500/50',
              t.kind === 'error'   && 'border-crimson-500/60',
              t.kind === 'warning' && 'border-gold-500/60',
              t.kind === 'info'    && 'border-border/60',
            )}
          >
            <div className="shrink-0 mt-0.5">
              {t.kind === 'success' && <CheckCircle2 className="w-4 h-4 text-jade-400" />}
              {t.kind === 'error'   && <AlertTriangle className="w-4 h-4 text-crimson-400" />}
              {t.kind === 'warning' && <AlertTriangle className="w-4 h-4 text-gold-400" />}
              {t.kind === 'info'    && <Info className="w-4 h-4 text-paper-300" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-paper-100 leading-tight">{t.title}</div>
              {t.body && <div className="text-xs text-paper-300 mt-1 leading-relaxed">{t.body}</div>}
            </div>
            <button
              onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
              aria-label="Cerrar"
              className="shrink-0 -mr-1 -mt-1 p-1 rounded text-paper-400 hover:text-paper-100 hover:bg-obsidian-800"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {confirmState?.open && (
        <div
          className="fixed inset-0 z-[110] bg-obsidian-950/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => close(false)}
          data-testid="confirm-dialog"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-border/50 bg-card p-5 shadow-2xl"
            role="alertdialog"
            aria-modal="true"
          >
            <h3 className="font-display text-xl text-paper-100 mb-2">{confirmState.opts.title}</h3>
            {confirmState.opts.body && (
              <p className="text-sm text-paper-300 leading-relaxed mb-5">{confirmState.opts.body}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => close(false)}
                data-testid="confirm-cancel"
                className="px-4 py-2 rounded-md text-sm bg-obsidian-800 border border-border/50 hover:bg-obsidian-700 text-paper-200"
              >
                {confirmState.opts.cancelLabel ?? 'Cancelar'}
              </button>
              <button
                onClick={() => close(true)}
                data-testid="confirm-ok"
                autoFocus
                className={cn(
                  'px-4 py-2 rounded-md text-sm font-medium',
                  confirmState.opts.danger
                    ? 'bg-crimson-500 text-paper-50 hover:bg-crimson-400'
                    : 'bg-gold-500 text-obsidian-950 hover:bg-gold-300',
                )}
              >
                {confirmState.opts.confirmLabel ?? 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}
