import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Library as LibraryIcon, Film, Clock, Languages } from 'lucide-react';
import { tauri, type Project } from '@/lib/tauri';
import { cn, formatDuration } from '@/lib/utils';

export const Route = createFileRoute('/library')({
  component: LibraryRoute,
});

const STATUS_LABEL: Record<string, { label: string; tone: 'draft' | 'pending' | 'ready' | 'pub' | 'fail' }> = {
  draft: { label: 'Borrador', tone: 'draft' },
  generating: { label: 'Generando', tone: 'pending' },
  ready: { label: 'Listo', tone: 'ready' },
  scheduled: { label: 'Programado', tone: 'pending' },
  published: { label: 'Publicado', tone: 'pub' },
  failed: { label: 'Error', tone: 'fail' },
};

function LibraryRoute() {
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: tauri.listProjects,
    refetchInterval: 5000,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6"
    >
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
          Archivo
        </p>
        <h1 className="font-display text-4xl font-medium">Biblioteca</h1>
        <p className="text-paper-300 mt-2 max-w-2xl">
          Todos los vídeos producidos, ordenados por última actualización.
        </p>
      </header>

      {isLoading && (
        <div className="text-sm text-paper-300">Cargando…</div>
      )}

      {!isLoading && projects.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-12 flex flex-col items-center justify-center text-center min-h-[40vh]">
          <LibraryIcon className="w-10 h-10 text-gold-400/50 mb-4" />
          <h2 className="font-display text-2xl text-paper-100 mb-1">Aún no hay vídeos</h2>
          <p className="text-sm text-muted-foreground">
            Cuando produzcas tu primer vídeo aparecerá aquí.
          </p>
        </div>
      )}

      {projects.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const status = STATUS_LABEL[project.status] ?? { label: project.status, tone: 'draft' as const };
  const langs = (() => {
    try {
      return (JSON.parse(project.languages) as string[]).map((l) => l.toUpperCase()).join('·');
    } catch {
      return '';
    }
  })();
  return (
    <article className="rounded-lg border border-border/50 bg-card/60 p-5 hover:border-gold-500/40 transition-colors duration-200">
      <header className="flex items-start justify-between mb-3">
        <h3 className="font-display text-lg font-medium leading-snug line-clamp-2">{project.title}</h3>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>
      <p className="text-xs text-paper-300 line-clamp-2 mb-4">{project.topic}</p>
      <div className="flex items-center gap-4 text-[11px] text-paper-300">
        {project.duration_seconds && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDuration(project.duration_seconds)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Languages className="w-3 h-3" />
          {langs}
        </span>
        <span className="flex items-center gap-1">
          <Film className="w-3 h-3" />
          {new Date(project.updated_at * 1000).toLocaleDateString('es-ES')}
        </span>
      </div>
    </article>
  );
}

function Badge({ tone, children }: { tone: 'draft' | 'pending' | 'ready' | 'pub' | 'fail'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded',
        tone === 'draft' && 'bg-obsidian-700 text-paper-300',
        tone === 'pending' && 'bg-gold-500/20 text-gold-300 border border-gold-500/40',
        tone === 'ready' && 'bg-jade-500/20 text-jade-300 border border-jade-500/40',
        tone === 'pub' && 'bg-jade-600 text-paper-50',
        tone === 'fail' && 'bg-crimson-500/20 text-crimson-400 border border-crimson-500/40',
      )}
    >
      {children}
    </span>
  );
}
