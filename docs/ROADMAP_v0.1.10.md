# Roadmap v0.1.10 — Observabilidad y diagnóstico

Status: **planificado** · Target: tras v0.1.9

v0.1.10 introduce la infraestructura de observabilidad necesaria para
diagnosticar el pipeline en producción de un solo vistazo, y resuelve
el bug residual del `postProcessCinematic` que persiste desde v0.1.7
(HyperFrames produce `video.base.mp4` pero el post-pass cinematic deja
`video.mp4` a 0 bytes silenciosamente).

Es deuda operacional que **debe ir antes de v0.2.0 long-form** porque
sin logs estructurados no se puede diagnosticar fallos en pipelines de
30+ min.

---

## Filosofía

El usuario no debe nunca tener que adivinar qué hace la app. Y un
agente externo (Claude, otro dev) debe poder leer un único stream de
eventos y reconstruir QUÉ pasó, en QUÉ fase, con QUÉ modelos, en QUÉ
estado de VRAM, en CUÁNTO tiempo.

Logs actuales (v0.1.9):
- `sidecar-py.log` — uvicorn texto plano sin timestamp ISO + algunos prints
- `sidecar-node.log` — Pino con ANSI escape codes
- `comfyui.log` — texto plano del proceso ComfyUI con barras tqdm

Problemas:
- Imposible reconstruir un run completo (no hay request_id que correlacione)
- Sin timestamps ISO uniformes
- Subprocess errors (ffmpeg, hyperframes) se tragan o se loggean fragmentado
- VRAM solo se ve si polleas /system_stats manualmente
- Logs crecen indefinidamente sin rotation

---

## Arquitectura del logging v0.1.10

```
<cache_dir>/logs/
├── pipeline-rust.jsonl       ← supervisor, pipeline phases, fallbacks
├── sidecar-py.jsonl          ← Python FastAPI middleware + handlers
├── sidecar-node.jsonl        ← Node Fastify pino + execa stderr
├── comfyui.jsonl             ← ComfyUI stdout parsed a JSONL
├── vram.jsonl                ← snapshot cada 30s (system_stats + api/ps + cuda)
└── archive/                  ← gzip de logs > 7 días
    └── pipeline-rust-2026-W18.jsonl.gz
```

### Schema común JSONL

Cada línea es un objeto JSON con campos comunes:

```json
{
  "ts": "2026-05-07T05:13:00.123Z",
  "level": "info",                      // debug|info|warn|error|fatal
  "source": "rust|python|node|comfyui|vram",
  "project_id": "01KR0A...",            // opcional
  "phase": 4,                            // opcional, 1-10
  "request_id": "req-3cq",               // correlación cross-source
  "message": "Image 2/5 generated",
  "duration_ms": 70530,                  // opcional
  "vram_free_gb": 4.87,                  // opcional
  "error": { "type": "...", "stack": "..." },  // opcional
  "fields": { ... }                      // resto context-specific
}
```

---

## Componentes

### 1. Sidecar Python — middleware FastAPI

```python
@app.middleware("http")
async def request_id_logger(request, call_next):
    rid = uuid7()
    start = time.monotonic()
    response = await call_next(request)
    duration_ms = (time.monotonic() - start) * 1000
    log.info({
        "request_id": rid,
        "method": request.method,
        "path": request.url.path,
        "status": response.status_code,
        "duration_ms": duration_ms,
        "client_port": request.client.port,
    })
    return response
```

Plus:
- Logger de pipeline phases (`phase_started`, `phase_done` con `duration_ms`)
- Wrapper `subprocess_logged()` que captura stdout+stderr+exit_code completo
- Captura excepciones del handler con stack trace

### 2. Sidecar Node — Pino con execa stderr capture

```ts
// Antes:
await execa('ffmpeg', cmd, { stdio: 'inherit' });

// Después:
const result = await execa('ffmpeg', cmd, { all: true });
logger.info({
  cmd: 'ffmpeg',
  args: cmd,
  durationMs: result.durationMs,
  exitCode: result.exitCode,
  stdout_tail: result.stdout?.slice(-500),
  stderr_tail: result.stderr?.slice(-500),
}, 'ffmpeg post-pass complete');
```

Para `runHyperFrames` y `postProcessCinematic`: captura todo y log
estructurado en lugar de tirarlo a la consola sin timestamp.

### 3. Pipeline Rust — tracing-subscriber JSONL

```rust
use tracing_subscriber::fmt::format::FmtSpan;

let log_path = cache_dir.join("logs").join("pipeline-rust.jsonl");
let file = std::fs::OpenOptions::new()
    .create(true).append(true).open(&log_path)?;

tracing_subscriber::fmt()
    .json()
    .with_writer(Mutex::new(file))
    .with_span_events(FmtSpan::CLOSE)  // tiempo de cada span
    .with_target(true)
    .with_thread_ids(true)
    .init();
```

Más uso disciplinado de `#[instrument(fields(project_id, phase, model))]`
en cada paso del pipeline para que cada operación deje un span con
duración y campos.

### 4. VRAM monitor periódico

Tarea async que cada 30s captura:

```json
{
  "ts": "2026-05-07T05:13:00.123Z",
  "source": "vram",
  "comfyui": { "vram_free_gb": 6.94, "vram_total_gb": 8.0 },
  "ollama": [{ "name": "xianxia-llm:latest", "size_vram_gb": 5.94 }],
  "python_cuda": { "free_gb": 4.21, "total_gb": 8.0 },
  "process_metrics": [
    { "pid": 67916, "name": "python.exe", "ram_mb": 1536, "cpu_pct": 432 }
  ]
}
```

Permite ver evolución VRAM minuto a minuto y detectar:
- Modelos que no se descargan tras unload (regresion test)
- Spikes en mid-pipeline
- Race conditions en handoff entre fases

### 5. Log rotation `logs_janitor.rs`

```rust
fn rotate_and_archive(cache_dir: &Path) -> Result<()> {
    let now = Utc::now();
    for entry in fs::read_dir(cache_dir.join("logs"))? {
        let path = entry?.path();
        if !path.is_file() { continue; }
        let mtime = fs::metadata(&path)?.modified()?;
        let age_days = (now - mtime).num_days();
        if age_days > 7 && !path.extension().map_or(false, |e| e == "gz") {
            archive_gzip(&path, cache_dir.join("logs/archive"))?;
            fs::remove_file(&path)?;
        }
    }
    // Cleanup archive > 28 days
    for entry in fs::read_dir(cache_dir.join("logs/archive"))? {
        let path = entry?.path();
        let mtime = fs::metadata(&path)?.modified()?;
        if (now - mtime).num_days() > 28 {
            fs::remove_file(&path).ok();
        }
    }
    Ok(())
}
```

Llamado desde el `setup` hook al arrancar la app. Idempotente. Total
disk cap: ~50 MB recientes + ~30 MB archive comprimido.

### 6. Endpoint `/diag/snapshot`

```
POST /diag/snapshot
{
  "project_id": "01KR0A...",         // opcional, filtra por proyecto
  "since": "2026-05-07T05:13:00Z",   // opcional
  "level": "info",                    // opcional, mínimo
  "max_lines": 5000,                  // default
  "sources": ["rust","python","node","comfyui","vram"]  // default todas
}

Response:
{
  "lines": [ ... JSONL parseado ... ],
  "summary": {
    "by_phase": { "1": 12, "4": 87, ... },
    "errors": 3,
    "vram_min_free_gb": 0.42
  }
}
```

Permite a Claude (o cualquier dev) hacer `curl http://127.0.0.1:8731/diag/snapshot` y obtener una vista completa de un run en una sola llamada.

---

## Bug residual a resolver: `postProcessCinematic` 0 bytes

Síntoma: tras los runs 6, 7, 8 (v0.1.7, v0.1.8, v0.1.9) el sidecar
Node produce `video.base.mp4` correctamente vía HyperFrames, pero
`postProcessCinematic` (la pasada FFmpeg de cinematic + audio mix
+ ducking) deja `video.mp4` a 0 bytes. El pipeline cae al fallback
Python `/render` que produce `video-XXX.mp4` (zoompan + xfade
básicos, sin parallax 2.5D ni atmospherics).

`preferLocal: true` no fue suficiente. Hipótesis pendientes de
verificar (con los logs JSONL nuevos será trivial):

1. **PATH propagation no llega al subprocess de execa**: aunque
   `preferLocal:true` añade `node_modules/.bin` al PATH del subprocess
   inmediato, ffmpeg podría estar resolviéndose a un binario que no
   existe (un shim) o el PATH ampliado no se aplica en algún spawn
2. **out_path en NTFS bloqueado**: ffmpeg podría no poder escribir
   sobre el path porque otro proceso (Windows Defender / antivirus)
   tiene el archivo abierto en ese instante
3. **stdio inherit interfiere**: `stdio: 'inherit'` puede causar que
   el subprocess herede pipes del Node sidecar y al cerrarse mate
   ffmpeg antes de flush
4. **Race con frame-extract de Phase 7**: si el supervisor lanza
   Phase 7 thumbnail mientras ffmpeg post-pass aún escribe, podría
   haber contención GPU/disk

Plan de fix:
1. Añadir tracing detallado a `runHyperFrames` + `postProcessCinematic`
   con `execa({ all: true })` y log completo de stdout/stderr/exit
2. Resolver ruta absoluta de ffmpeg al boot del sidecar Node
   (`which.sync('ffmpeg')` o búsqueda equivalente) y usar esa ruta
   en lugar de invocar `'ffmpeg'`
3. Cambiar `stdio: 'inherit'` a `stdio: 'pipe'` con captura completa
4. Sleep 1s entre `postProcessCinematic` retorno y siguiente phase
   para asegurar flush de NTFS

Con los logs JSONL del v0.1.10 ya se puede ver cuál de las 4 hipótesis
es real.

---

## Criterios de éxito v0.1.10

1. ✅ Una sola llamada `curl http://127.0.0.1:8731/diag/snapshot` me
   da un resumen completo de un run que termine en 30 s de lectura
2. ✅ `vram.jsonl` muestra evolución VRAM correlacionada con phase
   transitions (puede confirmar que unloads sincronos funcionan)
3. ✅ Logs viejos se borran automáticamente al arrancar la app, no
   crecen indefinidamente (current logs están en >50 MB en sesiones
   largas de testing)
4. ✅ Bug de `postProcessCinematic` resuelto: `video.mp4` se produce
   correctamente con grade cinematic + audio ducking, sin caer al
   fallback Python
5. ✅ Cada error 5xx en cualquier sidecar incluye stack trace completo
   en el JSONL correspondiente

---

## Hoja de implementación

1. **#161** — Logging JSONL en los 3 sidecars + Rust pipeline
2. **#162** — VRAM monitor periódico
3. **#163** — Log rotation `logs_janitor.rs`
4. **#164** — Endpoint `/diag/snapshot`
5. **#165** — Bug fix postProcessCinematic con los logs nuevos

Las primeras 4 dan observabilidad. La 5 usa esa observabilidad para
resolver el bug que persiste desde v0.1.7. **Solo después de v0.1.10
estable se aborda v0.2.0** (long-form), porque sin logs estructurados
diagnosticar pipelines de 30+ min sería pesadilla.
