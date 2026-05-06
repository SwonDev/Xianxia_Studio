/**
 * Global keyboard shortcuts. Mounted at root, listens once for keydown.
 * Skips when focus is in an input/textarea/contenteditable so typing isn't
 * hijacked.
 *
 *   g  → Generador           (Crear vídeo)
 *   l  → Biblioteca
 *   s  → Smart Shorts
 *   p  → Planificador
 *   ,  → Ajustes
 *   d  → Dashboard
 *   ?  → muestra el help overlay con todos los atajos
 *   Esc → cierra cualquier overlay abierto
 */
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Keyboard, X } from 'lucide-react';

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't interfere with typing.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      // Don't fire when modifier keys are held (Ctrl/Cmd are usually browser shortcuts).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'g':
          e.preventDefault();
          navigate({ to: '/generator' });
          break;
        case 'l':
          e.preventDefault();
          navigate({ to: '/library' });
          break;
        case 's':
          e.preventDefault();
          navigate({ to: '/shorts' });
          break;
        case 'p':
          e.preventDefault();
          navigate({ to: '/scheduler' });
          break;
        case ',':
          e.preventDefault();
          navigate({ to: '/settings' });
          break;
        case 'd':
          e.preventDefault();
          navigate({ to: '/' });
          break;
        case '?':
          e.preventDefault();
          setHelpOpen((v) => !v);
          break;
        case 'Escape':
          if (helpOpen) {
            e.preventDefault();
            setHelpOpen(false);
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, helpOpen]);

  if (!helpOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[120] bg-obsidian-950/80 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => setHelpOpen(false)}
      data-testid="keyboard-help"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border/50 bg-card p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-2 mb-4">
          <Keyboard className="w-5 h-5 text-gold-400" />
          <h3 className="font-display text-xl text-paper-100">Atajos de teclado</h3>
          <button
            onClick={() => setHelpOpen(false)}
            aria-label="Cerrar atajos"
            className="ml-auto p-1.5 rounded-md text-paper-300 hover:text-paper-100 hover:bg-obsidian-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <ul className="space-y-2 text-sm text-paper-200">
          {([
            ['d', 'Dashboard'],
            ['g', 'Generador (crear vídeo)'],
            ['s', 'Smart Shorts'],
            ['l', 'Biblioteca'],
            ['p', 'Planificador'],
            [',', 'Ajustes'],
            ['?', 'Mostrar / ocultar este menú'],
            ['Esc', 'Cerrar cualquier diálogo'],
          ] as const).map(([key, label]) => (
            <li key={key} className="flex items-center justify-between gap-3 py-1 border-b border-border/30 last:border-0">
              <span>{label}</span>
              <kbd className="font-mono text-xs bg-obsidian-800 border border-border/50 rounded px-2 py-0.5 text-gold-300">
                {key}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="text-xs text-paper-400 mt-4 leading-relaxed">
          Los atajos se desactivan automáticamente cuando estás escribiendo en un input.
        </p>
      </div>
    </div>
  );
}
