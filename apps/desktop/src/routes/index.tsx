import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Sparkles, Zap, Library, CalendarClock } from 'lucide-react';
import { tauri } from '@/lib/tauri';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

function Dashboard() {
  const { data: version } = useQuery({
    queryKey: ['app-version'],
    queryFn: tauri.getAppVersion,
  });
  const { data: hw } = useQuery({
    queryKey: ['hardware'],
    queryFn: tauri.detectHardware,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-10"
    >
      {/* Hero */}
      <header className="space-y-3 max-w-3xl">
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium">
          Bienvenido al estudio
        </p>
        <h1 className="font-display text-5xl font-medium leading-tight">
          <span className="text-shimmer-gold">El cultivo del contenido</span>
          <span className="block text-paper-100 italic text-3xl mt-2">comienza aquí.</span>
        </h1>
        <p className="text-paper-300 text-base leading-relaxed max-w-2xl pt-2">
          Xianxia Studio orquesta cada paso de la producción de tus vídeos —
          desde el guión hasta la publicación — con inteligencia artificial que
          se ejecuta enteramente en tu propia máquina.
        </p>
      </header>

      {/* Quick stats grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Proyectos" value="0" hint="ningún borrador todavía" icon={Sparkles} />
        <StatCard label="En cola" value="0" hint="programaciones activas" icon={CalendarClock} />
        <StatCard label="Publicados" value="0" hint="vídeos en YouTube" icon={Library} />
        <StatCard
          label="Hardware"
          value={hw ? `${hw.cpu_cores}c · ${hw.total_ram_gb.toFixed(0)}GB` : '...'}
          hint={hw?.cpu_brand ?? 'detectando'}
          icon={Zap}
        />
      </section>

      {/* CTA Card */}
      <section className="rounded-xl border border-border/60 bg-gradient-to-br from-obsidian-900 via-obsidian-900 to-obsidian-800 p-8 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04] pointer-events-none">
          <div className="absolute top-0 right-0 w-96 h-96 bg-gold-500 rounded-full blur-3xl" />
          <div className="absolute bottom-0 left-0 w-72 h-72 bg-jade-500 rounded-full blur-3xl" />
        </div>
        <div className="relative">
          <h2 className="font-display text-3xl font-medium mb-3">¿Listo para crear?</h2>
          <p className="text-paper-300 max-w-xl mb-6">
            Elige un tema, configura el tono y deja que el pipeline de 10 fases produzca
            tu vídeo de forma autónoma. Script, narración, imágenes, música, subtítulos
            multiidioma y publicación programada — todo desde una sola pantalla.
          </p>
          <a
            href="/generator"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-gold-500 text-obsidian-950 font-medium text-sm hover:bg-gold-300 transition-colors duration-150 shadow-glow-gold"
          >
            <Sparkles className="w-4 h-4" />
            Generar nuevo vídeo
          </a>
        </div>
      </section>

      {/* Footer info */}
      <footer className="text-xs text-muted-foreground pt-6 border-t border-border/30 flex items-center justify-between">
        <span>
          Xianxia Studio {version?.version ?? '...'} · Tauri {version?.tauri ?? '...'}
        </span>
        <span className="font-mono">{hw?.os}/{hw?.arch}</span>
      </footer>
    </motion.div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/60 backdrop-blur p-5 hover:border-gold-500/40 transition-colors duration-200">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[10.5px] uppercase tracking-[0.15em] text-muted-foreground font-medium">
          {label}
        </span>
        <Icon className="w-4 h-4 text-gold-400/60" />
      </div>
      <div className="font-display text-3xl font-medium text-paper-100">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{hint}</div>
    </div>
  );
}
