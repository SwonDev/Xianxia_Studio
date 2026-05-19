/**
 * Voice Wizard — v0.1.24
 *
 * 3-tab modal for creating a new voice clone:
 *   1) Microphone — record live with WebAudio MediaRecorder
 *   2) File      — upload audio/video from disk
 *   3) URL       — paste a YouTube / TikTok / Twitch / etc URL
 *
 * After acquisition the entire pipeline runs server-side
 *   ingest → vocal isolation → denoise → VAD trim → loudness norm →
 *   16 kHz mono → auto-register in /tts/clones manifest
 * and the new voice appears immediately in the picker dropdown.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Upload, Link as LinkIcon, X, Check, Loader2 } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { useToast } from '@/components/toast';

type Mode = 'mic' | 'file' | 'url';

interface VoiceWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (cloneId: string) => void;
  defaultPrimary?: string;
}

export function VoiceWizard({ open, onClose, onCreated, defaultPrimary = 'es' }: VoiceWizardProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>('mic');
  const [label, setLabel] = useState('');
  const [primary, setPrimary] = useState(defaultPrimary);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');

  // ── Mic recording ─────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordSecs, setRecordSecs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<number | null>(null);

  // ── File upload ───────────────────────────────────────────────
  const [pickedFile, setPickedFile] = useState<File | null>(null);

  // ── URL input ─────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [startSeconds, setStartSeconds] = useState<number | undefined>();
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>();

  useEffect(() => {
    if (!open) {
      // Reset on close
      setMode('mic');
      setLabel('');
      setPrimary(defaultPrimary);
      setBusy(false);
      setProgress('');
      setRecording(false);
      setRecordedBlob(null);
      setRecordSecs(0);
      setPickedFile(null);
      setUrl('');
      setStartSeconds(undefined);
      setDurationSeconds(undefined);
    }
  }, [open, defaultPrimary]);

  if (!open) return null;

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        setRecordedBlob(blob);
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
      setRecordSecs(0);
      recordTimerRef.current = window.setInterval(() => setRecordSecs((s) => s + 1), 1000);
    } catch (e) {
      toast.error('Micrófono no disponible', String(e));
    }
  };
  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
  };

  const submit = async () => {
    if (!label.trim()) {
      toast.error('Nombre de la voz obligatorio', 'Pon un nombre que la identifique en el dropdown');
      return;
    }
    setBusy(true);
    setProgress('Procesando audio…');
    try {
      let result;
      if (mode === 'mic') {
        if (!recordedBlob) {
          toast.error('Graba al menos 5 s de tu voz primero');
          setBusy(false);
          return;
        }
        result = await tauri.voiceAcquireFromFile({
          file: recordedBlob,
          fileName: 'mic.webm',
          label,
          primary,
        });
      } else if (mode === 'file') {
        if (!pickedFile) {
          toast.error('Selecciona un archivo audio o vídeo primero');
          setBusy(false);
          return;
        }
        result = await tauri.voiceAcquireFromFile({
          file: pickedFile,
          fileName: pickedFile.name,
          label,
          primary,
        });
      } else {
        if (!url.trim().startsWith('http')) {
          toast.error('URL inválida', 'Pega una URL de YouTube, TikTok, Twitch, etc.');
          setBusy(false);
          return;
        }
        result = await tauri.voiceAcquireFromUrl({
          url,
          label,
          primary,
          startSeconds,
          durationSeconds,
        });
      }
      const stages = result.pipeline_steps.map((s) => `${s.stage}:${s.method}`).join(' → ');
      setProgress(`✓ ${result.duration_seconds.toFixed(1)}s · ${stages}`);
      toast.success(
        'Voz creada y registrada',
        `${label} (${result.duration_seconds.toFixed(1)} s) · lista para usar`,
      );
      onCreated(result.clone_id);
      onClose();
    } catch (e) {
      toast.error('No se pudo crear la voz', String(e).slice(0, 200));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-white">Crear voz clonada</h2>
          <button onClick={onClose} disabled={busy}
                  className="text-zinc-400 hover:text-white disabled:opacity-30">
            <X className="size-5" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex gap-2 mb-5">
          {([
            ['mic', 'Grabar', Mic],
            ['file', 'Archivo', Upload],
            ['url', 'URL', LinkIcon],
          ] as const).map(([m, lbl, Icon]) => (
            <button
              key={m}
              disabled={busy}
              onClick={() => setMode(m)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl
                          font-medium transition disabled:opacity-30
                          ${mode === m
                            ? 'bg-amber-500 text-black'
                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            >
              <Icon className="size-4" />
              {lbl}
            </button>
          ))}
        </div>

        {/* Mode body */}
        <div className="min-h-[180px] mb-5">
          {mode === 'mic' && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                Graba 10-20 s de tu voz hablando con normalidad. Cuanto más limpio
                el sonido, mejor el clon.
              </p>
              {!recording && !recordedBlob && (
                <button
                  onClick={startRecording}
                  className="w-full py-3 bg-red-600 hover:bg-red-500 rounded-xl
                             flex items-center justify-center gap-2 text-white font-semibold"
                >
                  <Mic className="size-5" /> Empezar grabación
                </button>
              )}
              {recording && (
                <button
                  onClick={stopRecording}
                  className="w-full py-3 bg-red-700 hover:bg-red-600 rounded-xl
                             flex items-center justify-center gap-2 text-white font-semibold"
                >
                  <span className="size-3 bg-white rounded animate-pulse" />
                  Grabando… {recordSecs} s · pulsa para parar
                </button>
              )}
              {recordedBlob && !recording && (
                <div className="space-y-2">
                  <div className="text-emerald-400 flex items-center gap-2 text-sm">
                    <Check className="size-4" /> Grabación lista ({recordSecs}s, {(recordedBlob.size / 1024).toFixed(0)} KB)
                  </div>
                  <button
                    onClick={() => { setRecordedBlob(null); setRecordSecs(0); }}
                    className="text-xs text-zinc-400 hover:text-white"
                  >
                    Volver a grabar
                  </button>
                </div>
              )}
            </div>
          )}

          {mode === 'file' && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                Sube cualquier audio o vídeo (mp3, wav, mp4, mkv, m4a, opus…).
                Extraemos solo la voz automáticamente.
              </p>
              <label className="block">
                <input
                  type="file"
                  accept="audio/*,video/*"
                  onChange={(e) => setPickedFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
                <span className="block text-center py-6 border-2 border-dashed border-zinc-700
                                 rounded-xl cursor-pointer hover:bg-zinc-800/50">
                  {pickedFile ? (
                    <>
                      <Check className="size-5 text-emerald-400 inline mr-2" />
                      {pickedFile.name} ({(pickedFile.size / (1024 * 1024)).toFixed(1)} MB)
                    </>
                  ) : (
                    <>
                      <Upload className="size-5 inline mr-2" />
                      Pulsa para seleccionar archivo
                    </>
                  )}
                </span>
              </label>
            </div>
          )}

          {mode === 'url' && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                Pega un enlace de YouTube, TikTok, Twitch, Vimeo, etc.
                Bajamos el audio y extraemos la voz automáticamente.
              </p>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl
                           text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500"
              />
              <details className="text-sm text-zinc-400">
                <summary className="cursor-pointer hover:text-white">Solo un fragmento (opcional)</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-xs">
                    Inicio (s)
                    <input
                      type="number" min="0" step="0.1"
                      value={startSeconds ?? ''}
                      onChange={(e) => setStartSeconds(e.target.value ? parseFloat(e.target.value) : undefined)}
                      className="mt-1 w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-white"
                    />
                  </label>
                  <label className="text-xs">
                    Duración (s)
                    <input
                      type="number" min="3" step="0.1"
                      value={durationSeconds ?? ''}
                      onChange={(e) => setDurationSeconds(e.target.value ? parseFloat(e.target.value) : undefined)}
                      className="mt-1 w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-white"
                    />
                  </label>
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Common fields */}
        <div className="space-y-2 mb-4">
          <label className="block text-sm">
            <span className="text-zinc-400">Nombre de la voz</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder="Ej. Diego ES, Mi voz, Narrador épico…"
              className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl
                         text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">Idioma principal</span>
            <select
              value={primary}
              onChange={(e) => setPrimary(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl
                         text-white focus:outline-none focus:border-amber-500"
            >
              <option value="es">Español</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="de">Deutsch</option>
              <option value="fr">Français</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
              <option value="it">Italiano</option>
            </select>
          </label>
        </div>

        {progress && (
          <div className="text-xs text-zinc-400 mb-3 truncate">{progress}</div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-zinc-400 hover:text-white disabled:opacity-30"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-6 py-2 bg-amber-500 text-black font-semibold rounded-xl
                       hover:bg-amber-400 disabled:opacity-50 flex items-center gap-2"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? 'Procesando…' : 'Crear voz'}
          </button>
        </div>
      </div>
    </div>
  );
}
