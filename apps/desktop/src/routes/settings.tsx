import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Warning, Cpu, YoutubeLogo, Database, Robot, DownloadSimple, LinkSimple,
  LinkBreak, Key, ShieldCheck, ArrowsClockwise, CheckCircle, XCircle,
  MusicNotes, FolderOpen, Trash, Plus, Sparkle, CaretRight, ShareNetwork,
  FilmSlate,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { UpdaterPanel } from '@/components/updater-panel';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { tauri, events, type CheckItem, type MusicLibrary, type SidecarState, type LtxCapability } from '@/lib/tauri';
import { formatBytes } from '@/lib/utils';
import { PageHeader } from '@/components/ui-glass';

export const Route = createFileRoute('/settings')({
  component: SettingsRoute,
});

const inputStyle: CSSProperties = { height: 30 };

function SettingsRoute() {
  const { data: hw } = useQuery({ queryKey: ['hardware'], queryFn: tauri.detectHardware });
  const { data: sidecars } = useQuery({
    queryKey: ['sidecars'],
    queryFn: tauri.getSidecarState,
    refetchInterval: 4000,
  });
  const [experimental, setExperimental] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="route-enter page">
      <PageHeader title="Ajustes" subtitle="Servicios, modelos, hardware y credenciales del estudio." />

      <Section title="Actualizaciones" icon={Sparkle} defaultOpen>
        <UpdaterPanel />
      </Section>

      <Section title="Servicios" icon={Database} defaultOpen>
        <ServiceRow label="llama.cpp (LLM :8733)" status={sidecars?.llamacpp ?? 'stopped'} />
        <ServiceRow label="Python sidecar (FastAPI :8731)" status={sidecars?.python ?? 'stopped'} />
        <ServiceRow label="Node sidecar (HyperFrames :8732)" status={sidecars?.node ?? 'stopped'} />
        <ServiceRow label="ComfyUI (Z-Image :8188)" status={sidecars?.comfyui ?? 'stopped'} />
        <OllamaServiceRow ollamaStatus={sidecars?.ollama ?? 'stopped'} />
      </Section>

      <Section title="Modelo LLM (llama.cpp)" icon={Robot}>
        <LlmModelPanel />
      </Section>

      <Section title="Hardware" icon={Cpu}>
        {hw && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <Row label="CPU" value={`${hw.cpu_brand} (${hw.cpu_cores}c)`} />
            <Row label="RAM" value={`${hw.total_ram_gb.toFixed(0)} GB`} />
            <Row label="GPU" value={hw.gpu?.name ?? 'CPU only'} />
            <Row label="VRAM" value={hw.gpu?.vram_gb ? `${hw.gpu.vram_gb.toFixed(1)} GB` : '—'} />
            <Row label="Disco libre" value={`${hw.free_disk_gb.toFixed(0)} GB`} />
            <Row label="Tier recomendado" value={hw.recommendation.tier} highlight />
          </div>
        )}
      </Section>

      <Section title="Modelos Gemma 4" icon={Robot}>
        {hw && (
          <div>
            <Row label="LLM activo" value={hw.recommendation.llm_label} mono />
            <Row label="Repositorio HF" value={hw.recommendation.llm_hf_repo} mono />
            <Row label="GGUF" value={hw.recommendation.llm_gguf_file} mono />
            <Row label="Variante" value={hw.recommendation.llm_abliterated ? 'abliterated (default)' : 'oficial con filtros'} highlight />
            <Row label="Imagen" value={hw.recommendation.image} mono />
            <Row label="TTS" value={hw.recommendation.tts} mono />
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <button
            className="btn-ghost"
            style={{ color: 'var(--gold-soft)' }}
            onClick={() => navigate({ to: '/install' })}
          >
            <DownloadSimple size={13} /> Reabrir asistente de instalación
          </button>
        </div>
      </Section>

      <Section title="Verificación del stack" icon={ShieldCheck}>
        <VerifyStackPanel />
      </Section>

      <Section title="Componentes opcionales (autoinstalables)" icon={DownloadSimple} defaultOpen>
        <OptionalComponentsPanel />
      </Section>

      <Section title="Vídeo real (LTX-2.3)" icon={FilmSlate}>
        <LtxVideoPanel />
      </Section>

      <Section title="Biblioteca de música" icon={MusicNotes}>
        <MusicLibraryPanel />
      </Section>

      <Section title="Voces clonadas (Qwen3-TTS)" icon={Robot} defaultOpen>
        <VoiceClonesPanel />
      </Section>

      <Section title="Credenciales Google OAuth" icon={Key}>
        <OAuthCredentialsPanel />
      </Section>

      <Section title="YouTube" icon={YoutubeLogo}>
        <YouTubePanel />
      </Section>

      <Section title="TikTok (publicación asistida)" icon={ShareNetwork}>
        <TikTokPanel />
      </Section>

      <Section title="Variante segura del LLM (filtros oficiales)" icon={Warning}>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
          Por defecto, Xianxia Studio usa el GGUF <strong style={{ color: 'var(--text-primary)' }}>abliterated</strong> de
          Gemma 4 — sin filtros — porque genera mejor narrativa para temas oscuros del nicho.
          Si prefieres la variante oficial de Google con filtros, alterna aquí.
        </p>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <button type="button" onClick={() => setExperimental(!experimental)} className={'toggle' + (experimental ? ' on' : '')} aria-pressed={experimental} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Usar Gemma 4 oficial con filtros</div>
            <div className="caption" style={{ marginTop: 2, lineHeight: 1.5 }}>
              {experimental ? (
                <>Activado: descargará <code className="mono">unsloth/gemma-4-E4B-it-GGUF</code> al cambiar.</>
              ) : (
                'Desactivado: se usa el modelo abliterated por defecto.'
              )}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  danger,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: PhosphorIcon;
  danger?: boolean;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group"
      open={defaultOpen}
      data-testid={`section-${title.toLowerCase().split(' ')[0]}`}
      style={{ marginBottom: 12 }}
    >
      <summary
        aria-label={`Sección ${title}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 18px',
          cursor: 'default',
          listStyle: 'none',
          userSelect: 'none',
        }}
      >
        <span className="lg-tile md" style={{ '--tint': danger ? '#c8525e' : '#d4b85a' } as CSSProperties}>
          <Icon size={13} />
        </span>
        <span className="title" style={{ flex: 1 }}>{title}</span>
        <CaretRight size={13} className="chev" />
      </summary>
      <div style={{ padding: '0 18px 18px' }}>{children}</div>
    </details>
  );
}

function Row({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '0.5px solid var(--separator)' }}>
      <span className="eyebrow">{label}</span>
      <span
        className={mono ? 'mono' : undefined}
        style={{
          fontSize: mono ? 11 : 13,
          color: highlight ? 'var(--gold-soft)' : 'var(--text-primary)',
          fontWeight: highlight ? 600 : 400,
          textTransform: highlight ? 'uppercase' : 'none',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function VerifyStackPanel() {
  const { data: report, isFetching, refetch } = useQuery({
    queryKey: ['verify-stack'],
    queryFn: tauri.verifyStack,
    refetchInterval: 15000,
  });

  const grouped = (report?.checks ?? []).reduce<Record<string, CheckItem[]>>((acc, c) => {
    const g = c.group || 'Otros';
    (acc[g] = acc[g] || []).push(c);
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 13 }}>
          {report?.all_ok ? (
            <span style={{ color: 'var(--accent-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle size={15} weight="fill" />
              Todos los componentes operativos
            </span>
          ) : report?.summary ? (
            <span className="muted">
              {report.summary.models_ready_count}/{report.summary.models_total} modelos listos ·{' '}
              {report.summary.gpu_available ? '🟢 GPU' : '⚪ CPU'} ·{' '}
              {report.summary.video_hw_accelerated ? '🟢 HW codec' : '⚪ libx264'}
            </span>
          ) : (
            <span className="muted">Verificando…</span>
          )}
        </div>
        <button className="btn" onClick={() => refetch()} disabled={isFetching}>
          <ArrowsClockwise size={13} className={isFetching ? 'pulse' : ''} />
          Re-verificar
        </button>
      </div>
      {Object.entries(grouped).map(([groupName, items]) => (
        <div key={groupName} style={{ marginBottom: 16 }}>
          <h3 className="eyebrow" style={{ marginBottom: 8, fontWeight: 600 }}>{groupName}</h3>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((c) => (
              <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, padding: '6px 0', borderBottom: '0.5px solid var(--separator)' }}>
                {c.ok ? (
                  <CheckCircle size={15} weight="fill" style={{ color: 'var(--green)', flexShrink: 0 }} />
                ) : (
                  <XCircle size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>{c.label}</span>
                <span className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }} title={c.detail}>
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
      <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
        Para subir vídeos automáticamente, Xianxia Studio necesita un par
        <strong style={{ color: 'var(--text-primary)' }}> client_id / client_secret</strong> de Google
        Cloud (API YouTube Data v3 + OAuth client tipo “Desktop”). Se guardan en el
        llavero del sistema, nunca en texto plano.
      </p>

      {status?.configured && !editing ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 10, background: 'rgba(212, 184, 90,0.10)', boxShadow: '0 0 0 0.5px rgba(232, 201, 109,0.25)', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <CheckCircle size={15} weight="fill" style={{ color: 'var(--green)' }} />
            <span className="mono">{status.client_id_preview}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setEditing(true)}>Cambiar</button>
            <button className="btn-destructive" onClick={handleClear} disabled={busy}>Borrar</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 4 }}>Client ID</label>
            <input className="input mono" style={inputStyle} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abcdef.apps.googleusercontent.com" />
          </div>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 4 }}>Client Secret</label>
            <input className="input mono" style={inputStyle} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" />
          </div>
          {error && (
            <p style={{ fontSize: 11, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Warning size={13} /> {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={handleSave} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar credenciales'}
            </button>
            {status?.configured && <button className="btn" onClick={() => setEditing(false)}>Cancelar</button>}
          </div>
        </div>
      )}

      <details style={{ marginTop: 14 }}>
        <summary className="caption" style={{ cursor: 'default' }}>¿Cómo obtengo estas credenciales?</summary>
        <ol style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, marginLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.5 }}>
          <li>Crea un proyecto en console.cloud.google.com</li>
          <li>Activa la API "YouTube Data API v3"</li>
          <li>Credenciales → Create credentials → OAuth client ID → Desktop app</li>
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
        <p style={{ fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LinkSimple size={15} style={{ color: 'var(--green)' }} />
          Cuenta vinculada{yt.expires_at ? ` · token expira ${new Date(yt.expires_at * 1000).toLocaleString('es-ES')}` : ''}
        </p>
        <button className="btn-destructive" onClick={handleDisconnect}>
          <LinkBreak size={13} />
          Desconectar
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Vincula tu cuenta para subir vídeos automáticamente. Se abre el navegador con el consentimiento de Google.
      </p>
      <button className="btn-primary" onClick={handleConnect} disabled={connecting}>
        <YoutubeLogo size={13} />
        {connecting ? 'Esperando autorización…' : 'Conectar con Google'}
      </button>
      {error && (
        <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Warning size={13} /> {error}
        </p>
      )}
    </div>
  );
}

function TikTokPanel() {
  const qc = useQueryClient();
  const { data: tk } = useQuery({
    queryKey: ['tiktok-status'],
    queryFn: tauri.tiktokStatus,
    refetchInterval: 8000,
  });
  const [sessionId, setSessionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await tauri.tiktokSetSession(sessionId.trim());
      setSessionId('');
      qc.invalidateQueries({ queryKey: ['tiktok-status'] });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    await tauri.tiktokClearSession();
    qc.invalidateQueries({ queryKey: ['tiktok-status'] });
  };

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.55 }}>
        TikTok no ofrece una API de subida libre para creadores individuales. Por eso
        la integración es <strong style={{ color: 'var(--text-primary)' }}>publicación asistida</strong>:
        desde la <em>Biblioteca</em>, el botón «Publicar en TikTok» abre el subidor oficial de
        TikTok con tu vídeo vertical ya renderizado. Honesto, sin bots ni endpoints inventados.
      </p>
      <p className="caption" style={{ marginBottom: 14, lineHeight: 1.5 }}>
        Opcional: guarda tu <code className="mono">sessionid</code> (cookie de tu sesión
        iniciada en tiktok.com) en el llavero del sistema. Se reserva para una futura ruta
        oficial de Content Posting API; no se usa para automatizar subidas.
      </p>

      {tk?.configured ? (
        <div>
          <p style={{ fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={15} style={{ color: 'var(--green)' }} />
            <code className="mono">sessionid</code> guardado de forma segura en el llavero.
          </p>
          <button className="btn-destructive" onClick={handleClear}>
            <Trash size={13} />
            Borrar credencial
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460 }}>
          <input
            type="password"
            className="input"
            style={inputStyle}
            placeholder="sessionid (opcional)"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !sessionId.trim()}
            style={{ alignSelf: 'flex-start' }}
          >
            <Key size={13} />
            {saving ? 'Guardando…' : 'Guardar sessionid'}
          </button>
        </div>
      )}
      {error && (
        <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Warning size={13} /> {error}
        </p>
      )}
    </div>
  );
}

function ServiceRow({ label, status }: { label: string; status: string }) {
  const ok = status === 'running';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '0.5px solid var(--separator)' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: ok ? 'var(--accent-soft)' : 'var(--text-secondary)' }}>
        <span className={ok ? 'dot dot-running' : 'dot dot-missing'} />
        {status}
      </span>
    </div>
  );
}

function OllamaServiceRow({ ollamaStatus }: { ollamaStatus: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: tauri.appSettingsGet,
    staleTime: 60_000,
  });
  const enabled = settings?.ollama_enabled ?? false;
  const mutation = useMutation({
    mutationFn: (next: boolean) => tauri.appSettingsSetOllamaEnabled(next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['sidecars'] });
    },
  });
  return (
    <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13 }}>Ollama (alternativa avanzada · :11434)</span>
        <button
          type="button"
          onClick={() => mutation.mutate(!enabled)}
          disabled={mutation.isPending}
          className={'toggle' + (enabled ? ' on' : '')}
          aria-pressed={enabled}
          aria-label="Activar Ollama"
          style={{ opacity: mutation.isPending ? 0.6 : 1 }}
        />
      </div>
      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
          <span className="muted">Estado: {ollamaStatus === 'running' ? 'arrancado' : 'iniciando o no instalado'}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'uppercase', color: ollamaStatus === 'running' ? 'var(--accent-soft)' : 'var(--text-secondary)' }}>
            <span className={ollamaStatus === 'running' ? 'dot dot-running' : 'dot dot-missing'} />
            {ollamaStatus}
          </span>
        </div>
      )}
      {!enabled && (
        <p className="caption">
          Por defecto el pipeline usa exclusivamente llama.cpp. Activa este interruptor solo si quieres servir el LLM desde Ollama.
        </p>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        Añade pistas para que el pipeline las escoja aleatoriamente como banda sonora. MP3, M4A,
        WAV, OGG, FLAC. Se copian a la biblioteca local — el original no se mueve.
      </p>
      {lib && <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>📁 {lib.dir}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button className="btn-primary" onClick={handleAdd} disabled={busy} data-testid="music-add">
          <Plus size={12} weight="bold" /> Añadir pistas
        </button>
        <button className="btn" onClick={handleOpen}>
          <FolderOpen size={12} /> Abrir carpeta
        </button>
        <button className="btn" onClick={refresh}>
          <ArrowsClockwise size={12} /> Refrescar
        </button>
        {lib && (
          <span className="caption" style={{ marginLeft: 'auto' }}>
            {lib.tracks.length} pista{lib.tracks.length === 1 ? '' : 's'} · {formatBytes(lib.total_bytes)}
          </span>
        )}
      </div>
      {feedback && (
        <div style={{ fontSize: 11, color: 'var(--accent-soft)', background: 'rgba(212, 184, 90,0.10)', boxShadow: '0 0 0 0.5px rgba(232, 201, 109,0.25)', borderRadius: 8, padding: 10 }}>
          {feedback}
        </div>
      )}
      <div style={{ borderRadius: 10, background: 'rgba(0,0,0,0.22)', maxHeight: 256, overflowY: 'auto' }}>
        {isLoading && <div className="caption" style={{ padding: 12 }}>Cargando…</div>}
        {lib && lib.tracks.length === 0 && (
          <div className="caption" style={{ padding: 16, textAlign: 'center' }}>
            Biblioteca vacía. Pulsa <strong>Añadir pistas</strong> para empezar.
          </div>
        )}
        {lib?.tracks.map((t) => (
          <div key={t.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: '0.5px solid var(--separator)' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{t.name}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{formatBytes(t.size_bytes)}</div>
            </div>
            <button className="btn-ghost" onClick={() => handleRemove(t.name)} disabled={busy} aria-label={`Eliminar ${t.name}`} style={{ padding: 6, height: 26 }}>
              <Trash size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function VoiceClonesPanel() {
  const qc = useQueryClient();
  const { data: clones, isLoading } = useQuery({
    queryKey: ['voice-clones'],
    queryFn: tauri.listVoiceClones,
    refetchInterval: 8000,
  });

  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [primary, setPrimary] = useState<'es' | 'en' | 'zh'>('es');
  const [gender, setGender] = useState<'female' | 'male' | 'neutral'>('neutral');
  const [refText, setRefText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    setError(null);
    const sel = await openDialog({
      multiple: false,
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }],
    });
    if (typeof sel === 'string') setPickedPath(sel);
  };

  const submit = async () => {
    if (!pickedPath || !label.trim()) {
      setError('Selecciona un audio y dale un nombre.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await tauri.registerVoiceClone({
        audioPath: pickedPath,
        label: label.trim(),
        gender, primary,
        description: `Voz clonada · ${primary.toUpperCase()} · ${gender}`,
        refText: refText.trim() || undefined,
      });
      setPickedPath(null);
      setLabel('');
      setRefText('');
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await tauri.deleteVoiceClone(id);
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    } catch (e) {
      setError(String(e));
    }
  };

  const selectStyle: CSSProperties = { height: 30, appearance: 'none' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        Sube un clip de <strong>3–15 s</strong> con tu voz (o una que tengas autorización para clonar).
        Qwen3-TTS la usará para narrar en <strong>en / es / zh / ja / ko</strong> con prosodia natural.
        WAV mono 16 kHz es ideal — si subes otro formato, lo convertimos automáticamente.
      </p>

      <div style={{ borderRadius: 12, background: 'rgba(0,0,0,0.22)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Nombre</label>
            <input className="input" style={inputStyle} data-testid="clone-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Diego ES, Carmen ES, Mi voz…" />
          </div>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Idioma primario</label>
            <select className="input" style={selectStyle} value={primary} onChange={(e) => setPrimary(e.target.value as 'es' | 'en' | 'zh')}>
              <option value="es" style={{ background: '#1b1b22' }}>Español (castellano)</option>
              <option value="en" style={{ background: '#1b1b22' }}>English</option>
              <option value="zh" style={{ background: '#1b1b22' }}>中文</option>
            </select>
          </div>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Tono</label>
            <select className="input" style={selectStyle} value={gender} onChange={(e) => setGender(e.target.value as 'female' | 'male' | 'neutral')}>
              <option value="neutral" style={{ background: '#1b1b22' }}>Neutral</option>
              <option value="female" style={{ background: '#1b1b22' }}>Femenina</option>
              <option value="male" style={{ background: '#1b1b22' }}>Masculina</option>
            </select>
          </div>
          <div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Texto del clip (opcional)</label>
            <input className="input" style={inputStyle} value={refText} onChange={(e) => setRefText(e.target.value)} placeholder="Transcripción exacta del clip…" />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn" onClick={pick} data-testid="clone-pick">
            <Plus size={12} weight="bold" /> Elegir audio
          </button>
          {pickedPath && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }} title={pickedPath}>
              {pickedPath.split(/[\\/]/).pop()}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn-primary" onClick={submit} data-testid="clone-submit" disabled={busy || !pickedPath || !label.trim()}>
            {busy ? <ArrowsClockwise size={13} className="pulse" /> : <Plus size={13} weight="bold" />}
            {busy ? 'Subiendo y procesando…' : 'Registrar voz'}
          </button>
        </div>

        {error && (
          <div style={{ padding: 10, borderRadius: 8, background: 'var(--red-bg)', boxShadow: '0 0 0 0.5px rgba(200,82,94,0.45)', fontSize: 11, display: 'flex', gap: 8 }}>
            <Warning size={14} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="clone-list">
        {isLoading && <div className="caption">Cargando voces clonadas…</div>}
        {!isLoading && (clones ?? []).length === 0 && (
          <div className="caption" style={{ fontStyle: 'italic' }}>No hay voces clonadas todavía.</div>
        )}
        {(clones ?? []).map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.label} <span style={{ fontSize: 11, color: 'var(--gold-soft)', marginLeft: 4 }}>·{c.primary.toUpperCase()}·{c.gender}</span>
              </div>
              <div className="caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.description || 'sin descripción'} {c.duration_seconds && ` · ${c.duration_seconds.toFixed(1)} s`}
              </div>
            </div>
            <button className="btn-ghost" onClick={() => remove(c.id)} aria-label={`Borrar ${c.label}`} style={{ padding: 6, height: 26 }}>
              <Trash size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionalComponentsPanel() {
  const qc = useQueryClient();
  const { data: stack, refetch } = useQuery({
    queryKey: ['verify-stack'],
    queryFn: tauri.verifyStack,
    refetchInterval: 5_000,
  });
  const summary = stack?.summary as Record<string, boolean | number> | undefined;

  const FEATURES: { id: string; label: string; desc: string; size: string; check: () => boolean }[] = [
    {
      id: 'python-deps-engagement',
      label: 'TRIBE v2 (Meta · engagement con neurociencia in-silico)',
      desc: 'Predice respuestas fMRI y mapea a redes funcionales. Detecta valles aburridos y permite auto-optimización. CC-BY-NC-4.0.',
      size: '~12 GB',
      check: () => Boolean(summary?.tribe_installed),
    },
    {
      id: 'python-deps-music',
      label: 'MusicGen-medium (música GPU-only)',
      desc: 'Generación local de música cinematográfica con MusicGen-medium fp16 (~3.5 GB VRAM). Long-form vía chunks + crossfade.',
      size: '~3-4 GB',
      check: () => Boolean(summary?.musicgen_installed),
    },
    {
      id: 'python-deps-vision',
      label: 'Vision stack (rembg + MediaPipe + YOLO11)',
      desc: 'Segmentación + parallax 2.5D + subject tracking para Shorts. Necesario para reframe vertical inteligente.',
      size: '~720 MB',
      check: () => Boolean(summary?.rembg_installed) && Boolean(summary?.ultralytics_installed),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="optional-components">
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        Componentes opcionales que enriquecen el pipeline. Se instalan desde aquí sin terminal:
        la app reinicia el sidecar Python al terminar y los activa automáticamente.
      </p>
      {FEATURES.map((f) => (
        <FeatureCard key={f.id} feature={f} onInstalled={() => { refetch(); qc.invalidateQueries({ queryKey: ['verify-stack'] }); }} />
      ))}
    </div>
  );
}

function FeatureCard({
  feature,
  onInstalled,
}: {
  feature: { id: string; label: string; desc: string; size: string; check: () => boolean };
  onInstalled: () => void;
}) {
  const installed = feature.check();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    let unlisten: (() => void) | null = null;
    events.onInstallProgress((p) => {
      if (p.component === feature.id) {
        setProgress(`${p.status} · ${p.percent.toFixed(0)}% · ${p.message ?? ''}`);
      }
    }).then((u) => (unlisten = u));
    return () => { unlisten?.(); };
  }, [busy, feature.id]);

  const install = async () => {
    setBusy(true); setError(null); setProgress('Iniciando…');
    try {
      await tauri.installOptionalComponent(feature.id);
      setProgress('Instalado. Reiniciando sidecar Python…');
      setTimeout(() => { onInstalled(); setBusy(false); setProgress(''); }, 5_000);
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div
      data-testid={`feature-${feature.id}`}
      style={{
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        background: 'rgba(255,255,255,0.04)',
        boxShadow: installed ? '0 0 0 0.5px rgba(127, 168, 216,0.35)' : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h4 style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{feature.label}</h4>
          <span className="caption" style={{ fontSize: 10 }}>· {feature.size}</span>
          {installed && (
            <span style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--accent-soft)', background: 'rgba(212, 184, 90,0.15)', padding: '1px 6px', borderRadius: 4 }}>
              ✓ Instalado
            </span>
          )}
        </div>
        <p className="caption" style={{ marginTop: 4, lineHeight: 1.5 }}>{feature.desc}</p>
        {progress && <div className="mono" style={{ fontSize: 11, color: 'var(--gold-soft)', marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress}</div>}
        {error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8 }}>{error}</div>}
      </div>
      {!installed && (
        <button className="btn-primary" onClick={install} disabled={busy} data-testid={`install-${feature.id}`}>
          {busy ? <ArrowsClockwise size={13} className="pulse" /> : <DownloadSimple size={13} />}
          {busy ? 'Instalando…' : 'Instalar'}
        </button>
      )}
    </div>
  );
}

// ── v0.6.0 — LTX-2.3 informative + install panel ────────────────────────────

function LtxVideoPanel() {
  const qc = useQueryClient();
  const { data: cap } = useQuery<LtxCapability>({
    queryKey: ['ltx-capability'],
    queryFn: tauri.ltxCapability,
    staleTime: 10 * 60_000,
  });
  const { data: installed, refetch: refetchInstalled } = useQuery<boolean>({
    queryKey: ['ltx-models-installed'],
    queryFn: tauri.ltxModelsInstalled,
    staleTime: 30_000,
    refetchInterval: (q) => {
      if (!cap || cap === 'none') return false;
      if (q.state.data === true) return false;
      return 10_000;
    },
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const capLabel =
    !cap || cap === 'none'
      ? 'No disponible (requiere ≥ 24 GB VRAM · tu GPU no cumple el mínimo)'
      : cap === 'gguf'
      ? 'GGUF cuantizado (≥ 24 GB VRAM) · detectado'
      : 'Completo fp8 (≥ 32 GB VRAM) · detectado';

  const handleInstall = async () => {
    setBusy(true); setError(null); setProgress('Iniciando…');
    try {
      await tauri.installOptionalComponent('ltx23-video');
      setProgress('Instalado. Verificando modelos…');
      await refetchInstalled();
      qc.invalidateQueries({ queryKey: ['ltx-models-installed'] });
      setProgress('');
    } catch (e) {
      setError(String(e));
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        LTX-2.3 es el motor de vídeo neuronal de Lightricks. Requiere mínimo{' '}
        <strong style={{ color: 'var(--text-primary)' }}>24 GB VRAM</strong> (GGUF Q4) o{' '}
        <strong style={{ color: 'var(--text-primary)' }}>32 GB VRAM</strong> (fp8 completo).
        En equipos no compatibles el pipeline siempre usa <strong style={{ color: 'var(--text-primary)' }}>
        Imágenes + HyperFrames</strong> (motor por defecto, sin cambios).
      </p>
      <Row label="Capacidad detectada" value={capLabel} highlight={cap !== undefined && cap !== 'none'} />
      {cap && cap !== 'none' && (
        <>
          <Row
            label="Modelos instalados"
            value={installed === undefined ? '…' : installed ? '✓ Sí' : '✗ No — pendiente de descarga'}
            highlight={installed === true}
          />
          <div
            data-testid="ltx-settings-feature"
            style={{
              borderRadius: 10,
              padding: 12,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              background: 'rgba(255,255,255,0.04)',
              boxShadow: installed ? '0 0 0 0.5px rgba(127, 168, 216,0.35)' : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h4 style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>LTX-2.3 ({cap === 'gguf' ? 'GGUF Q4_K_M' : 'fp8'})</h4>
                <span className="caption" style={{ fontSize: 10 }}>· {cap === 'gguf' ? '≈60 GB' : '≈70 GB'}</span>
                {installed && (
                  <span style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--accent-soft)', background: 'rgba(212, 184, 90,0.15)', padding: '1px 6px', borderRadius: 4 }}>
                    ✓ Instalado
                  </span>
                )}
              </div>
              <p className="caption" style={{ marginTop: 4, lineHeight: 1.5 }}>
                Motor de vídeo neuronal real. Actívalo por vídeo desde el Generador una vez instalado.
                El motor por defecto (Imágenes + HyperFrames) no se modifica.
              </p>
              {progress && (
                <div className="mono" style={{ fontSize: 11, color: 'var(--gold-soft)', marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {progress}
                </div>
              )}
              {error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8 }}>{error}</div>}
            </div>
            {!installed && (
              <button className="btn-primary" onClick={handleInstall} disabled={busy} data-testid="ltx-install-settings-btn">
                {busy ? <ArrowsClockwise size={13} className="pulse" /> : <DownloadSimple size={13} />}
                {busy ? 'Instalando…' : 'Instalar'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LlmModelPanel() {
  const qc = useQueryClient();
  const llStatus = useQuery({ queryKey: ['llamacpp', 'status'], queryFn: tauri.llamacppStatus, refetchInterval: 5000 });
  const { data: sidecars } = useQuery<SidecarState>({
    queryKey: ['sidecars'],
    queryFn: tauri.getSidecarState,
    refetchInterval: 4000,
  });
  const localModels = useQuery({ queryKey: ['llm', 'local'], queryFn: tauri.llmListLocal });
  const active = useQuery({ queryKey: ['llm', 'active'], queryFn: tauri.llmGetActive });
  const [query, setQuery] = useState('');
  const [hfResults, setHfResults] = useState<Awaited<ReturnType<typeof tauri.llmSearchHf>>>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const autoInstalling = !llStatus.data?.installed && sidecars?.llamacpp === 'starting';

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['llm'] });
    qc.invalidateQueries({ queryKey: ['llamacpp'] });
  };

  async function handleSearch() {
    setSearching(true);
    try { setHfResults(await tauri.llmSearchHf(query, 30)); }
    catch (e) { alert(`HF search falló: ${e}`); }
    finally { setSearching(false); }
  }

  const card: CSSProperties = { borderRadius: 12, padding: 12, background: 'rgba(255,255,255,0.04)', boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.06)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="eyebrow">Runtime</div>
            <div style={{ fontWeight: 500 }}>
              {llStatus.data?.installed
                ? `llama.cpp ${llStatus.data.current?.version ?? llStatus.data.recommended_tag} · ${llStatus.data.flavor_label}`
                : autoInstalling
                  ? `Instalando llama.cpp ${llStatus.data?.recommended_tag ?? 'b9114'} en segundo plano…`
                  : 'llama.cpp no instalado'}
            </div>
            {!llStatus.data?.installed && !autoInstalling && (
              <div className="caption" style={{ marginTop: 2 }}>
                Se instalará automáticamente cuando haya un GGUF disponible. Pulsa el botón para forzarlo ahora.
              </div>
            )}
          </div>
          {!llStatus.data?.installed && !autoInstalling && (
            <button
              className="btn-primary"
              disabled={installing}
              onClick={async () => {
                setInstalling(true);
                try {
                  await tauri.llamacppInstall();
                  refreshAll();
                } catch (e) {
                  alert(`No se pudo instalar llama.cpp: ${e}`);
                } finally {
                  setInstalling(false);
                }
              }}
            >
              {installing ? <ArrowsClockwise size={13} className="pulse" /> : <DownloadSimple size={13} />}
              {installing ? 'Descargando…' : `Forzar (${llStatus.data?.recommended_tag ?? 'b9114'})`}
            </button>
          )}
          {autoInstalling && <ArrowsClockwise size={15} className="pulse" style={{ color: 'var(--gold-soft)' }} />}
        </div>
      </div>

      <div style={card}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Modelo activo</div>
        {active.data ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontWeight: 500 }}>{active.data.model_id}</div>
            <div className="caption">
              {active.data.architecture ?? '?'} · {active.data.quantization ?? '?'} · ctx {active.data.context_size} · ngl {active.data.gpu_layers}
              {active.data.flash_attention ? ' · FA' : ''}
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.data.gguf_path}</div>
          </div>
        ) : (
          <div className="muted" style={{ fontStyle: 'italic' }}>Ninguno — selecciona o descarga uno abajo.</div>
        )}
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>GGUFs en disco</span>
          <button onClick={refreshAll} style={{ color: 'var(--text-tertiary)' }}><ArrowsClockwise size={12} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 192, overflowY: 'auto' }}>
          {(localModels.data ?? []).map((m) => {
            const isActive = active.data?.gguf_path === m.path;
            return (
              <div
                key={m.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: 8,
                  borderRadius: 8,
                  fontSize: 11.5,
                  background: 'rgba(255,255,255,0.04)',
                  boxShadow: isActive ? '0 0 0 0.5px rgba(212,184,90,0.40)' : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.filename}</div>
                  <div className="muted">{m.architecture ?? '?'} · {m.quantization ?? '?'} · {formatBytes(m.size_bytes)}</div>
                </div>
                {!isActive && (
                  <button
                    className="btn"
                    disabled={busyPath === m.path}
                    onClick={async () => {
                      setBusyPath(m.path);
                      try { await tauri.llmActivate(m.path); refreshAll(); }
                      catch (e) { alert(`No se pudo activar: ${e}`); }
                      finally { setBusyPath(null); }
                    }}
                  >
                    {busyPath === m.path ? 'Activando…' : 'Activar'}
                  </button>
                )}
                {isActive && <span style={{ color: 'var(--gold-soft)', fontSize: 10, textTransform: 'uppercase' }}>Activo</span>}
              </div>
            );
          })}
          {(localModels.data ?? []).length === 0 && (
            <div className="muted" style={{ fontStyle: 'italic', fontSize: 11.5 }}>Sin GGUFs descargados todavía.</div>
          )}
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Buscar en HuggingFace</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, height: 28 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="gemma, qwen, mistral, llama 3.1…"
          />
          <button className="btn" onClick={handleSearch} disabled={searching}>
            {searching ? <ArrowsClockwise size={13} className="pulse" /> : <Sparkle size={13} />}
            Buscar
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 240, overflowY: 'auto' }}>
          {hfResults.map((r) => <HfRepoRow key={r.repo_id} repo={r} onDownloaded={refreshAll} />)}
        </div>
      </div>
    </div>
  );
}

type Fit = 'fits' | 'tight' | 'spill' | 'too-big' | 'unknown';

function estimateFit(fileSizeBytes: number | null, vramGb: number, ramGb: number): Fit {
  if (!fileSizeBytes) return 'unknown';
  const sizeGb = fileSizeBytes / 1_073_741_824;
  if (vramGb > 0) {
    if (sizeGb <= vramGb * 0.7) return 'fits';
    if (sizeGb <= vramGb * 0.95) return 'tight';
  }
  if (ramGb > 0 && sizeGb <= ramGb * 0.6) return 'spill';
  return 'too-big';
}

function FitBadge({ fit, sizeGb }: { fit: Fit; sizeGb: number | null }) {
  const cfg: Record<Fit, { label: string; color: string; bg: string; tip: string }> = {
    fits: { label: '✓ Cabe en GPU', color: 'var(--accent-soft)', bg: 'rgba(212, 184, 90,0.18)', tip: 'Carga completa en VRAM con margen para KV cache' },
    tight: { label: '⚠ Justo en GPU', color: 'var(--gold-soft)', bg: 'var(--gold-bg)', tip: 'Cabe en VRAM pero sin margen — context largo puede forzar offload parcial' },
    spill: { label: '⊟ CPU offload', color: 'var(--gold-soft)', bg: 'rgba(168,138,60,0.22)', tip: 'No cabe completo en GPU — algunas capas en CPU. Lento (~3-5 tok/s)' },
    'too-big': { label: '✗ Demasiado grande', color: '#ffb1b8', bg: 'var(--red-bg)', tip: 'No cabe ni en VRAM ni en RAM cómodamente. No recomendado.' },
    unknown: { label: '? Tamaño desconocido', color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.08)', tip: 'HuggingFace no expone el size en este repo' },
  };
  const c = cfg[fit];
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap', color: c.color, background: c.bg }}
      title={`${c.tip}${sizeGb ? ` · ${sizeGb.toFixed(2)} GB` : ''}`}
    >
      {c.label}
    </span>
  );
}

function HfRepoRow({ repo, onDownloaded }: { repo: { repo_id: string; downloads: number; likes: number }; onDownloaded: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const files = useQuery({
    queryKey: ['hf-files', repo.repo_id],
    queryFn: () => tauri.llmListRepoFiles(repo.repo_id),
    enabled: expanded,
  });
  const { data: hw } = useQuery({
    queryKey: ['hardware'],
    queryFn: tauri.detectHardware,
    staleTime: 5 * 60_000,
    enabled: expanded,
  });
  const [downloading, setDownloading] = useState<string | null>(null);
  const vramGb = hw?.gpu?.vram_gb ?? 0;
  const ramGb = hw?.total_ram_gb ?? 0;
  return (
    <div style={{ borderRadius: 8, background: 'rgba(255,255,255,0.04)', padding: 8, fontSize: 11.5 }}>
      <button onClick={() => setExpanded((v) => !v)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.repo_id}</span>
        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>↓ {repo.downloads.toLocaleString()} · ♥ {repo.likes}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {hw && (
            <div className="caption" style={{ fontSize: 10, padding: '0 4px 4px' }}>
              Tu hardware: {hw.gpu?.name ?? 'sin GPU'} · {vramGb.toFixed(1)} GB VRAM · {ramGb.toFixed(0)} GB RAM
            </div>
          )}
          {files.isLoading && <div className="muted" style={{ fontStyle: 'italic' }}>Cargando ficheros…</div>}
          {(files.data ?? []).map((f) => {
            const fit = estimateFit(f.size_bytes, vramGb, ramGb);
            const sizeGb = f.size_bytes ? f.size_bytes / 1_073_741_824 : null;
            return (
              <div key={f.filename} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 6, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                  <div style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                    <span>{f.quantization ?? '?'}{f.size_bytes ? ` · ${formatBytes(f.size_bytes)}` : ''}</span>
                    <FitBadge fit={fit} sizeGb={sizeGb} />
                  </div>
                </div>
                <button
                  className="btn-primary"
                  disabled={downloading === f.filename}
                  onClick={async () => {
                    if (fit === 'too-big') {
                      if (!confirm('Este modelo NO cabe cómodamente en tu hardware. ¿Descargar de todas formas?')) return;
                    }
                    setDownloading(f.filename);
                    try {
                      const dl = await tauri.llmDownload(repo.repo_id, f.filename);
                      await tauri.llmActivate(dl.path);
                      onDownloaded();
                    } catch (e) { alert(`Descarga falló: ${e}`); }
                    finally { setDownloading(null); }
                  }}
                >
                  {downloading === f.filename ? 'Descargando…' : 'Descargar + activar'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
