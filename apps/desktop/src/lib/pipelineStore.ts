/**
 * Global pipeline-progress store (Zustand, module-level).
 *
 * Why this exists: the generation runs in the Rust backend and keeps
 * going regardless of the UI. Before v0.2.10 the progress state
 * (activeProjectId / phaseState / imageThumbs / error) lived in
 * `generator.tsx` React `useState`, so navigating to another section
 * unmounted the component and wiped it — coming back showed an empty
 * "Iniciar generación" as if the run had reset (it hadn't; the backend
 * was still working, the UI just forgot). User report 2026-05-16.
 *
 * Fix: hold that state HERE, outside the component tree, and subscribe
 * to the Tauri pipeline events ONCE at the app root (which never
 * unmounts during navigation). The generator route becomes a pure
 * reader of this store, so switching sections and back shows the live
 * state. Survives route changes; NOT a full app reload (that needs a
 * backend "current run" query — tracked separately).
 */
import { create } from 'zustand';
import {
  events,
  type PhaseUpdate,
  type ImageReadyEvent,
  type ChapterUpdate,
} from '@/lib/tauri';

interface PipelineState {
  activeProjectId: string | null;
  phaseState: Record<number, PhaseUpdate>;
  imageThumbs: ImageReadyEvent[];
  error: string | null;

  /** Per-chapter progress (long-form only). Keyed by 1-based index. */
  chapters: Record<number, { title: string; status: 'pending' | 'writing' | 'done' | 'failed'; words: number }>;
  /** ETA for long-form generation. Populated by Task 14; null here. */
  eta: { secondsLeft: number; basis: string } | null;

  /** Called by handleStart BEFORE the backend id is known: seeds an
   * immediate phase-1 "running" so the user sees feedback at once. */
  seedStarting: () => void;
  /** Called with the project id returned by tauri.startGeneration. */
  setActiveProject: (id: string) => void;
  /** Reset everything (new run about to start, or start failed). */
  reset: () => void;
  setError: (e: string | null) => void;

  // Internal — fed by the app-root event subscription.
  _applyProgress: (p: PhaseUpdate) => void;
  _applyError: (e: { project_id: string; error: string }) => void;
  _applyImage: (p: ImageReadyEvent) => void;
  applyChapter: (c: { index: number; title: string; status: 'pending' | 'writing' | 'done' | 'failed'; words: number }) => void;
}

/** Accept an event when no project is bound yet (events can arrive
 * before tauri.startGeneration resolves) OR it matches the active run.
 * Identical semantics to the old in-component `!aid || id === aid`. */
function belongs(activeId: string | null, evtId: string): boolean {
  return !activeId || !evtId || evtId === activeId;
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  activeProjectId: null,
  phaseState: {},
  imageThumbs: [],
  error: null,
  chapters: {},
  eta: null,

  seedStarting: () =>
    set({
      error: null,
      imageThumbs: [],
      phaseState: {
        1: {
          project_id: '',
          phase: 1,
          status: 'running',
          progress: 1,
          message: 'Iniciando…',
        },
      },
    }),

  setActiveProject: (id) => set({ activeProjectId: id }),

  reset: () =>
    set({
      activeProjectId: null,
      phaseState: {},
      imageThumbs: [],
      error: null,
      chapters: {},
      eta: null,
    }),

  setError: (e) => set({ error: e }),

  _applyProgress: (p) => {
    if (!belongs(get().activeProjectId, p.project_id)) return;
    set((s) => ({ phaseState: { ...s.phaseState, [p.phase]: p } }));
  },

  _applyError: (e) => {
    if (!belongs(get().activeProjectId, e.project_id)) return;
    set({ error: e.error });
  },

  _applyImage: (p) => {
    if (!belongs(get().activeProjectId, p.project_id)) return;
    set((s) => {
      const filtered = s.imageThumbs.filter((x) => x.index !== p.index);
      return {
        imageThumbs: [...filtered, p].sort((a, b) => a.index - b.index),
      };
    });
  },

  applyChapter: (c) =>
    set((s) => ({
      chapters: {
        ...s.chapters,
        [c.index]: { title: c.title, status: c.status, words: c.words },
      },
    })),
}));

/**
 * Register the Tauri pipeline event listeners exactly ONCE for the app
 * lifetime. Call from the app root (`__root.tsx`) which never unmounts
 * during navigation, so events keep flowing into the store even when
 * the generator route is not mounted. Idempotent (React StrictMode /
 * re-render safe) via a module guard. We intentionally never unlisten —
 * these live as long as the app window.
 */
let _subscribed = false;
export function ensurePipelineSubscription(): void {
  if (_subscribed) return;
  _subscribed = true;
  const { _applyProgress, _applyError, _applyImage, applyChapter } =
    usePipelineStore.getState();
  void events.onPipelineProgress(_applyProgress);
  void events.onPipelineError(_applyError);
  void events.onImageReady(_applyImage);
  void events.onChapterProgress((p: ChapterUpdate) =>
    applyChapter({
      index: p.index,
      title: p.title,
      status: p.status as 'pending' | 'writing' | 'done' | 'failed',
      words: p.words,
    }),
  );
}
