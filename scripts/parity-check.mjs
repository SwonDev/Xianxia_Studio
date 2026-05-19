#!/usr/bin/env node
/**
 * Pre-flight parity check.
 *
 * Runs before `tauri:dev` AND before `tauri:build` to fail fast when the
 * workspace is in a state where dev and prod would diverge.
 *
 * The bugs this catches are real ones we shipped:
 *   - thumbnail placeholders never replaced because dist/render.js was
 *     stale relative to render.ts (v0.1.42 → v0.1.45 regression)
 *   - subtitle generator missing `intro_offset_seconds` param so subs
 *     desynced by 6 s on every long-form video
 *   - hf_seed.rs forgetting to include the depth-anything model so
 *     DepthFlow downloaded from scratch on every fresh install
 *
 * Each invariant is one assertion. If any fails the script exits 1
 * with a CLEAR remediation hint — no silent breakage of the next build.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const failures = [];

function check(name, ok, hint) {
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}`);
  if (!ok) failures.push({ name, hint });
}

function contains(path, needle) {
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(needle);
}

console.log('Parity check — dev ↔ prod invariants\n');

// ── (1) sidecar-node dist freshness vs src ──────────────────────────
// If any .ts file under src/ is newer than dist/server.js, the build
// is stale. Identical-runtime-on-dev-and-prod relies on dist/ being
// the current truth.
{
  const distEntry = join(ROOT, 'apps/sidecar-node/dist/server.js');
  const srcDir = join(ROOT, 'apps/sidecar-node/src');
  let stale = false;
  let latestSrc = 0;
  function walk(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ts')) {
        const mt = statSync(p).mtimeMs;
        if (mt > latestSrc) latestSrc = mt;
      }
    }
  }
  if (existsSync(srcDir)) walk(srcDir);
  if (!existsSync(distEntry)) {
    stale = true;
  } else {
    const distMt = statSync(distEntry).mtimeMs;
    stale = latestSrc > distMt + 1000; // 1 s tolerance for fs precision
  }
  check(
    'sidecar-node dist/ is up-to-date with src/*.ts',
    !stale,
    'run `pnpm --filter @xianxia/sidecar-node build` to recompile TypeScript',
  );
}

// ── (2) render.ts thumbnail uses GLOBAL regex (placeholders appear ─
//        twice in thumbnail.html: once in the CSS comment, once in the
//        actual HTML, so .replace(string,...) only hits the comment)
{
  const rj = join(ROOT, 'apps/sidecar-node/dist/render.js');
  const ok = contains(rj, '/__BG__/g')
    && contains(rj, '/__TITLE__/g')
    && contains(rj, '/__BADGE__/g')
    && contains(rj, '/__SUBTITLE__/g');
  check(
    'render.js uses /__X__/g global regex for thumbnail placeholders',
    ok,
    'render.ts must use .replace(/__BG__/g, …) — see v0.1.42 thumbnail regression',
  );
}

// ── (3) /subtitles endpoint accepts intro_offset_seconds ────────────
{
  const ok = contains(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/subtitles.py'),
    'intro_offset_seconds',
  );
  check(
    'subtitles.py exposes intro_offset_seconds for caption sync',
    ok,
    'subtitles must accept an intro offset so SRT/ASS align with the 6 s intro card',
  );
}

// ── (4) rust pipeline passes intro_offset_seconds = 6 to /subtitles ─
{
  const ok = contains(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    '"intro_offset_seconds": 6.0',
  );
  check(
    'pipeline/mod.rs sends intro_offset_seconds=6.0 to /subtitles',
    ok,
    'rust pipeline must forward the intro offset constant — otherwise subs desync',
  );
}

// ── (5) hf_seed.rs lists depth-anything (DepthFlow model) ───────────
{
  const ok = contains(
    join(ROOT, 'apps/desktop/src-tauri/src/sidecars/hf_seed.rs'),
    'depth-anything/Depth-Anything-V2-small-hf',
  );
  check(
    'hf_seed.rs includes depth-anything/Depth-Anything-V2-small-hf',
    ok,
    'without this, every fresh install re-downloads DepthFlow from HuggingFace',
  );
}

// ── (6) depthflow.py subprocess.run uses utf-8 + replace ────────────
{
  const dfPath = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/depthflow.py');
  const txt = existsSync(dfPath) ? readFileSync(dfPath, 'utf8') : '';
  const ok = /encoding\s*=\s*["']utf-8["']/.test(txt) && /errors\s*=\s*["']replace["']/.test(txt);
  check(
    'depthflow.py subprocess.run uses encoding=utf-8, errors=replace',
    ok,
    'Spanish Windows cp1252 chokes on DepthFlow box-drawing chars (UnicodeDecodeError)',
  );
}

// ── (7) /depthflow/batch tolerates per-clip failure ─────────────────
{
  const ok = contains(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/depthflow.py'),
    'except HTTPException',
  ) && contains(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/depthflow.py'),
    'output_path=""',
  );
  check(
    '/depthflow/batch returns partial results instead of aborting',
    ok,
    'a single failing clip used to discard ALL successful clips → no parallax',
  );
}

// ── (8) script.py distillation uses Ollama format=json ──────────────
{
  const ok = contains(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/script.py'),
    '"format": "json"',
  );
  check(
    'script.py visual distillation uses Ollama format=json',
    ok,
    'free-form distillation returns empty body with done_reason=length on Gemma 4B',
  );
}

// ── (9b) browser-mode shim mirrors rust pipeline calls ─────────────
//        The shim re-implements `start_generation` for Playwright /
//        plain-Chrome dev mode. Whenever the Rust pipeline gains a
//        param (intro_offset, new endpoint, etc.) the shim must match
//        or browser tests would mis-validate.
{
  const shim = join(ROOT, 'apps/desktop/src/lib/tauri-shim.ts');
  const txt = existsSync(shim) ? readFileSync(shim, 'utf8') : '';
  const ok1 = txt.includes('intro_offset_seconds');
  check(
    'tauri-shim.ts sends intro_offset_seconds to /subtitles (parity with rust pipeline)',
    ok1,
    'shim must mirror pipeline/mod.rs — otherwise browser-mode subs desync but Tauri-mode is fine',
  );
  const ok2 = txt.includes('/depthflow/batch');
  check(
    'tauri-shim.ts uses /depthflow/batch (not legacy /depth/batch rembg)',
    ok2,
    'rembg parallax was deprecated v0.1.23 due to broken-edges artefacts; shim must use DepthFlow',
  );
  // v0.1.46: the Rust supervisor emits `progress` on 0-100 scale, but
  // the shim used to emit 0-1 fractions. The UI does Math.round which
  // turned "done" into "1%" in the sidebar instead of "100%". Make
  // sure the shim's phase() normaliser is in place.
  const ok3 = txt.includes('progress * 100') || txt.includes('progress*100');
  check(
    'tauri-shim.ts normalises progress to the 0-100 scale Rust uses',
    ok3,
    'phase() must multiply 0-1 fractions by 100 so the sidebar shows 100% on done (not 1%)',
  );
}

// ── (9c) browser-mode endpoints that mirror Rust Tauri commands ────
//        Without these the dev UI shows mock data: top-bar "0 cores",
//        Library "Aún no hay vídeos", broken video src, etc.
{
  const installPy = readFileSync(join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/install.py'), 'utf8');
  check(
    'install.py exposes /install/hardware (psutil + nvidia-smi)',
    installPy.includes('@router.get("/hardware")') && installPy.includes('cpu_cores'),
    'browser top-bar shows "0 cores · 0.0 / 0.0 GB" without this endpoint',
  );
  const diagPy = readFileSync(join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/diag.py'), 'utf8');
  check(
    'diag.py exposes /diag/library (scans data_dir/projects)',
    diagPy.includes('@router.get("/library")') && diagPy.includes('video_path'),
    'browser Library page shows "Aún no hay vídeos" without this endpoint',
  );
  check(
    'diag.py exposes /diag/file (browser-mode asset:// equivalent)',
    diagPy.includes('@router.get("/file")') && diagPy.includes('FileResponse'),
    'browser Library / Generator preview crash with convertFileSrc undefined without this',
  );
}

// ── (9d) UI uses tauri-asset wrapper, NOT raw @tauri-apps/api/core ──
{
  for (const relPath of ['apps/desktop/src/routes/library.tsx', 'apps/desktop/src/routes/generator.tsx', 'apps/desktop/src/routes/shorts.tsx']) {
    const txt = readFileSync(join(ROOT, relPath), 'utf8');
    const ok = txt.includes("from '@/lib/tauri-asset'") && !txt.match(/from\s+['"]@tauri-apps\/api\/core['"]/);
    check(
      `${relPath.split('/').pop()} imports convertFileSrc from @/lib/tauri-asset (browser-safe)`,
      ok,
      'raw @tauri-apps/api/core convertFileSrc is undefined in browser ⇒ page crashes',
    );
  }
}

// ── (9e) version label parity (browser shim ↔ workspace package.json)
{
  const viteCfg = readFileSync(join(ROOT, 'apps/desktop/vite.config.ts'), 'utf8');
  check(
    'vite.config.ts injects __APP_VERSION__ from root package.json',
    viteCfg.includes('__APP_VERSION__') && viteCfg.includes('rootPkg.version'),
    'without this, dev sidebar shows "v0.1.0-shim" instead of the real version',
  );
  const shim = readFileSync(join(ROOT, 'apps/desktop/src/lib/tauri-shim.ts'), 'utf8');
  check(
    'tauri-shim.ts returns __APP_VERSION__ for get_app_version',
    shim.includes('__APP_VERSION__'),
    'shim must consume the Vite-injected version constant',
  );
}

// ── (v0.2.0 T1) LLM backend abstraction lives at llm_backend.py ─────
{
  const backendPath = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_backend.py');
  const txt = existsSync(backendPath) ? readFileSync(backendPath, 'utf8') : '';
  const ok = txt.includes('class LlamaCppBackend')
    && txt.includes('class OllamaBackend')
    && txt.includes('def get_backend');
  check(
    'llm_backend.py defines OllamaBackend + LlamaCppBackend + get_backend()',
    ok,
    'v0.2.0 migration: all LLM callers must route through this abstraction',
  );
}

// ── (v0.2.0 T1) No route still posts directly to /api/generate ──────
//        Direct httpx.post → /api/generate hard-binds to Ollama and breaks
//        on llama.cpp backends. Every callsite must use `llm.generate(...)`
//        (which goes through `llm_backend.get_backend().generate(...)`).
{
  const routesDir = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes');
  let offenders = [];
  for (const f of readdirSync(routesDir)) {
    if (!f.endsWith('.py')) continue;
    const txt = readFileSync(join(routesDir, f), 'utf8');
    // The unload.py keeps the comment string "/api/ps" in its docstring
    // but no longer issues the http call. The compile-time regex looks for
    // an actual httpx.* POST to /api/generate — not arbitrary mentions.
    if (/(client|httpx)\.post\s*\([^)]*api\/generate/.test(txt)) {
      offenders.push(f);
    }
  }
  check(
    'no route POSTs directly to /api/generate (must use llm_generate)',
    offenders.length === 0,
    offenders.length
      ? `migrate these files to llm_backend.get_backend(): ${offenders.join(', ')}`
      : '',
  );
}

// ── (v0.2.0 T2) llama.cpp installer module ─────────────────────────
{
  const p = join(ROOT, 'apps/desktop/src-tauri/src/installer/llamacpp.rs');
  const txt = existsSync(p) ? readFileSync(p, 'utf8') : '';
  check(
    'installer/llamacpp.rs defines LLAMACPP_TAG + LlmModelConfig + pick_flavor()',
    txt.includes('pub const LLAMACPP_TAG')
      && txt.includes('pub struct LlmModelConfig')
      && txt.includes('pub fn pick_flavor()')
      && txt.includes('pub fn read_active_config()'),
    'T2/T3 contract — llama.cpp installer + active model config live here',
  );
  const libRs = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/lib.rs'), 'utf8');
  check(
    'lib.rs registers llamacpp_status + llamacpp_install Tauri commands',
    libRs.includes('installer::llamacpp::llamacpp_status')
      && libRs.includes('installer::llamacpp::llamacpp_install'),
    'invoke_handler! must list both commands so the Settings UI can call them',
  );
}

// ── (v0.2.0 T3) supervisor spawns llama-server ─────────────────────
{
  const p = join(ROOT, 'apps/desktop/src-tauri/src/sidecars/mod.rs');
  const txt = readFileSync(p, 'utf8');
  check(
    'sidecars/mod.rs spawns llama-server + has llamacpp SidecarStatus',
    txt.includes('spawn_llama_server')
      && txt.includes('spawn_llama_if_needed')
      && txt.includes('probe_llamacpp')
      && txt.includes('pub llamacpp: SidecarStatus')
      && txt.includes('llama_child'),
    'supervisor must own the llama-server lifecycle (spawn/probe/respawn)',
  );
  check(
    'spawn_python passes XIANXIA_LLM_BACKEND (default "llamacpp" — Ollama is opt-in)',
    txt.includes('XIANXIA_LLM_BACKEND')
      && txt.includes('"llamacpp"'),
    'v0.2.2: llama.cpp is the always-on runtime; Ollama only via explicit Settings opt-in. The legacy "auto" mode silently fell back to Ollama which contradicted the product promise.',
  );
  check(
    'start_all + health_loop + probe_snapshot gate Ollama behind app_settings.ollama_enabled',
    txt.includes('app_settings::load().ollama_enabled')
      && txt.match(/app_settings::load\(\)\.ollama_enabled/g)?.length >= 3,
    'v0.2.2 strict opt-in: Ollama may never be started, probed, or surfaced in the topbar unless the user flips the Settings toggle.',
  );
}

// ── (v0.2.2) Ollama opt-in toggle: persistence + Tauri commands + UI ─
{
  const settingsRs = join(ROOT, 'apps/desktop/src-tauri/src/app_settings.rs');
  check(
    'app_settings.rs defines AppSettings + ollama_enabled with Default = false',
    contains(settingsRs, 'pub ollama_enabled: bool')
      && contains(settingsRs, 'ollama_enabled: false'),
    'v0.2.2 — Ollama default OFF. The struct default is the canonical contract; tests rely on it.',
  );
  const libRsPath = join(ROOT, 'apps/desktop/src-tauri/src/lib.rs');
  check(
    'lib.rs registers app_settings_get + app_settings_set_ollama_enabled commands',
    contains(libRsPath, 'app_settings::app_settings_get')
      && contains(libRsPath, 'app_settings::app_settings_set_ollama_enabled'),
    'frontend toggle invokes these two — missing them breaks the Settings switch silently.',
  );
  const tauriTsPath = join(ROOT, 'apps/desktop/src/lib/tauri.ts');
  check(
    'tauri.ts exposes appSettingsGet + appSettingsSetOllamaEnabled helpers',
    contains(tauriTsPath, 'appSettingsGet:')
      && contains(tauriTsPath, 'appSettingsSetOllamaEnabled:'),
    'UI imports these from `tauri.ts`; a typo here breaks the toggle.',
  );
  const topbarPath = join(ROOT, 'apps/desktop/src/components/topbar.tsx');
  check(
    'topbar.tsx hides the Ollama dot when ollama_enabled is false',
    contains(topbarPath, 'appSettings?.ollama_enabled')
      && contains(topbarPath, 'appSettingsGet'),
    'The topbar dot is gated on the user preference; without the gate every user sees Ollama as "missing" forever.',
  );
}

// ── (v0.2.0 T4) GGUF reader + recommender + /models routes ─────────
{
  const ggufPath = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/gguf_meta.py');
  check(
    'gguf_meta.py defines read_gguf_meta + quantization_from_filename',
    contains(ggufPath, 'def read_gguf_meta(') && contains(ggufPath, 'def quantization_from_filename('),
    'T4 GGUF metadata extraction must live here (zero external deps)',
  );
  const recPath = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_recommender.py');
  const recTxt = existsSync(recPath) ? readFileSync(recPath, 'utf8') : '';
  check(
    'llm_recommender.py has family sampling defaults (gemma/qwen/llama/mistral)',
    recTxt.includes('"gemma":')
      && recTxt.includes('"qwen":')
      && recTxt.includes('"llama":')
      && recTxt.includes('"mistral":')
      && recTxt.includes('def recommend('),
    'each family needs distinct sampling params or the chosen model behaves poorly',
  );
  const modelsRoute = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/models.py');
  const mTxt = existsSync(modelsRoute) ? readFileSync(modelsRoute, 'utf8') : '';
  check(
    'routes/models.py exposes /local /search /download /activate /active',
    mTxt.includes('@router.get("/local")')
      && mTxt.includes('@router.get("/search")')
      && mTxt.includes('@router.post("/download")')
      && mTxt.includes('@router.post("/activate")')
      && mTxt.includes('@router.get("/active")'),
    'model browser UI depends on all five endpoints — none can be missing',
  );
  const serverPy = readFileSync(join(ROOT, 'apps/sidecar-py/server.py'), 'utf8');
  check(
    'server.py mounts the models router on /models',
    serverPy.includes('models.router, prefix="/models"'),
    'without this mount the /models/* endpoints 404',
  );
  check(
    'routes/models.py writes active.json at <data_dir>/models/active.json (T3 contract)',
    mTxt.includes('"active.json"') || mTxt.includes('active.json'),
    'T3 supervisor reads this exact path — renaming it without coordination breaks llama-server spawn',
  );
}

// ── (v0.2.0 T5) Settings UI exposes the model panel ────────────────
{
  const tauriTs = readFileSync(join(ROOT, 'apps/desktop/src/lib/tauri.ts'), 'utf8');
  check(
    'tauri.ts exports llamacppStatus + llmListLocal + llmActivate helpers',
    tauriTs.includes('llamacppStatus:')
      && tauriTs.includes('llmListLocal:')
      && tauriTs.includes('llmActivate:')
      && tauriTs.includes('llmSearchHf:'),
    'Settings panel binds against these — missing one breaks the UI',
  );
  const settings = readFileSync(join(ROOT, 'apps/desktop/src/routes/settings.tsx'), 'utf8');
  check(
    'settings.tsx renders LlmModelPanel inside the Modelo LLM section',
    settings.includes('LlmModelPanel')
      && settings.includes('Modelo LLM'),
    'without this section the user has no way to download/activate models from the GUI',
  );
  const shim = readFileSync(join(ROOT, 'apps/desktop/src/lib/tauri-shim.ts'), 'utf8');
  check(
    'tauri-shim.ts has stubs for llamacpp_status (browser-mode parity)',
    shim.includes("case 'llamacpp_status'"),
    'browser-mode UI must surface a sensible response even when the Tauri command is unavailable',
  );
}

// ── (v0.2.0 hotfix) Legacy GGUF discovery covers hf-cache/models/llm ─
//   The v0.1.x wizard deposited the LLM at <data_dir>/hf-cache/models/llm/
//   (not the HF native hub/ layout). If `discover_gguf_paths` doesn't scan
//   that exact path, v0.1.x users see "0 GGUFs" in the Settings panel and
//   the supervisor never auto-spawns llama-server. This invariant caught
//   the regression once — never again.
{
  const rustPath = join(ROOT, 'apps/desktop/src-tauri/src/installer/llamacpp.rs');
  const rustTxt = readFileSync(rustPath, 'utf8');
  check(
    'installer/llamacpp.rs scans hf-cache/models/llm AND filters ComfyUI GGUFs',
    rustTxt.includes('hf-cache/models/llm')
      && rustTxt.includes('fn is_llm_gguf')
      && rustTxt.includes('"diffusion_models"')
      && rustTxt.includes('"text_encoders"'),
    'without hf-cache/models/llm the v0.1.x → v0.2.0 migration loses the existing Gemma 4 GGUF and forces re-download',
  );
  const pyPath = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/models.py');
  const pyTxt = readFileSync(pyPath, 'utf8');
  check(
    'routes/models.py scans hf-cache/models/llm AND filters non-LLM GGUFs',
    pyTxt.includes('hf-cache')
      && pyTxt.includes('"llm"')
      && pyTxt.includes('_is_llm_gguf')
      && pyTxt.includes('"diffusion_models"'),
    'Python /models/local must mirror Rust discover_gguf_paths or the UI shows different content than the supervisor',
  );
}

// ── (v0.2.0 hotfix) Recommender resolves family from versioned arch ─
//   Real GGUFs report `gemma4`, `qwen3`, `phi3`, `deepseek2` etc. — the
//   recommender table can't enumerate every minor version. `_resolve_family`
//   strips the version suffix so the lookup is one entry per family.
{
  const p = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_recommender.py');
  const txt = readFileSync(p, 'utf8');
  check(
    'llm_recommender.py defines _resolve_family (handles gemma4, qwen3, phi3, …)',
    txt.includes('def _resolve_family('),
    'without this, Gemma 4 GGUFs fall to the neutral sampling fallback instead of the family-specific recommended params',
  );
}

// ── (v0.2.0 hotfix) /install/hardware parser uses FLAT field shape ─
//   The endpoint emits cpu_cores/total_ram_gb as flat root fields, with
//   only `gpu` nested. Parsing them as nested-dicts silently returns zeros.
{
  const p = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/models.py');
  const txt = readFileSync(p, 'utf8');
  check(
    'routes/models.py reads cpu_cores + total_ram_gb as FLAT fields from /install/hardware',
    txt.includes('"total_ram_gb"')
      && txt.includes('"cpu_cores"')
      && txt.includes('"vram_gb"'),
    'without the flat read the recommender thinks the user has 0 cores / 0 RAM and falls back to CPU defaults',
  );
}

// ── (v0.2.2) backend default: llama.cpp without silent Ollama fallback ────
{
  const p = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_backend.py');
  const txt = readFileSync(p, 'utf8');
  check(
    'llm_backend.py defaults to llamacpp + treats "auto" alias as llamacpp (no silent Ollama)',
    txt.includes('LlamaCppBackend')
      && txt.includes('OllamaBackend')
      && txt.includes('or "llamacpp"')
      && txt.includes('env = "llamacpp"'),
    'v0.2.2 — Ollama is opt-in only. The default env resolves to llamacpp and the legacy "auto" alias does not probe nor fall back to Ollama. Surfacing a llama-server error to the user beats silently switching engines mid-pipeline.',
  );
}

// ── (v0.2.0 VRAM coordination) llama.cpp unload/respawn between phases ───
//   Equivalent of Ollama's keep_alive=0 pattern from v0.1.x but for
//   llama.cpp. Without this trio the LLM retains 5+ GB VRAM through
//   image/TTS phases and ComfyUI/Qwen3-TTS spill to CPU (50× slowdown).
{
  const unloadPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/unload.py'),
    'utf8',
  );
  check(
    "routes/unload.py kills llama-server.exe + drops `.llamacpp_suspended` flag for llamacpp backend",
    unloadPy.includes('_kill_llamacpp_process')
      && unloadPy.includes('.llamacpp_suspended')
      && unloadPy.includes('llama-server'),
    "llama.cpp has no keep_alive; we MUST terminate the process to free VRAM, otherwise ComfyUI spills to CPU (50× slowdown reproduces v0.1.28 bug)",
  );
  const backendPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_backend.py'),
    'utf8',
  );
  check(
    "LlamaCppBackend.chat clears `.llamacpp_suspended` + waits for /health before POST",
    backendPy.includes('_llamacpp_suspended_flag_path')
      && backendPy.includes('_wait_for_llamacpp_health')
      && backendPy.includes('.llamacpp_suspended'),
    "without the wait, the first LLM call after an image phase hits 'connection refused' while supervisor is mid-respawn",
  );
  const sidecarRs = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/sidecars/mod.rs'),
    'utf8',
  );
  check(
    "supervisor spawn_llama_if_needed honours the `.llamacpp_suspended` flag",
    sidecarRs.includes('.llamacpp_suspended'),
    "if the supervisor ignores the flag it instantly respawns llama-server, undoing the VRAM unload",
  );
  const recPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/llm_recommender.py'),
    'utf8',
  );
  check(
    "recommender prefers -ngl 99 when model file fits in <=85% of VRAM",
    recPy.includes('hardware.vram_gb * 0.85')
      && recPy.includes('gpu_layers = 99'),
    "the old logic clamped ngl below block_count even when the model fit; that caused 10 layers of CPU offload and the 25-min visual distillation slowdown the user hit",
  );
}

// ── (v0.2.1 fix #1) burn-in ffmpeg silenced to avoid PIPE deadlock ──
//   Same class of bug as v0.1.22 F1.2 (reframe encode). Without these
//   flags ffmpeg's stderr fills the 64 KB pipe buffer during a long
//   subtitles=… render and blocks forever while Python waits for exit.
{
  const subsPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/subtitles.py'),
    'utf8',
  );
  check(
    'subtitles burn-in passes -loglevel error + -nostats to ffmpeg',
    subsPy.includes('"-loglevel", "error"')
      && subsPy.includes('"-nostats"')
      && subsPy.includes('"-hide_banner"'),
    'without quieting ffmpeg, capture_output=True overflows the pipe buffer on long renders and the call hangs forever (user complaint: "subtitles transcribiendo + karaoke ASS" stuck)',
  );
}

// ── (v0.2.1 fix #2) image distill enforces shot/palette/tod rotation ──
//   Soft rules ("Vary the SUBJECT") were ignored by Gemma 4 → 20 nearly
//   identical Aztec warrior portraits. Now each input item carries
//   deterministic rotation tokens and the prompt requires them in v.
{
  const scriptPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/script.py'),
    'utf8',
  );
  check(
    'script.py _distill_one_batch injects shot/palette/tod rotation per item',
    scriptPy.includes('_SHOTS')
      && scriptPy.includes('_PALETTES')
      && scriptPy.includes('_TIMES_OF_DAY')
      && scriptPy.includes('"shot"')
      && scriptPy.includes('"palette"')
      && scriptPy.includes('"tod"')
      && scriptPy.includes('STRICT DIVERSITY RULE'),
    'without per-item rotation hints Z-Image paints the same composition 20× — see user complaint about Aztec warriors with feather headdresses',
  );
}

// ── (v0.2.1 fix #3) beat timeline scales text positions to audio ─────
//   Old uniform distribution broke marker↔narration sync: a
//   `[IMAGE: serpiente emplumada]` written after sentence 5 ended up at
//   second 45 of audio where the narration talks about something else.
//   Now each marker carries its `text_seconds` (words-before / 150 wpm)
//   into the pipeline and we LINEARLY SCALE them to the real audio
//   duration, preserving relative position.
{
  const pipeRs = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    'utf8',
  );
  check(
    'pipeline propagates text_seconds + scales to audio (not uniform)',
    pipeRs.includes('text_seconds')
      && pipeRs.includes('beat timeline scaled from text-position to real audio duration'),
    'uniform timeline distribution desyncs every image from its narration line — see user complaint "imágenes que no concuerdan con el punto exacto del montaje"',
  );
}

// ── (v0.2.9) ACE-Step v1.5 reintroduced the RIGHT way ───────────────
//   The v0.2.6 "ACE-Step removed" invariants are obsolete: that drop
//   was for the OLD ace-step/ACE-Step repo (cpu_offload hang on 8 GB).
//   v0.2.9 uses the NEW ace-step/ACE-Step-1.5 (2B SFT, <4 GB, GPU-only,
//   no offload) in an ISOLATED venv + subprocess, so the original
//   failure mode cannot recur. The in-process music.py must still NOT
//   import the old monolithic API (that lived in the sidecar venv and
//   conflicted) — ACE-Step only runs via the isolated-venv subprocess.
{
  const musicPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/music.py'),
    'utf8',
  );
  check(
    'music.py never imports ACE-Step in-process (only via isolated venv subprocess)',
    // `acestep(?![\w])` so our own `import acestep_bootstrap` helper is
    // NOT a false positive — only the real `acestep` package counts.
    !/^\s*(import\s+acestep(?![\w])|from\s+acestep(?![\w])\s+import)/m.test(musicPy)
      && !musicPy.includes('ACEStepPipeline'),
    'ACE-Step pins torch cu128 — importing it in the sidecar venv would shred torch 2.5.1+cu121; it must stay in the subprocess runner',
  );
}

// ── (v0.2.6) VRAM choreography hardening — thumbnail + whisper ──────
//   The 2026-05-15 run died because a thumbnail Z-Image prompt thrashed
//   30 min (30-min timeout!) and ComfyUI never released VRAM, so the
//   subtitles phase (llama 3 GB + whisper 3 GB) couldn't fit and hung
//   15 min until the Rust timeout. These invariants lock in the fixes.
{
  const pipeRs = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    'utf8',
  );
  check(
    'pipeline/mod.rs has ensure_comfyui_vram + COMFY_SIDECAR + VRAM thresholds',
    pipeRs.includes('async fn ensure_comfyui_vram')
      && pipeRs.includes('const COMFY_SIDECAR')
      && pipeRs.includes('THUMB_MIN_VRAM_GB')
      && pipeRs.includes('WHISPER_MIN_VRAM_GB'),
    'the hard ComfyUI reclaim is what breaks the thumbnail→subtitles deadlock cascade; without it any contended card hangs the run',
  );
  check(
    'thumbnail Z-Image POST /image timeout is 4 min, not 30',
    // The thumbnail /image POST must use the 4-min timeout. We anchor on
    // the unique comment we left next to it (other /image-like calls,
    // e.g. /depthflow/batch, legitimately keep a 30-min budget).
    pipeRs.includes('from_secs(4 * 60)')
      && /thumbnail[^]{0,400}from_secs\(4 \* 60\)/.test(pipeRs),
    'a 30-min thumbnail timeout means any VRAM pressure burns 30 min on a doomed Sysmem-thrash prompt before failing over to frame-extract',
  );
  check(
    'subtitles phase calls ensure_comfyui_vram before wake_llm',
    pipeRs.includes('ensure_comfyui_vram(app, &client, WHISPER_MIN_VRAM_GB)'),
    'best-effort unload(comfyui) does nothing against a hung worker — only the respawn escalation frees VRAM for whisper+llama',
  );
  const sidecarsRs = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/sidecars/mod.rs'),
    'utf8',
  );
  check(
    'Supervisor exposes respawn_comfyui()',
    sidecarsRs.includes('pub async fn respawn_comfyui'),
    'ensure_comfyui_vram escalates to this; without it a wedged ComfyUI can never be recovered mid-pipeline',
  );
  const unloadPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/unload.py'),
    'utf8',
  );
  check(
    '_unload_music does a hard reclaim (ipc_collect + synchronize), not just a scheduled empty_cache',
    unloadPy.includes('torch.cuda.ipc_collect()')
      && unloadPy.includes('torch.cuda.synchronize()')
      && /def _unload_music/.test(unloadPy),
    'the old _unload_music only returned a message; a leaked music context (the v0.2.5 ACE-Step incident) starved the thumbnail cold reload',
  );
}

// ── (v0.2.7) subtitles deadlock fix — whisper evict + batch + timeouts ─
//   The 2026-05-15 v0.2.6 validation run STILL failed: whisper stayed
//   resident through the ES→EN translation, so llama+whisper thrashed
//   and 41 sequential LLM calls took 882 s > the 15-min Rust budget.
{
  const subsPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/subtitles.py'),
    'utf8',
  );
  check(
    'subtitles.py evicts whisper from VRAM before the translation loop',
    subsPy.includes('whisper_model.unload()')
      && subsPy.includes('subtitles_whisper_unloaded_pre_translate')
      && subsPy.indexOf('whisper_model.unload()')
         < subsPy.indexOf('subtitles_translate_start'),
    'whisper co-resident with llama-server during translation = Sysmem thrash = 15-46 s/call = blew the /subtitles timeout and failed the pipeline',
  );
  check(
    '_translate_entries is batched (numbered protocol + per-entry fallback)',
    subsPy.includes('XIANXIA_TRANSLATE_BATCH')
      && subsPy.includes('async def translate_batch')
      && subsPy.includes('async def _per_entry'),
    '1 LLM call per entry (41 sequential round-trips) is the failure amplifier; batching cuts it ~10x with a robust fallback ladder',
  );
  const pipeRs2 = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    'utf8',
  );
  check(
    'Rust /subtitles timeout is 30 min (was 15)',
    /\{\}\/subtitles"[^]{0,800}from_secs\(30 \* 60\)/.test(pipeRs2)
      && !/\{\}\/subtitles"[^]{0,800}from_secs\(15 \* 60\)/.test(pipeRs2),
    'the Python route legitimately needs >15 min for long-form multi-language subs; 15 min killed a run that would have completed at 16.9 min',
  );
  check(
    'Rust /tts has a bounded timeout (was unbounded → infinite pipeline hang)',
    /\{\}\/tts"[^]{0,400}from_secs\(25 \* 60\)/.test(pipeRs2)
      || /from_secs\(25 \* 60\)[^]{0,400}\/tts/.test(pipeRs2)
      || pipeRs2.includes('from_secs(25 * 60)'),
    'an unbounded /tts POST means a thrashing TTS clone hangs the whole pipeline forever with no error — the worst failure mode',
  );
  const musicReq2 = readFileSync(
    join(ROOT, 'apps/sidecar-py/requirements-music.txt'),
    'utf8',
  );
  check(
    'requirements-music.txt does NOT pin xformers (v0.2.13: uninstallable + unneeded)',
    !/^\s*xformers==/m.test(musicReq2),
    'xformers has no wheel for torch 2.5.1+cu121/py3.11/win on any index (default PyPI = sdist only, cu121 index tops at 0.0.27.post2); re-adding it makes the music deps install fail',
  );
}

// ── (v0.2.13) xformers ELIMINATED — sys.modules shim + torch SDPA ───
//   xformers is structurally uninstallable for the runtime AND only an
//   optional accelerator, but audiocraft's memory_efficient path has
//   FOUR ungated hard xformers imports (verify guard, _get_mask
//   LowerTriangularMask, _is_profiled profiler, ops.unbind). The fix is
//   a sys.modules no-op shim covering ALL of them + forcing the torch
//   SDPA backend + rebinding transformer.ops + installing the shim
//   BEFORE the audiocraft import. Each piece is load-bearing (proven
//   one-by-one against the real runtime) — none may regress. The old
//   _ensure_xformers/_warm_xformers pip machinery must stay GONE.
{
  const musicPy2 = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/music.py'),
    'utf8',
  );
  check(
    'music.py installs a sys.modules xformers no-op shim + forces torch SDPA',
    musicPy2.includes('def _force_torch_attention')
      && musicPy2.includes('sys.modules["xformers"]')
      && musicPy2.includes('sys.modules["xformers.ops"]')
      && musicPy2.includes('sys.modules["xformers.profiler"]')
      && musicPy2.includes('xf_ops.unbind = _unbind')
      && musicPy2.includes('_CURRENT_PROFILER = None')
      && musicPy2.includes("set_efficient_attention_backend(\"torch\")")
      && musicPy2.includes('_axt.ops = sys.modules["xformers.ops"]')
      && musicPy2.includes('XFORMERS_DISABLED')
      && musicPy2.includes('_force_torch_attention()')
      && !musicPy2.includes('_ensure_xformers'),
    'every shim piece (xformers/ops/profiler modules, unbind, _CURRENT_PROFILER, torch backend, ops rebind) is required — dropping any one makes MusicGen crash mid-generation again (verified 2026-05-16)',
  );
  // The shim must be applied BEFORE `from audiocraft.models import
  // MusicGen` — transformer.py binds its module-global `ops` from
  // `from xformers import ops` AT IMPORT TIME; shim-after-import =
  // ops=None → `ops.unbind` crash. Assert call-order in _musicgen.
  {
    const mg = musicPy2.indexOf('def _musicgen');
    const callIdx = musicPy2.indexOf('_force_torch_attention()', mg);
    const importIdx = musicPy2.indexOf('from audiocraft.models import MusicGen', mg);
    check(
      '_musicgen calls _force_torch_attention() BEFORE importing audiocraft',
      mg !== -1 && callIdx !== -1 && importIdx !== -1 && callIdx < importIdx,
      'shim-after-import leaves transformer.ops=None → ops.unbind crashes mid-generation; the shim must precede the audiocraft import',
    );
  }
  const serverPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/server.py'),
    'utf8',
  );
  check(
    'server.py no longer warms an xformers auto-install at boot',
    !serverPy.includes('_warm_xformers')
      && !serverPy.includes('_ensure_xformers'),
    'the xformers boot warmup is dead code (install never succeeded); removing it prevents a pointless ~15-min failing pip run every boot',
  );
}

// ── (v0.2.8) ACE-Step v1.5 — isolated venv (DepthFlow pattern) ──────
//   Best open-source music gen, opt-in. v0.1.7 pins torch 2.7.1+cu128
//   (conflicts with the sidecar's 2.5.1+cu121) so it MUST live in its
//   own venv + subprocess runner, never in-process. Opt-in + fallback
//   so it can't break the pipeline.
{
  const runnerPy = join(ROOT, 'apps/sidecar-py/scripts/acestep_runner.py');
  check(
    'acestep_runner.py exists (isolated-venv subprocess runner)',
    existsSync(runnerPy)
      && readFileSync(runnerPy, 'utf8').includes('AceStepHandler')
      && readFileSync(runnerPy, 'utf8').includes('generate_music'),
    'ACE-Step 1.5 must run in its own venv via subprocess (torch cu128 conflicts with the sidecar) — the runner is that bridge',
  );
  const musicPy3 = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/music.py'),
    'utf8',
  );
  check(
    'music.py _acestep_v15 is PRINCIPAL + never raises (None → MusicGen → library)',
    musicPy3.includes('def _acestep_v15')
      && musicPy3.includes('def acestep_ready')
      && /_acestep_v15\(req\)/.test(musicPy3)
      && musicPy3.includes('want_ai_music')
      && !musicPy3.includes('if req.use_acestep:'),
    'ACE-Step is the default music generator (no opt-in gate); it must degrade gracefully or it would break the pipeline it powers',
  );
  // v0.2.9 — auto-bootstrap: no toggle, no manual wizard component. The
  // venv self-installs in the background at sidecar boot AND on demand.
  const bootstrapPy = join(ROOT, 'apps/sidecar-py/scripts/acestep_bootstrap.py');
  check(
    'acestep_bootstrap.py exists (background auto-install, idempotent)',
    existsSync(bootstrapPy)
      && readFileSync(bootstrapPy, 'utf8').includes('def ensure_async')
      && readFileSync(bootstrapPy, 'utf8').includes('def is_ready')
      && readFileSync(bootstrapPy, 'utf8').includes('cu128'),
    'ACE-Step is principal + autoinstalable: the venv must self-provision with zero user action (no toggle, no wizard step)',
  );
  const serverPy2 = readFileSync(join(ROOT, 'apps/sidecar-py/server.py'), 'utf8');
  check(
    'server.py boot warms the ACE-Step auto-bootstrap (background thread)',
    serverPy2.includes('acestep_bootstrap')
      && serverPy2.includes('ensure_async')
      && serverPy2.includes('_warm_acestep'),
    'installing at boot (during the long pre-music phases) means ACE-Step is ready by the music phase with no manual step',
  );
  check(
    'ACE-Step is NOT a Settings opt-in (no acestep_enabled toggle surface)',
    !readFileSync(
      join(ROOT, 'apps/desktop/src-tauri/src/app_settings.rs'), 'utf8',
    ).includes('acestep_enabled')
    && !musicPy3.includes('if req.use_acestep:'),
    'a toggle contradicts the project rule (everything auto); ACE-Step is unconditional with auto-bootstrap + fallback',
  );
  const runnerRs = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/installer/runner.rs'),
    'utf8',
  );
  check(
    'installer also provisions the ACE-Step venv (acestep_venv_install, optional accelerator)',
    runnerRs.includes('fn acestep_venv_install')
      && runnerRs.includes('AssetKind::AceStepVenv')
      && runnerRs.includes('cu128'),
    'kept as an optional pre-install path; the Python boot bootstrap is the primary autoinstalable route',
  );
}

// ── (v0.2.9) image cohesion: thin style anchor, no omnipresent objects ─
//   Real user complaint (Olympian gods run): every image had the same
//   thunderbolt/temple because the FULL setting tag (with concrete
//   objects) was injected prefix+suffix on every prompt.
{
  const scriptPy2 = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/script.py'),
    'utf8',
  );
  check(
    'script.py uses _style_anchor (era+culture+palette only) prefix-only',
    scriptPy2.includes('def _style_anchor')
      && scriptPy2.includes('_style_anchor(setting)')
      && !scriptPy2.includes('f"{setting}. {prompt}, {setting}"'),
    'injecting the object-laden full setting tag prefix+suffix stamped the same iconography on every beat — the recurring-thunderbolt bug',
  );
}

// ── (v0.2.10) pipeline progress survives section navigation ────────
//   User report 2026-05-16: starting a generation then switching
//   sections "reset" the pipeline visually. Cause: progress lived in
//   generator.tsx React useState → unmount on route change wiped it.
//   Fix: module-level Zustand store + ONE subscription at the app root.
{
  const storeTs = join(ROOT, 'apps/desktop/src/lib/pipelineStore.ts');
  check(
    'pipelineStore.ts exists (Zustand, module-level, app-root subscription)',
    existsSync(storeTs)
      && readFileSync(storeTs, 'utf8').includes('export const usePipelineStore')
      && readFileSync(storeTs, 'utf8').includes('export function ensurePipelineSubscription'),
    'progress state must live outside the component tree or navigating away drops a running generation',
  );
  const rootTsx = readFileSync(
    join(ROOT, 'apps/desktop/src/routes/__root.tsx'), 'utf8',
  );
  check(
    '__root.tsx registers the pipeline subscription once (never unmounts)',
    rootTsx.includes('ensurePipelineSubscription'),
    'the single app-lifetime subscription must be at the root layout, not in the generator route',
  );
  const genTsx = readFileSync(
    join(ROOT, 'apps/desktop/src/routes/generator.tsx'), 'utf8',
  );
  check(
    'generator.tsx reads pipeline state from the store, not local useState/events',
    genTsx.includes('usePipelineStore')
      && !genTsx.includes('events.onPipelineProgress')
      && !genTsx.includes('useState<Record<number, PhaseUpdate>>'),
    'if the generator re-subscribes or holds progress in useState the navigation-reset bug returns',
  );
}

// ── (v0.2.12) Shorts: sentence split is multi-signal, not gap-only ──
//   Real failure 2026-05-16: fluent TTS narration has ~no ≥0.4 s
//   pauses, so gap-only grouping made mega-sentences > a short's
//   max_duration → _candidate_segments empty → HTTP 400 "no candidate
//   segments found in transcript". Must also split on terminal
//   punctuation + a duration cap, and never return empty when there is
//   a transcript.
{
  const shortsPy = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py'),
    'utf8',
  );
  check(
    '_group_into_sentences splits on punctuation + duration cap (not gap-only)',
    shortsPy.includes('max_sentence_dur')
      && shortsPy.includes('_SENTENCE_END')
      && shortsPy.includes('_ends_sentence'),
    'gap-only grouping collapses fluent TTS into mega-sentences longer than max_duration → zero shorts candidates → HTTP 400',
  );
  check(
    '_candidate_segments has a never-empty safety net',
    /if not candidates and sentences:/.test(shortsPy),
    'a hard 400 kills the whole Shorts feature; a best-effort candidate from the transcript start is always better',
  );
}

// ── (10) tauri-build-local.mjs uses shell:true on Windows ───────────
{
  const wrapper = join(ROOT, 'scripts/tauri-build-local.mjs');
  const txt = existsSync(wrapper) ? readFileSync(wrapper, 'utf8') : '';
  const okCount = (txt.match(/shell:\s*true/g) || []).length;
  check(
    'tauri-build-local.mjs uses shell:true in spawnSync (≥2 occurrences)',
    okCount >= 2,
    'Node 22+ refuses to spawn .cmd files with shell:false — build silently fails',
  );
}

// ── (v0.2.14) SEO metadata pack — 100 % local, no cloud APIs ───────
//   New /seo route: title+variants, per-language description (hook
//   front-loaded), tags (500-char budget), hashtags, REAL chapters
//   from [CHAPTER:] markers, SEO score. Runs as a best-effort final
//   pipeline step (phase 12, never blocks) AND standalone from the
//   Library panel. Must stay API-free (project rule: 100 % local).
{
  const seoPy = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/seo.py');
  const seoTxt = existsSync(seoPy) ? readFileSync(seoPy, 'utf8') : '';
  check(
    'seo.py exists, uses the local LLM only, and parses real chapters',
    seoTxt.includes('@router.post')
      && seoTxt.includes('from ..llm import generate as llm_generate')
      && seoTxt.includes('from .script import parse_markers')
      && !seoTxt.includes('openai')
      && !seoTxt.includes('api_key'),
    'the SEO pack must be 100 % local (no cloud APIs) and derive chapters from the script markers, never fabricated timestamps',
  );
  const serverPy2 = readFileSync(join(ROOT, 'apps/sidecar-py/server.py'), 'utf8');
  check(
    'server.py registers the /seo router',
    serverPy2.includes('seo,') && serverPy2.includes('seo.router'),
    'the /seo route must be mounted or the pipeline phase 12 + Library panel get 404',
  );
  check(
    'prompts.py defines SEO_PROMPT_TEMPLATE',
    contains(join(ROOT, 'apps/sidecar-py/src/xianxia_ai/prompts.py'), 'SEO_PROMPT_TEMPLATE'),
    'the SEO route imports SEO_PROMPT_TEMPLATE — it must exist',
  );
  const pipeRs = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'), 'utf8');
  check(
    'pipeline writes script.txt + runs the best-effort SEO phase 12',
    pipeRs.includes('script.txt')
      && pipeRs.includes('/seo')
      && /emit\(app, pid, 12, "skipped"/.test(pipeRs),
    'phase 12 must be best-effort (skipped on failure, never `?`-propagated) and script.txt must be persisted so the Library can re-run SEO on old projects',
  );
  check(
    'library.tsx has the SEO pack panel with copy buttons',
    contains(join(ROOT, 'apps/desktop/src/routes/library.tsx'), 'seo-generate-')
      && contains(join(ROOT, 'apps/desktop/src/routes/library.tsx'), 'function SeoField'),
    'the user copies the metadata from the Library card — the panel + per-field copy must exist',
  );
}

// ── (v0.2.15) Shorts black cold-open guard ─────────────────────────
//   Narrative videos open with ~6 s of animated title card over pure
//   black (render.ts INTRO_SEC). A Short cut from the start cold-opens
//   on black → instant swipe. Every picked candidate must be advanced
//   past its near-black lead-in (ffmpeg blackdetect) BEFORE hooks/cut,
//   in BOTH the /from_video and /auto flows. Best-effort, content-
//   agnostic, capped so it never eats the payload.
{
  const sa = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py'),
    'utf8',
  );
  check(
    'shorts_auto.py has the black cold-open guard (blackdetect, pix_th)',
    sa.includes('def _black_leadin_seconds')
      && sa.includes('def _guard_black_open')
      && sa.includes('blackdetect=d=0.10:pix_th=0.10')
      && /^import re$/m.test(sa),
    'a Short must never open on the dark title-card intro; the guard probes blackdetect with the per-pixel pix_th (NOT pic_th) and re needs importing',
  );
  const guardCalls = (sa.match(/_guard_black_open\(req\.video_path, c,/g) || []).length;
  check(
    'both /from_video and /auto apply _guard_black_open to every pick',
    guardCalls >= 2
      && /picked = _pick_top_non_overlapping[^]{0,200}_guard_black_open/.test(sa),
    'the guard must run on picked candidates BEFORE hook generation / _cut_short in BOTH shorts endpoints, or one path still cold-opens black',
  );
}

// ── (v0.2.16) Forced alignment + faster-whisper consolidation ──────
//   WhisperX-grade word timing via torchaudio MMS_FA (zero new deps).
//   PURE refinement: any failure ⇒ refine_segments() returns None and
//   the caller keeps the original faster-whisper timings (byte-identical
//   to pre-v0.2.16). One consolidated transcription helper is the single
//   source of truth for the permissive anti-drop thresholds.
{
  const al = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/models/aligner.py');
  const wm = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/models/whisper_model.py');
  const sub = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/subtitles.py');
  const sa = readFileSync(
    join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py'),
    'utf8',
  );
  const init = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/models/__init__.py');
  const pipe = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    'utf8',
  );

  const rn = join(ROOT, 'apps/sidecar-py/scripts/aligner_runner.py');
  check(
    'aligner.py orchestrates an ISOLATED child (no in-process torchaudio)',
    contains(al, 'def refine_segments')
      && contains(al, 'subprocess.run')
      && contains(al, 'sys.executable')
      && contains(al, '_RUNNER')
      && contains(al, '_MIN_FREE_VRAM_GB')
      && contains(al, '_TIMEOUT_S')
      && contains(al, 'return None')
      && !contains(al, 'import torchaudio')
      && !/^\s*import torchaudio/m.test(readFileSync(al, 'utf8')),
    'wav2vec2 MUST run in a child process — torchaudio vs ctranslate2 cuDNN clash is a hard error-127 abort that fires even with an in-process whisper unload (proven by validation). aligner.py must NOT import torchaudio and must degrade to None on any child failure.',
  );

  check(
    'aligner_runner.py is the clean isolated runner (torchaudio only)',
    contains(rn, 'torchaudio.pipelines.MMS_FA')
      && contains(rn, 'with_star=False')
      && contains(rn, 'def _norm')
      && !/^\s*(import|from)\s+(faster_whisper|ctranslate2|xianxia_ai)\b/m.test(
        readFileSync(rn, 'utf8'),
      ),
    'the runner must not IMPORT faster_whisper/ctranslate2/xianxia_ai (only torchaudio) or the child reintroduces the cuDNN clash it exists to avoid',
  );

  check(
    'whisper_model.py is the single source of truth (transcribe_words)',
    contains(wm, 'def transcribe_words')
      && contains(wm, 'no_speech_threshold=0.05')
      && contains(wm, 'condition_on_previous_text=False')
      && contains(wm, 'vad_filter=vad'),
    'the permissive anti-drop thresholds (protect the FIRST narration sentence) must live in ONE place shared by subtitles + Shorts',
  );

  check(
    'subtitles.py consolidated + forced-align with hard fallback',
    contains(sub, 'from ..models import aligner, whisper_model')
      && contains(sub, 'whisper_model.transcribe_words(')
      && contains(sub, 'aligner.refine_segments(req.audio_path, segments')
      && contains(sub, 'if refined is not None:')
      && contains(sub, 'segments = refined')
      && !contains(sub, 'no_speech_threshold=0.05'),
    'subtitles must call the shared helper (NOT inline transcribe params) and only swap segments when refine succeeds',
  );

  const refineAfterUnload =
    sa.indexOf('whisper unloaded after transcription') <
      sa.indexOf('aligner.refine_segments(') &&
    sa.indexOf('aligner.refine_segments(') > 0;
  check(
    'shorts_auto /from_video consolidated + forced-align AFTER whisper unload',
    contains(
      join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py'),
      'whisper_model.transcribe_words(',
    )
      && sa.includes('aligner.refine_segments(')
      && sa.includes('if refined is not None:')
      && refineAfterUnload,
    'wav2vec2 must load only AFTER ctranslate2/whisper is evicted (cuDNN handle conflict = hard process abort)',
  );

  check(
    'models package exports the aligner module',
    contains(init, 'from . import aligner,')
      && contains(init, '"aligner"'),
    'aligner must be importable as `from ..models import aligner`',
  );

  check(
    'pipeline Phase 12 SEO logs WHY it skipped (audit, non-behavioural)',
    pipe.includes('seo_reason')
      && /reason = %why, "SEO pack skipped"/.test(pipe),
    'silent skips are undiagnosable; the skip reason must reach the log + UI message',
  );
}

// ── (v0.2.17) AI-provenance watermark (Meta AudioSeal) ─────────────
//   Imperceptible neural watermark on the FINAL video audio so the
//   published artifact is provably AI-generated. Best-effort phase 13,
//   exact mirror of the SEO phase: never blocks, never `?`-propagates.
//   Heavy work isolated in a child (cuDNN/CUDA hygiene, dynamo off);
//   video stream copied bit-identical.
{
  const reqAi = join(ROOT, 'apps/sidecar-py/requirements-ai.txt');
  const wrn = join(ROOT, 'apps/sidecar-py/scripts/watermark_runner.py');
  const wrt = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/watermark.py');
  const srv = join(ROOT, 'apps/sidecar-py/server.py');
  const pipe = readFileSync(
    join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs'),
    'utf8',
  );

  check(
    'audioseal is a shipped dep (autoinstalable, do-not-remove)',
    contains(reqAi, 'audioseal>=0.2')
      && contains(reqAi, 'DO NOT REMOVE'),
    'AudioSeal must ship installed so phase 13 has zero first-run wait; the route also self-heals via pip',
  );

  check(
    'watermark_runner.py is the isolated runner (dynamo off, native sr)',
    contains(wrn, 'AudioSeal')
      && contains(wrn, 'TORCHDYNAMO_DISABLE')
      && contains(wrn, 'get_watermark')
      && contains(wrn, 'sample_rate=sr')
      && !/^\s*(import|from)\s+(faster_whisper|ctranslate2|xianxia_ai)\b/m.test(
        readFileSync(wrn, 'utf8'),
      ),
    'the bundled runtime has no MSVC for torch.compile (dynamo MUST be off); AudioSeal 0.2 does not resample (gen+detect at native sr); runner stays isolated like aligner_runner',
  );

  check(
    'watermark.py route: isolated child, video bit-identical, never 500',
    contains(wrt, 'subprocess.run')
      && contains(wrt, 'sys.executable')
      && contains(wrt, '_RUNNER')
      && contains(wrt, '"-c:v", "copy"')
      && contains(wrt, 'def _ensure_audioseal')
      && contains(wrt, 'WatermarkResponse(watermarked=False')
      && !contains(wrt, 'raise HTTPException'),
    'watermark must copy the video stream bit-identical, run the model in a child, self-heal the dep, and ALWAYS return 200 (best-effort) — never hard-fail the pipeline',
  );

  check(
    'server.py registers the /watermark router',
    contains(srv, 'watermark,')
      && /include_router\(watermark\.router, prefix="\/watermark"/.test(
        readFileSync(srv, 'utf8'),
      ),
    'the /watermark endpoint must be mounted or phase 13 always skips',
  );

  check(
    'pipeline Phase 13 watermark is best-effort (mirror of SEO, no `?`)',
    /Phase 13: AI-provenance watermark/.test(pipe)
      && pipe.includes('"{}/watermark"')
      && /emit\(app, pid, 13, "running"/.test(pipe)
      && /persist_step\(pool, pid, 13, "done"/.test(pipe)
      && /reason = %why, "watermark skipped"/.test(pipe),
    'phase 13 must emit running/done/skipped like phase 12 and NEVER `?`-propagate (the video is already produced — watermark failing must not fail the run)',
  );
}

// ── (v0.5.0 T15-1) Migration 0003 is the ONE place for chapter_state ─
//   "Never edit applied migrations" rule: chapter_state and script_outline
//   must appear in 0003 and NOWHERE in 0001/0002.
{
  const m0003 = join(ROOT, 'apps/desktop/src-tauri/migrations/0003_chapters_resume.sql');
  const m0001 = join(ROOT, 'apps/desktop/src-tauri/migrations/0001_init.sql');
  const m0002 = join(ROOT, 'apps/desktop/src-tauri/migrations/0002_voices_expanded.sql');
  check(
    '0003_chapters_resume.sql defines script_outline + chapter_state; 0001/0002 do NOT',
    existsSync(m0003)
      && contains(m0003, 'script_outline')
      && contains(m0003, 'chapter_state')
      && !contains(m0001, 'chapter_state')
      && !contains(m0002, 'chapter_state'),
    '0003 is the only migration that may define chapter tables — editing 0001/0002 for chapters would break applied-migration integrity',
  );
}

// ── (v0.5.0 T15-2) script.py chapter routes + shared post-processor ──
//   /outline, /chapter, /postprocess must all exist; generate_script ends
//   by delegating to _finalize_script (shared helper, not duplicated logic).
{
  const scriptPy = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/script.py');
  const txt = existsSync(scriptPy) ? readFileSync(scriptPy, 'utf8') : '';
  check(
    'script.py defines /outline, /chapter, /postprocess routes + _finalize_script helper',
    txt.includes('@router.post("/outline"')
      && txt.includes('@router.post("/chapter"')
      && txt.includes('@router.post("/postprocess"')
      && txt.includes('async def _finalize_script('),
    'all three chapter routes must exist; _finalize_script is the shared post-processing helper — duplicating it would desync /script and /postprocess behaviour',
  );
  // generate_script (the legacy /script handler) must delegate to _finalize_script —
  // locate the function body and confirm return await _finalize_script( appears after it.
  const fnIdx = txt.indexOf('async def generate_script(');
  const nextFnIdx = txt.indexOf('\nasync def ', fnIdx + 1);
  const bodySlice = fnIdx >= 0
    ? txt.slice(fnIdx, nextFnIdx > fnIdx ? nextFnIdx : fnIdx + 2000)
    : '';
  check(
    'generate_script ends by delegating to _finalize_script (no duplicated post-processing)',
    fnIdx >= 0 && bodySlice.includes('return await _finalize_script('),
    'generate_script must close with `return await _finalize_script(…)` — if it diverges, the /script and /postprocess paths produce different outputs',
  );
}

// ── (v0.5.0 T15-3) Pipeline long-form/short split preserved ─────────
//   The >= 7 long-form branch must exist AND the legacy /script call for
//   the < 7 short path must not have been removed.
{
  const pipeRs = join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs');
  const txt = existsSync(pipeRs) ? readFileSync(pipeRs, 'utf8') : '';
  check(
    'pipeline/mod.rs has >= 7 long-form branch AND legacy /script short-path (< 7)',
    txt.includes('req.target_minutes >= 7')
      && /Legacy path[^]{0,200}\/script/.test(txt),
    'the short-path (/script single-call) must not be removed — videos < 7 min still use it; the >= 7 guard gates the outline+chapter loop',
  );
}

// ── (v0.5.0 T15-4) chapters.py exports the four required helpers ─────
{
  const chapPy = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/chapters.py');
  check(
    'chapters.py defines parse_outline, assemble_script, chapter_count_for, expected_crossfade_duration',
    contains(chapPy, 'def parse_outline')
      && contains(chapPy, 'def assemble_script')
      && contains(chapPy, 'def chapter_count_for')
      && contains(chapPy, 'def expected_crossfade_duration'),
    'all four helpers are consumed by pipeline (Rust) and sidecar callers; any rename silently breaks callers',
  );
}

// ── (v0.5.0 T15-5) tts.py uses acrossfade with graceful fallback ────
//   acrossfade is a 2-input-only filter. The bug guard ensures the invalid
//   `acrossfade=n=` multi-input form never recurs; the fallback ensures TTS
//   never hard-fails on long-form audio.
{
  const ttsPy = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/tts.py');
  const txt = existsSync(ttsPy) ? readFileSync(ttsPy, 'utf8') : '';
  check(
    'tts.py uses acrossfade + np.concatenate fallback + warning log; NOT acrossfade=n=',
    txt.includes('acrossfade')
      && txt.includes('np.concatenate')
      && txt.includes('crossfade_ok')
      && !txt.includes('acrossfade=n='),
    'acrossfade=n= is invalid (2-input-only filter); the fallback to np.concatenate must be present so long-form TTS never hard-fails on audio assembly',
  );
}

// ── (v0.5.0 T15-6) chapter-preview.tsx: null on empty, no particles ──
//   Returns null when chapters map is empty (no demo data leak).
//   Must contain NO executable particle/canvas code — the rule-comment is
//   allowed but actual Math.random( / <canvas / createParticle identifiers
//   are banned per DESIGN.md "sin partículas" rule.
{
  const cpTsx = join(ROOT, 'apps/desktop/src/components/chapter-preview.tsx');
  const txt = existsSync(cpTsx) ? readFileSync(cpTsx, 'utf8') : '';
  check(
    'chapter-preview.tsx returns null on empty chapters and has no executable particle/canvas code',
    existsSync(cpTsx)
      && txt.includes('length === 0')
      && txt.includes('return null')
      && !txt.includes('Math.random(')
      && !txt.includes('<canvas')
      && !txt.includes('createParticle')
      && !/\bparticles\b/.test(txt),
    'component must guard empty state (no demo data); DESIGN.md forbids particle/canvas decorations (sin partículas rule)',
  );
}

// ── (v0.6.0 LTX-2.3 opt-in) ────────────────────────────────────────

// ── (v0.6.0 #1) hardware.rs LtxCapability enum + thresholds ─────────
//   8 GB → None (dev box never runs LTX). Regresses instantly if someone
//   lowers the thresholds and accidentally enables LTX on 8 GB cards.
{
  const hw = join(ROOT, 'apps/desktop/src-tauri/src/hardware.rs');
  check(
    'hardware.rs defines enum LtxCapability {None,Gguf,Full} + ltx_capability_for_vram with >= 32.0 and >= 24.0 thresholds',
    contains(hw, 'enum LtxCapability')
      && contains(hw, 'None,')
      && contains(hw, 'Gguf,')
      && contains(hw, 'Full,')
      && contains(hw, 'fn ltx_capability_for_vram')
      && contains(hw, '>= 32.0')
      && contains(hw, '>= 24.0'),
    'conservative thresholds: 32 GB → Full, 24 GB → Gguf, everything else (incl. 8 GB dev box) → None — lowering them enables LTX where it cannot fit VRAM',
  );
}

// ── (v0.6.0 #2) DEFAULT BYTE-IDENTICAL invariant ────────────────────
//   Triple-gate ensures LTX only runs when all three conditions are true.
//   The legacy HyperFrames path must remain untouched (default preserved).
{
  const pipe = join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs');
  check(
    'pipeline/mod.rs has triple-gate (ltx_video_capability + ltx_models_installed + use_ltx_video), video_engine=="ltx" guard, and legacy try_hyperframes_render / /render/narrative path',
    contains(pipe, 'ltx_video_capability')
      && contains(pipe, 'ltx_models_installed')
      && contains(pipe, 'use_ltx_video')
      && contains(pipe, 'video_engine == "ltx"')
      && contains(pipe, 'try_hyperframes_render')
      && contains(pipe, '/render/narrative'),
    'all three gate conditions must be present; the "ltx" guard isolates LTX work; try_hyperframes_render + /render/narrative must not be removed (default path byte-identical)',
  );
}

// ── (v0.6.0 #3) Gguf branch requires all 4 canonical model files ─────
//   The 4th file (embeddings_connectors) was the gate-honesty fix.
//   Dropping it from the check would let a stale branch falsely claim Gguf-ready.
{
  const pipe = join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs');
  check(
    'pipeline/mod.rs ltx_models_installed Gguf branch checks all 4 canonical files including ltx-2.3-22b-dev_embeddings_connectors.safetensors',
    contains(pipe, 'ltx-2.3-22b-dev-Q4_K_M.gguf')
      && contains(pipe, 'ltx-2.3-22b-dev_video_vae.safetensors')
      && contains(pipe, 'comfy_gemma_3_12B_it.safetensors')
      && contains(pipe, 'ltx-2.3-22b-dev_embeddings_connectors.safetensors'),
    '4th file (embeddings_connectors) was the gate-honesty fix — dropping it lets the installer falsely claim Gguf-ready with only 3 of 4 files present',
  );
}

// ── (v0.6.0 #4) Per-beat fallback present in LTX branch ─────────────
//   Failed beats must keep their HyperFrames still rather than aborting.
{
  const pipe = join(ROOT, 'apps/desktop/src-tauri/src/pipeline/mod.rs');
  check(
    'pipeline/mod.rs LTX branch has per-beat fallback: ltx_clip_path key + warn "fallback HyperFrames"',
    contains(pipe, 'ltx_clip_path')
      && contains(pipe, 'fallback HyperFrames'),
    'a failed LTX beat must keep its still image via the HyperFrames path — missing fallback makes one bad beat abort the entire video',
  );
}

// ── (v0.6.0 #5) installer manifest + runner: ltx23-video component ───
//   required:false + real install_ltx23_video function (no "not yet implemented" stub).
{
  const manifest = join(ROOT, 'apps/desktop/src-tauri/src/installer/manifest.rs');
  const runner  = join(ROOT, 'apps/desktop/src-tauri/src/installer/runner.rs');
  check(
    'manifest.rs declares Component id "ltx23-video" with required:false; runner.rs has install_ltx23_video and no "not yet implemented" stub',
    contains(manifest, '"ltx23-video"')
      && contains(manifest, 'required: false')
      && contains(runner, 'install_ltx23_video')
      && !contains(runner, 'ltx23-video runner not yet implemented'),
    'ltx23-video must be an optional component with a real (non-stub) installer — a stub would silently succeed and leave the user without the models',
  );
}

// ── (v0.6.0 #6) ltx_video.py /clip route + server.py mounts router ───
//   Workflow files for both Full and Gguf variants must also be present.
{
  const ltxRoute = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/routes/ltx_video.py');
  const serverPy = join(ROOT, 'apps/sidecar-py/server.py');
  const wfGguf   = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video_gguf.json');
  const wfFull   = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json');
  check(
    'ltx_video.py defines /clip route; server.py registers ltx_video router; both workflow JSONs exist',
    contains(ltxRoute, '/clip')
      && contains(serverPy, 'ltx_video')
      && existsSync(wfGguf)
      && existsSync(wfFull),
    'the /clip endpoint is what the Rust pipeline calls per beat; the server must mount it and both workflow files must exist',
  );
}

// ── (v0.6.0 #7) workflow↔installer coherence guard ──────────────────
//   gguf JSON must reference the Q4_K_M file (not the fp8 full variant).
//   full JSON must reference the fp8 file (not the wrong .safetensors base).
//   Regression guard for the coherence fix — wrong filenames = ComfyUI error.
{
  const wfGguf = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video_gguf.json');
  const wfFull = join(ROOT, 'apps/sidecar-py/src/xianxia_ai/workflows/ltx23_video.json');
  check(
    'ltx23_video_gguf.json references ltx-2.3-22b-dev-Q4_K_M.gguf (not the wrong base .gguf)',
    contains(wfGguf, 'ltx-2.3-22b-dev-Q4_K_M.gguf')
      && !contains(wfGguf, '"ltx-2.3-22b-dev.gguf"'),
    'wrong filename in the GGUF workflow would cause ComfyUI to 404 on model load at generation time',
  );
  check(
    'ltx23_video.json references ltx-2.3-22b-dev-fp8.safetensors (not the wrong base .safetensors)',
    contains(wfFull, 'ltx-2.3-22b-dev-fp8.safetensors')
      && !contains(wfFull, '"ltx-2.3-22b-dev.safetensors"'),
    'wrong filename in the Full workflow would cause ComfyUI to 404 on model load at generation time',
  );
}

// ── (v0.6.0 #8) UI gated/no-mock: generator.tsx uses ltxCapability ───
//   Gate must be !== 'none'. Neither file may contain Math.random( or <canvas.
{
  const genTsx  = join(ROOT, 'apps/desktop/src/routes/generator.tsx');
  const setTsx  = join(ROOT, 'apps/desktop/src/routes/settings.tsx');
  check(
    'generator.tsx uses ltxCapability with !== "none" gate; no Math.random( or <canvas in generator or settings',
    contains(genTsx, 'ltxCapability')
      && contains(genTsx, "!== 'none'")
      && !contains(genTsx, 'Math.random(')
      && !contains(genTsx, '<canvas')
      && !contains(setTsx, 'Math.random(')
      && !contains(setTsx, '<canvas'),
    'LTX panel must be gated behind the capability check; Math.random/canvas are banned per DESIGN.md (sin partículas rule)',
  );
}

// ── (v0.6.0 #9) verify-upstream artifact present ────────────────────
{
  check(
    'docs/superpowers/ltx23-pinned-facts.md exists (verify-upstream artifact)',
    existsSync(join(ROOT, 'docs/superpowers/ltx23-pinned-facts.md')),
    'the verify-upstream doc must be committed so future sessions can check pinned model filenames without re-querying the HF API',
  );
}

// ── Result ─────────────────────────────────────────────────────────
console.log();
if (failures.length === 0) {
  console.log('✓ All parity invariants satisfied.');
  process.exit(0);
} else {
  console.error(`✗ ${failures.length} parity violation(s) — fix before continuing:\n`);
  for (const f of failures) {
    console.error(`  • ${f.name}\n    → ${f.hint}\n`);
  }
  process.exit(1);
}
