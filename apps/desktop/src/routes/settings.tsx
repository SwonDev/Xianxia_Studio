import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  AlertTriangle, Cpu, Youtube, Database, Bot, Download, Link2, Unlink, KeyRound, ShieldCheck, RefreshCw, CheckCircle2, XCircle, Music, FolderOpen, Trash2, Plus,
} from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { tauri, events, type CheckItem, type MusicLibrary } from '@/lib/tauri';
import { cn, formatBytes } from '@/lib/utils';

export const Route = createFileRoute('/settings')({
  component: SettingsRoute,
});

function SettingsRoute() {
  const { data: hw } = useQuery({ queryKey: ['hardware'], queryFn: tauri.detectHardware });
  const { data: sidecars } = useQuery({
    queryKey: ['sidecars'],
    queryFn: tauri.getSidecarState,
    refetchInterval: 4000,
  });
  const [experimental, setExperimental] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-6 max-w-3xl"
    >
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-gold-400 font-medium mb-2">
          Configuración
        </p>
        <h1 className="font-display text-4xl font-medium">Ajustes</h1>
      </header>

      <Section title="Servicios" icon={Database}>
        <ServiceRow label="Ollama (LLM)" status={sidecars?.ollama ?? 'stopped'} />
        <ServiceRow label="Python sidecar (FastAPI :8731)" status={sidecars?.python ?? 'stopped'} />
        <ServiceRow label="Node sidecar (HyperFrames :8732)" status={sidecars?.node ?? 'stopped'} />
      </Section>

      <Section title="Hardware" icon={Cpu}>
        {hw && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Row label="CPU" value={`${hw.cpu_brand} (${hw.cpu_cores}c)`} />
            <Row label="RAM" value={`${hw.total_ram_gb.toFixed(0)} GB`} />
            <Row label="GPU" value={hw.gpu?.name ?? 'CPU only'} />
            <Row label="VRAM" value={hw.gpu?.vram_gb ? `${hw.gpu.vram_gb.toFixed(1)} GB` : '—'} />
            <Row label="Disco libre" value={`${hw.free_disk_gb.toFixed(0)} GB`} />
            <Row label="Tier recomendado" value={hw.recommendation.tier} highlight />
          </div>
        )}
      </Section>

      <Section title="Modelos Gemma 4" icon={Bot}>
        {hw && (
          <div className="space-y-2 text-sm">
            <Row label="LLM activo" value={hw.recommendation.llm_label} mono />
            <Row label="Repositorio HF" value={hw.recommendation.llm_hf_repo} mono />
            <Row label="GGUF" value={hw.recommendation.llm_gguf_file} mono />
            <Row label="Variante" value={hw.recommendation.llm_abliterated ? 'abliterated (default)' : 'oficial con filtros'} highlight />
            <Row label="Imagen" value={hw.recommendation.image} mono />
            <Row label="TTS" value={hw.recommendation.tts} mono />
          </div>
        )}
        <div className="mt-4 flex gap-3">
          <a
            href="/install"
            className="inline-flex items-center gap-2 text-sm text-gold-300 hover:text-gold-400"
          >
            <Download className="w-4 h-4" /> Reabrir asistente de instalación
          </a>
        </div>
      </Section>

      <Section title="Verificación del stack" icon={ShieldCheck}>
        <VerifyStackPanel />
      </Section>

      <Section title="Biblioteca de música" icon={Music}>
        <MusicLibraryPanel />
      </Section>

      <Section title="Credenciales Google OAuth" icon={KeyRound}>
        <OAuthCredentialsPanel />
      </Section>

      <Section title="YouTube" icon={Youtube}>
        <YouTubePanel />
      </Section>

      <Section title="Variante segura del LLM (filtros oficiales)" icon={AlertTriangle}>
        <p className="text-sm text-paper-300 mb-3 leading-relaxed">
          Por defecto, Xianxia Studio usa el GGUF <strong className="text-paper-100">abliterated</strong> de
          Gemma 4 — sin filtros de seguridad — porque genera mejor narrativa para
          temas oscuros del nicho (demonios, cultivo desviado, batallas brutales).
          Si prefieres la variante oficial de Google con filtros activos, alterna aquí.
        </p>
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExperimental(!experimental)}
            className={cn(
              'shrink-0 w-9 h-5 rounded-full relative transition-colors',
              experimental ? 'bg-jade-500' : 'bg-obsidian-700',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-4 h-4 rounded-full bg-paper-100 transition-all',
                experimental ? 'left-[18px]' : 'left-0.5',
              )}
            />
          </button>
          <div className="text-sm">
            <div className="font-medium text-paper-100">
              Usar Gemma 4 oficial con filtros
            </div>
            <div className="text-xs text-paper-300 leading-relaxed mt-1">
              {experimental ? (
                <>Activado: descargará <code>unsloth/gemma-4-E4B-it-GGUF</code> al cambiar.</>
              ) : (
                'Desactivado: se usa el modelo abliterated por defecto.'
              )}
            </div>
          </div>
        </div>
      </Section>
    </motion.div>
  );
}

function Section({
  title,
  icon: Icon,
  danger,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-lg border bg-card/60 backdrop-blur p-6',
        danger ? 'border-crimson-500/30' : 'border-border/50',
      )}
    >
      <h2 className="flex items-center gap-2 font-display text-xl font-medium mb-4">
        <Icon className={cn('w-5 h-5', danger ? 'text-crimson-400' : 'text-gold-400')} />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
      <span className="text-xs uppercase tracking-wide text-paper-300">{label}</span>
      <span
        className={cn(
          'text-sm',
          mono && 'font-mono',
          highlight && 'text-gold-300 font-medium uppercase',
        )}
      >
        {value}
      </span>
    </div>
  );
}

// SettingsRoute is the named export above. Helpers below.

function VerifyStackPanel() {
  const { data: report, isFetching, refetch } = useQuery({
    queryKey: ['verify-stack'],
    queryFn: tauri.verifyStack,
    refetchInterval: 15000,
  });

  // Group checks by their `group` field for cleaner display
  const grouped = (report?.checks ?? []).reduce<Record<string, CheckItem[]>>((acc, c) => {
    const g = c.group || 'Otros';
    (acc[g] = acc[g] || []).push(c);
    return acc;
  }, {});

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm">
          {report?.all_ok ? (
            <span className="text-jade-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Todos los componentes operativos
            </span>
          ) : report?.summary ? (
            <span className="text-paper-300">
              {report.summary.models_ready_count}/{report.summary.models_total} modelos listos ·{' '}
              {report.summary.gpu_available ? '🟢 GPU' : '⚪ CPU'} ·{' '}
              {report.summary.video_hw_accelerated ? '🟢 HW codec' : '⚪ libx264'}
            </span>
          ) : (
            <span className="text-paper-300">Verificando…</span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs bg-obsidian-800 border border-border/50 hover:border-gold-500/40 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Re-verificar
        </button>
      </div>

      {Object.entries(grouped).map(([groupName, items]) => (
        <div key={groupName} className="mb-4 last:mb-0">
          <h3 className="text-[10.5px] uppercase tracking-[0.2em] text-paper-300 font-medium mb-2">
            {groupName}
          </h3>
          <ul className="space-y-1.5">
            {items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 text-sm py-1.5 border-b border-border/20 last:border-0">
                {c.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-jade-400 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-paper-400 shrink-0" />
                )}
                <span className="flex-1 min-w-0">{c.label}</span>
                <span className="text-[11px] text-paper-300 truncate max-w-[320px]" title={c.detail}>
                  {c.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function OAuthCredentialsPanel() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['youtube-app-status'],
    queryFn: tauri.youtubeAppStatus,
    refetchInterval: 5000,
  });
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Ambos campos son obligatorios.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await tauri.youtubeSetAppCredentials(clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['youtube-app-status'] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await tauri.youtubeClearAppCredentials();
      qc.invalidateQueries({ queryKey: ['youtube-app-status'] });
      qc.invalidateQueries({ queryKey: ['youtube-status'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-sm text-paper-300 mb-3 leading-relaxed">
        Para subir vídeos automáticamente, Xianxia Studio necesita un par
        <strong className="text-paper-100"> client_id / client_secret</strong> de Google
        Cloud (proyecto con la API de YouTube Data v3 habilitada y un OAuth client tipo
        “Desktop”). Las credenciales se guardan en el llavero del sistema, nunca en
        texto plano.
      </p>

      {status?.configured && !editing ? (
        <div className="flex items-center justify-between p-3 rounded-md bg-jade-700/15 border border-jade-600/30 mb-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-jade-400" />
            <span className="font-mono">{status.client_id_preview}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 rounded-md text-xs bg-obsidian-800 border border-border/50 hover:border-gold-500/40"
            >
              Cambiar
            </button>
            <button
              onClick={handleClear}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs bg-obsidian-800 border border-border/50 hover:border-crimson-500/50 hover:text-crimson-400 disabled:opacity-50"
            >
              Borrar
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wide text-paper-300 mb-1">Client ID</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-abcdef.apps.googleusercontent.com"
              className="w-full bg-obsidian-800 border border-border/50 rounded-md px-3 py-2 text-paper-100 placeholder:text-paper-400 focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-paper-300 mb-1">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-…"
              className="w-full bg-obsidian-800 border border-border/50 rounded-md px-3 py-2 text-paper-100 placeholder:text-paper-400 focus:outline-none focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20 font-mono text-sm"
            />
          </div>
          {error && (
            <p className="text-xs text-crimson-400 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={busy}
              className="px-4 py-2 rounded-md bg-gold-500 text-obsidian-950 text-sm font-medium hover:bg-gold-300 disabled:opacity-50 transition-colors shadow-glow-gold"
            >
              {busy ? 'Guardando…' : 'Guardar credenciales'}
            </button>
            {status?.configured && (
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 rounded-md bg-obsidian-800 border border-border/50 text-sm hover:border-paper-300"
              >
                Cancelar
              </button>
            )}
          </div>
        </div>
      )}

      <details className="mt-4">
        <summary className="text-xs text-paper-300 cursor-pointer hover:text-paper-100">
          ¿Cómo obtengo estas credenciales?
        </summary>
        <ol className="text-xs text-paper-300 mt-2 ml-4 space-y-1 leading-relaxed list-decimal">
          <li>Crea un proyecto en console.cloud.google.com</li>
          <li>Activa la API "YouTube Data API v3"</li>
          <li>En "Credenciales" → Create credentials → OAuth client ID → Desktop app</li>
          <li>Copia el client_id y el client_secret aquí</li>
          <li>En la pantalla de consentimiento añade tu correo como Test User</li>
        </ol>
      </details>
    </div>
  );
}

function YouTubePanel() {
  const qc = useQueryClient();
  const { data: yt } = useQuery({
    queryKey: ['youtube-status'],
    queryFn: tauri.youtubeStatus,
    refetchInterval: 5000,
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unC: (() => void) | null = null;
    let unE: (() => void) | null = null;
    events.onYoutubeConnected(() => {
      setConnecting(false);
      qc.invalidateQueries({ queryKey: ['youtube-status'] });
    }).then((u) => (unC = u));
    events.onYoutubeError((msg) => {
      setError(msg);
      setConnecting(false);
    }).then((u) => (unE = u));
    return () => {
      unC?.();
      unE?.();
    };
  }, [qc]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { url } = await tauri.youtubeOAuthStart();
      await openUrl(url);
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await tauri.youtubeDisconnect();
    qc.invalidateQueries({ queryKey: ['youtube-status'] });
  };

  if (yt?.connected) {
    return (
      <div>
        <p className="text-sm text-paper-200 mb-3 flex items-center gap-2">
          <Link2 className="w-4 h-4 text-jade-400" />
          Cuenta vinculada{yt.expires_at ? ` · token expira ${new Date(yt.expires_at * 1000).toLocaleString('es-ES')}` : ''}
        </p>
        <button
          onClick={handleDisconnect}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-obsidian-800 border border-border/50 text-sm hover:border-crimson-500/50 hover:text-crimson-400 transition-colors"
        >
          <Unlink className="w-4 h-4" />
          Desconectar
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-paper-300 mb-3">
        Vincula tu cuenta para subir vídeos automáticamente. Se abre el navegador del sistema con el consentimiento de Google.
      </p>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gold-500 text-obsidian-950 text-sm font-medium hover:bg-gold-300 disabled:opacity-50 transition-colors shadow-glow-gold"
      >
        <Youtube className="w-4 h-4" />
        {connecting ? 'Esperando autorización…' : 'Conectar con Google'}
      </button>
      {error && (
        <p className="text-xs text-crimson-400 mt-3 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </p>
      )}
    </div>
  );
}

function ServiceRow({ label, status }: { label: string; status: string }) {
  const ok = status === 'running';
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <span className="text-sm">{label}</span>
      <span
        className={cn(
          'flex items-center gap-2 text-xs uppercase tracking-wider',
          ok ? 'text-jade-300' : 'text-paper-300',
        )}
      >
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            ok ? 'bg-jade-400 shadow-[0_0_6px_rgba(82,183,136,0.7)]' : 'bg-paper-400',
          )}
        />
        {status}
      </span>
    </div>
  );
}

function MusicLibraryPanel() {
  const queryClient = useQueryClient();
  const { data: lib, isLoading } = useQuery<MusicLibrary>({
    queryKey: ['music-library'],
    queryFn: tauri.musicListTracks,
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['music-library'] });

  const handleAdd = async () => {
    setFeedback(null);
    setBusy(true);
    try {
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const added = await tauri.musicAddTracks(paths);
      setFeedback(`${added} pista${added === 1 ? '' : 's'} añadida${added === 1 ? '' : 's'}.`);
      refresh();
    } catch (e) {
      setFeedback(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (name: string) => {
    setFeedback(null);
    if (!confirm(`¿Eliminar "${name}" de la biblioteca?`)) return;
    setBusy(true);
    try {
      await tauri.musicRemoveTrack(name);
      setFeedback(`"${name}" eliminada.`);
      refresh();
    } catch (e) {
      setFeedback(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async () => {
    try {
      await tauri.musicOpenFolder();
    } catch (e) {
      setFeedback(`Error abriendo carpeta: ${String(e)}`);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-paper-300 leading-relaxed">
        Añade pistas para que el pipeline las escoja aleatoriamente como banda
        sonora. Formatos: MP3, M4A, WAV, OGG, FLAC. Las pistas se copian a la
        biblioteca local — el original no se mueve.
      </p>

      {lib && (
        <div className="text-xs text-paper-400 font-mono break-all">
          📁 {lib.dir}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleAdd}
          disabled={busy}
          data-testid="music-add"
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-gold-500 text-obsidian-950 text-xs font-medium hover:bg-gold-300 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Añadir pistas
        </button>
        <button
          onClick={handleOpen}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-obsidian-800 text-paper-200 text-xs font-medium hover:bg-obsidian-700 border border-border/40 transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5" /> Abrir carpeta
        </button>
        <button
          onClick={refresh}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-obsidian-800 text-paper-200 text-xs font-medium hover:bg-obsidian-700 border border-border/40 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refrescar
        </button>
        {lib && (
          <span className="text-xs text-paper-400 ml-auto">
            {lib.tracks.length} pista{lib.tracks.length === 1 ? '' : 's'} · {formatBytes(lib.total_bytes)}
          </span>
        )}
      </div>

      {feedback && (
        <div className="text-xs text-jade-300 bg-jade-700/15 border border-jade-600/30 rounded-md p-2.5">
          {feedback}
        </div>
      )}

      <div className="rounded-md border border-border/40 bg-obsidian-800/40 max-h-64 overflow-y-auto">
        {isLoading && <div className="p-3 text-xs text-paper-400">Cargando…</div>}
        {lib && lib.tracks.length === 0 && (
          <div className="p-4 text-center text-xs text-paper-400">
            Biblioteca vacía. Pulsa <strong>Añadir pistas</strong> para empezar.
          </div>
        )}
        {lib?.tracks.map((t) => (
          <div
            key={t.path}
            className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border/20 last:border-0 hover:bg-obsidian-800/60 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" title={t.name}>{t.name}</div>
              <div className="text-[10px] text-paper-400 font-mono">{formatBytes(t.size_bytes)}</div>
            </div>
            <button
              onClick={() => handleRemove(t.name)}
              disabled={busy}
              className="p-1.5 rounded text-paper-300 hover:text-crimson-400 hover:bg-crimson-500/10 transition-colors disabled:opacity-50"
              aria-label={`Eliminar ${t.name}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
