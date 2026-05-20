# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/) y
versionado [SemVer](https://semver.org/) (en este proyecto se aplican
solo bumps PATCH: `0.1.0` → `0.1.1` → `0.1.2`…).

## [Unreleased]

## [0.7.10] — 2026-05-20

### Fix deprecation `asyncio.get_event_loop()` (Python 3.12+)

Auditoría detectó **5 ocurrencias** de `asyncio.get_event_loop()`
dentro de contextos `async def`. Desde Python 3.12 esto está
deprecated: hay que usar `asyncio.get_running_loop()` cuando ya
estamos dentro de una coroutine. En 3.16+ se eliminará y romperá
el código.

Archivos arreglados:
- `apps/sidecar-py/src/xianxia_ai/llm_backend.py` — 2 ocurrencias
  (deadline tracking en wait_for_health y unload_check).
- `apps/sidecar-py/src/xianxia_ai/routes/tts.py` — 1 ocurrencia
  (cloning install background executor).
- `apps/sidecar-py/src/xianxia_ai/routes/voice_acquisition.py`
  — 2 ocurrencias (URL ingest + file upload pipelines).

Resultado: **0 DeprecationWarning ruidosos en stderr** durante
runs largos. El sidecar Python ya tira a Python 3.14 en runtime
y se evita el riesgo de regresión cuando se actualice a 3.16+.

### Sin compilación

Cambios puramente Python (sidecar). Sin NSIS por petición del
usuario hasta que avise.

## [0.7.9] — 2026-05-20

### +8 ángulos de cámara + 8 moods de luz (12→20 cada uno)

Ampliación de las listas de variaciones cinematográficas en
`script.py`. Las rotaciones anteriores tenían 12 entradas cada una
(`_CAMERA_VARIATIONS`, `_LIGHTING_VARIATIONS`), que daban 12² = 144
combinaciones distintas. Con 17 beats típicos por vídeo, la
probabilidad de colisión de framing (mismo angle + lighting) entre 2
beats era ~12 %.

Ahora 20 entradas cada uno → **400 combinaciones**, bajando la
probabilidad de colisión a ~4 % (≈ 3× menos colisiones de framing).

**Nuevos ángulos de cámara** (documentary feature cinematography
vocabulary, Herzog / Ken Burns / Ron Fricke):
- tracking dolly shot, parallel motion
- static locked tripod, formal documentary frame
- POV handheld, breath-paced motion
- crane shot rising, vertical reveal
- rack-focus pull, foreground bokeh to sharp
- symmetrical centred composition, axial geometry
- rule-of-thirds offset framing, negative space lead-room
- anamorphic 2.39:1 widescreen letterboxed

**Nuevos moods de luz** (cubren contextos históricos/documentales
no cubiertos por los 12 originales):
- dappled forest light, mottled green and gold
- underground torchlit gloom, amber pools
- snow-reflected indirect light, cool blue-white
- sunset orange-magenta sky silhouette
- lantern-lit interior, warm pools, indigo shadow
- high-key flat illumination, archival photo aesthetic
- single source god-rays through atmospheric dust
- embered firelight close-up, micro-shadows

### Sin compilación

Como en v0.7.8, queda commiteado y pusheado sin generar NSIS hasta
que el usuario lo pida. Cambios puramente Python (workflow JSON +
constantes en script.py) — solo afectan al sidecar runtime.

## [0.7.8] — 2026-05-20

### Auditoría de calidad: 3 mejoras estructurales + workflows Z-Image óptimos

Sesión de hardening basada en (a) re-lectura del bugfix_catalog,
(b) auditoría de patrones problemáticos (imports en hot path, caches
sin invalidación, polling loops), (c) investigación 2026 actualizada
sobre Z-Image-Turbo y best practices del modelo.

#### Mejora #1 — Sampler/scheduler óptimo para Z-Image-Turbo

Tongyi-MAI publicó la guía oficial 2026 confirmando que la combinación
recomendada para el modelo distilled (8 steps, cfg=1.0 baked-in) es
`euler_ancestral` + `sgm_uniform` en BF16, y `dpmpp_sde` + `sgm_uniform`
en GGUF. Nuestros workflows usaban `euler + simple` y `dpmpp_sde + beta`
respectivamente.

Cambios:
- `apps/sidecar-py/src/xianxia_ai/workflows/z_image_turbo.json`:
  `euler` → `euler_ancestral`, `simple` → `sgm_uniform`.
- `apps/sidecar-py/src/xianxia_ai/workflows/z_image_turbo_gguf.json`:
  `beta` → `sgm_uniform` (mantiene `dpmpp_sde`).

El cambio a `euler_ancestral` añade ruido estocástico controlado
en cada step (vs `euler` determinista) → ligeramente más diversidad
de composición entre beats con el mismo prompt y seed adyacentes.
Calidad subjetiva similar pero con mejor sample variety.

#### Mejora #2 — Import `_comfy_root` fuera del hot path

`apps/sidecar-py/src/xianxia_ai/models/comfyui_client.py::wait_for_image`
hacía `from .. import _comfy_root` dentro del polling loop, ejecutándose
hasta **1800 veces durante un timeout de 30 minutos**. Python cachea
módulos así que cada call era cheap, pero el dotted attribute lookup
añadía coste medible en polls largos. Movido al top del archivo.
Same late-binding semantics, zero per-iteration overhead.

#### Mejora #3 — Invalidación de cache TTS clone al unload

Bug latente detectado por auditoría: `_clone_prompt_cache` en `tts.py`
retiene `prompt_item` objects que contienen tensores PyTorch ligados
al MODELO base. Cuando se hace `tts_base_model.unload()` y luego
`load()`, el modelo nuevo NO conoce esos prompt_items. Si una request
posterior usa `model.generate_voice_clone(voice_clone_prompt=cached)`,
mezcla model nuevo + prompt viejo → comportamiento indefinido (corrupto
en el mejor caso, segfault en el peor).

Fix en `apps/sidecar-py/src/xianxia_ai/routes/unload.py`: cuando
`tts_base_model.unload()` devuelve True, invalidamos el cache de
prompt items en `tts.py`. El siguiente request reconstruirá los
prompts contra el modelo recién cargado (cuesta ~15 s extra una
vez por sesión de voice cloning, pero garantiza correctitud).

### Sin compilación en esta versión

A petición del usuario, esta versión queda commiteada y pusheada pero
sin generar NSIS. El instalable más reciente disponible sigue siendo
v0.7.5 hasta que el usuario explícitamente pida un nuevo build.

### Sin cambios en presets ni contratos

Cambios puramente internos / configuración. Cualquier preset recibe
igual el beneficio. Compatibilidad byte-idéntica preservada para
`narrative_epic`.

## [0.7.7] — 2026-05-20

### 4 mejoras basadas en investigación 2026 + auditoría VRAM

Investigación web sobre YouTube SEO 2026, mejores TTS/STT del año, y
psicología del thumbnail aplicada a 4 puntos concretos:

#### Mejora #1 — Whisper `large-v3-turbo` (6× más rápido)

`apps/sidecar-py/src/xianxia_ai/models/whisper_model.py`:
- Default cambiado de `large-v3` → `large-v3-turbo`.
- 6× más rápido (4 capas decoder vs 32) manteniendo ~1 % WER.
- VRAM baja de ~10 GB a ~6 GB → libera presión en post-render.
- MANTIENE multilingüe: importante porque `distil-whisper` es solo
  inglés y rompería los presets español/chino/japonés.
- Override pinning con `XIANXIA_WHISPER_SIZE=large-v3` si alguna
  vez detectamos regresión.

Fase 7 (subtítulos) bajará de ~30-60 s a ~10-15 s en typical run.

#### Mejora #2 — Thumbnail prompt MrBeast-style (8-12 % CTR)

`apps/desktop/src-tauri/src/pipeline/mod.rs::try_thumbnail`:

Reescritura del prompt Z-Image siguiendo psicología del thumbnail 2026:
- **Cara humana ocupando 60-70 % del frame** (face-priority,
  +25-30 % CTR vs object-only — facial recognition hardwired).
- **Ojos abiertos en shock/awe, boca semiabierta** — extreme
  reactions outperform neutral 3-4×.
- **Rojo y amarillo saturados sobre cyan/negro** — POH (Proof of
  Human) aesthetic 2026 + contraste contra la UI gris/blanca de
  YouTube.
- **Sombra limpia inferior** para que el title overlay se lea.
- Micro-detalle de piel (tendencia POH).

#### Mejora #3 — Skip ACE-Step cuando VRAM < 5.5 GB

`apps/sidecar-py/src/xianxia_ai/routes/music.py`:
- `_ACESTEP_MIN_FREE_VRAM_GB` 4.5 → **5.5 GB**.

Causa: en las 2 runs reales del Emperador de Jade del 2026-05-20, el
main-venv leía 6.59 GB libres y aceptaba ACE-Step, pero la
acestep-venv aislada (con su propio torch+xformers+cuda+ckpt) bajaba
el working free a 1.42 GB ANTES de llegar al pre-flight interno de
ACE-Step → fallo predecible. El threshold conservador en main-venv
le da a ACE el ~3 GB headroom que realmente necesita en su venv.

Cuando no se cumple, saltamos directo a MusicGen sin perder los ~60 s
de subprocess spin-up + checkpoint load de ACE.

#### Mejora #4 — Título YouTube optimizado para algoritmo 2026

`apps/sidecar-py/src/xianxia_ai/prompts.py::METADATA_PROMPT_TEMPLATE`:

Research 2026 de YouTube SEO confirma que el algoritmo pesa los
**primeros 40 caracteres** del título para extracción de keywords y
truncá a 70 chars en resultados de búsqueda. Añadido al template:
- Primary keyword (named entity del topic) DEBE estar en los
  primeros 40 chars.
- Total cap subido de 60 → 70 chars (margen para keywords compuestos
  como "Empire of Aksum").

### Sin cambios de comportamiento para narrative_epic

Todas las mejoras son aditivas o reemplazan prompts/configuraciones,
nunca tocan la lógica del flujo de generación. `narrative_epic`
sigue produciendo guion byte-idéntico a v0.7.6.

## [0.7.6] — 2026-05-20

### LLM retry backoff: arregla 503 transitorio al despertar llama-server

Al revisar los logs de runs reales conté **4 ocurrencias de
`key_facts_llm_http_fail`** y otras tantas de `setting_tag_llm_http_fail`.
Causa raíz: cuando llama-server está en estado *suspended* (TTL 90 min,
ver v0.2.2 `bugfix_llamacpp_respawn`), la primera request al despertar
puede devolver **503** durante 5-10 s mientras el modelo se carga en VRAM.

`_extract_key_facts` hacía una sola llamada y devolvía `""` si fallaba →
guion sin grounding factual (degradación silenciosa).
`_generate_setting_tag` hacía 4 retries pero **sin esperar entre ellos**,
así que los 4 disparaban en ráfaga mientras el servidor seguía cargando
y todos fallaban con el mismo 503.

Fix v0.7.6: añadido **exponential backoff** (1 s, 3 s, 7 s) a ambas
funciones. La primera tentativa es inmediata; si falla, espera antes
del retry. Esto da al servidor el tiempo necesario para terminar de
despertar sin bloquear arbitrariamente la pipeline. Total worst-case:
11 s de espera extra antes de dar up — comparado con el guion vacío
que generábamos antes, vale mucho la pena.

Concretamente:
- `apps/sidecar-py/src/xianxia_ai/routes/script.py::_extract_key_facts`:
  reorganizado el try/except como bucle con `_delays = [0, 1, 3, 7]`.
  Loguea `key_facts_llm_retry` por cada intento intermedio + final
  `key_facts_llm_http_fail` solo cuando agotamos los 4.
- `apps/sidecar-py/src/xianxia_ai/routes/script.py::_generate_setting_tag`:
  añadido `await asyncio.sleep(_wait)` dentro del bloque `except` antes
  del `continue`, con la misma escala (0/1/3/7 s).

### Resultado esperado

El cuello de botella "key_facts_too_short" → guion vago / setting_tag
fallback prosa Wikipedia debería bajar significativamente. La métrica
clave a observar en logs futuros es la frecuencia de
`key_facts_extracted` (success) vs `key_facts_llm_http_fail` (final
fallback) después del retry chain.

### Sin cambios en presets ni contratos

Cambios puramente defensivos en código de fallback. Cualquier preset
recibe igual el beneficio. Imports limpios: `asyncio` añadido al top de
`script.py` (no estaba importado aunque ya se usaba indirectamente).

## [0.7.5] — 2026-05-20

### Tres bugs reales detectados por auditoría tras run del Emperador de Jade

Tras releer logs y código de la última generación encontré 3 bugs latentes
que estaban silenciosos pero degradaban la experiencia. Los arreglo todos.

#### Bug #1 — Polling infinito de ComfyUI history (CRÍTICO)

`models/comfyui_client.py::wait_for_image` polleaba `/history/{prompt_id}`
durante **30 minutos** cuando el Rust pipeline respawneaba ComfyUI para
liberar VRAM. El servidor nuevo no conoce el `prompt_id` viejo, así que
nunca aparece en `/history` y el polling seguía hasta el timeout. Síntoma
visible en el run del 2026-05-20: pipeline idle 11 minutos entre fase 6
(render) done y fase 7 (subs) start, con sidecar-py polleando
`8eea7e02-…` que ya no existía.

**Fix**: detección de prompt huérfano. Si tras 30 s seguimos sin verlo
en `/history` AND `/queue` está vacía (ni running ni pending), asumimos
que ComfyUI restartó entre el submit y este poll → raise `RuntimeError`
inmediato. El caller (try_thumbnail) ya tiene fallback a
`extract_frame_thumbnail`, así que el fix solo desbloquea la pipeline
en vez de quemar 30 min de timeout. La detección es conservadora: solo
declara orphan si AMBOS signals confirman (history 404 + queue vacía),
nunca por flap transitorio de red.

#### Bug #2 — Thumbnail fallback extraía frame del intro card (negro)

`extract_frame_thumbnail` seek-eaba a `-ss 5` (5 segundos). Pero el
intro card duraba 6 s con fondo negro + título centrado (v0.7.3), o
1.5 s en v0.7.4. Resultado típico (visto en la thumbnail.jpg generada
para el Emperador de Jade): fondo prácticamente negro con sutil
resplandor dorado, sin la imagen real del topic.

**Fix**: `extract_frame_thumbnail` ahora hace `ffprobe duration` y
saca el frame a **35 % del runtime** (`duration * 0.35`). Para un
vídeo de 4 min eso es ~84 s — siempre en medio del contenido, post-
intro, antes del fade-out final, sobre una imagen Z-Image plenamente
cargada. Min 2 s como floor para vídeos muy cortos.

#### Bug #3 — (No-bug, validación) seed per beat ya es random

Auditoría confirmó que `routes/image.py` línea 78 ya usa
`secrets.randbelow(2**31)` cuando el caller no pasa `seed`. El Rust
pipeline NO pasa seed para los beats narrativos, así que cada imagen
ya recibe seed único. La percepción de "imágenes parecidas" tras
v0.7.3/v0.7.4 viene del style_anchor (ya fixed) y del LLM repitiendo
sujetos (image_subject_repeat_detected — ya con threshold 0.4/window 6
en v0.7.2). No hay regresión aquí.

### Investigación 2026: best practices YouTube + voice clone

Búsqueda web durante la auditoría confirmó alineamiento con el state
of the art:

- **YouTube viral 2026**: hooks 1-3 s, mid-action start, visual+text+
  verbal en frame 1, swipe-away < 30 % es el target. La intro de
  v0.7.4 (1.5 s sobre primera imagen + fade-in música) cumple esto.
- **Voice clone 2026**: Qwen3-TTS sigue siendo el líder (vs F5-TTS,
  XTTS-v2) en consistencia de prosodia y voice cloning desde 3 s de
  referencia. El cableado actual es correcto. Si en el futuro hace
  falta más velocidad, F5-TTS es una alternativa más ligera pero con
  techo de calidad más bajo.
- **Stable Diffusion diversity**: seed-per-image + variation seed +
  CFG variation. Z-Image-Turbo usa cfg=1.0 fijo (es turbo, no admite
  CFG variation), pero el seed-per-request + facet pool del
  `_enforce_subject_diversity` ya cubren esto.

### Sin cambios para `narrative_epic` ni otros presets

Los 3 fixes son puramente defensivos / de fallback. Cualquier preset
los recibe por igual y el comportamiento generativo (script/imágenes/
voz/música) es byte-idéntico a v0.7.4.

## [0.7.4] — 2026-05-20

### Tres fixes de polish tras vídeo real v0.7.3 entregado al usuario

El vídeo del Emperador de Jade (explainer) salió de extremo a extremo
con v0.7.3, pero el usuario marcó 3 defectos sensoriales que tocaba
arreglar antes de declarar el preset divulgativo "terminado":

#### Fix A — Thumbnail con `style_anchor` filtrado como texto visible

El thumbnail.jpg generado mostraba `"CHINA CINEMATIC SETTING,
PERIOD-ACCURATE ICONOGRAPHY, ERA-TRUE PALETTE, DRAMATIC LIGHTING ·
HISTORIA REAL"` como subtítulo. Eso es el `style_anchor` técnico
(prompt CLIP interno) tratado como tagline de texto. Causa: en v0.7.3
cambié `_topic_setting_prefix` para devolver solo estilo visual; la
plantilla del thumbnail seguía leyendo TODO el `setting_tag` para el
subtitle.

`pipeline/mod.rs::try_thumbnail` ahora hace cleanup estricto del
tagline: corta en la primera coma o paréntesis, quita sufijos
estructurales (`setting/era/cinematic/...`), y CAPS a 3 palabras
máximo. Resultado: `"CHINESE · HISTORIA REAL"` en lugar de la cadena
técnica entera.

#### Fix B — Voz cambia tono y volumen entre chunks (Qwen3-TTS clone)

Síntoma del usuario: *"la voz aunque es la misma cambia el tono o el
acento, el cambio es sutil pero se nota bastante, porque incluso baja
como el volumen de algunas partes de las voces"*.

Causa raíz: Qwen3-TTS clone es estocástico por chunk. v0.1.34
normalizaba **cada chunk** a -14 LUFS por separado, lo que **acentuaba**
las diferencias de loudness al hacer ganancia local diferente en cada
uno. El crossfade de 80 ms era demasiado corto para enmascarar el
salto de timbre.

`routes/tts.py`:
- **Peak-only matching pre-crossfade**: cada chunk se iguala a -1 dBTP
  antes de unir (chunks llegan a `acrossfade` con amplitudes consistentes).
- **Crossfade 80 ms → 300 ms con curva sinusoidal** (`c1=qsin:c2=qsin`):
  3.75× más tiempo de fusión + curva perceptualmente más suave que
  triangular. Imperceptible como "join" para el oyente, pero enmascara
  el cambio sutil de timbre/acento que el modelo introduce.
- **LUFS normalize GLOBAL post-crossfade**: una sola pasada de -14 LUFS
  sobre el WAV concatenado completo (era por chunk). Loudness uniforme
  en toda la narración.

#### Fix C — Intro estruendosa de 6 s con título sobre fondo negro

Síntoma del usuario: *"las intros no me gustan porque hacen como un
sonido estruendoso, ponen el título y luego empieza el vídeo, las
intros tienen que ser mucho más virales"*.

Causa: el intro era 6 s de cartel de título sobre **fondo negro
sólido** + 6 s de silencio narrado + entrada de música de golpe a
volumen máximo. Eso es eterno para YouTube y suena estruendoso
porque el primer hit musical entra contra silencio total.

`apps/sidecar-node/src/render.ts`:
- `INTRO_SEC` 6.0 → 1.5 s (4× más corto).
- `INTRO_SILENCE_MS` 6000 → 1500.
- **Music fade-in 0→100 % durante los 1.5 s del intro** (afade type=in,
  curva qsin) en lugar de hit seco contra silencio. La música se
  introduce de forma natural mientras el card animado aparece sobre
  la imagen.

`apps/sidecar-node/src/templates/narrative.html`:
- `.intro-card` ahora tiene `background: transparent` (era `#050507`
  negro) y un `::before` con gradiente vertical `rgba(0,0,0,.45-.70)`
  para legibilidad. La **primera imagen del vídeo se ve directamente
  detrás del título** — no hay pantalla negra de 6 s nunca más.
- Animación GSAP comprimida de 6 s a 1.5 s, con tiempos rebalanceados
  para que el título aparezca con mask-sweep en 0.7 s y todo termine
  con fade-out a 1.2 s.
- Threshold `totalDuration >= 12 s` → `>= 3 s` (el intro de 1.5 s
  aplica a cualquier vídeo de ≥ 3 s).

`apps/desktop/src-tauri/src/pipeline/mod.rs`:
- `intro_offset_seconds: 6.0` → `1.5` para que los SRT/ASS sigan
  alineados con la nueva escala.

Parity invariant actualizado a `1.5` con nota explícita sobre
mantener Node + Rust sincronizados.

#### Sin cambios para `narrative_epic`

Los 3 fixes son aditivos y aplican a TODOS los presets por igual.
`narrative_epic` (default sin tocar selector) recibe la misma mejora
de voz, intro viral y thumbnail limpio. Sin contratos cambiados.

## [0.7.3] — 2026-05-20

### Fix raíz "imágenes extremadamente parecidas" y "guion sigue épico"

La run real de v0.7.2 con preset Divulgativo confirmó:
1. `repeat_ratio=0.67` — 10/16 pares consecutivos con mismo sujeto
   (mejoró del 94% pero sigue siendo malo).
2. El guion sale dramatizado pese a la directiva `explainer`:
   "el vasto tapiz del panteón… la propia estructura del orden cósmico…
   destino fue trascender la mera realeza".

#### Fix 1 — Style anchor SOLO visual (sin descripción semántica del topic)

`_topic_setting_prefix` ya no devuelve `"{topic} — {descriptor} —
cinematic setting (...)"`. Devuelve solo estilo visual:

```
v0.7.2: "La leyenda del Emperador de Jade — deidad de la mitología
         china y uno de los más importantes dioses del panteón
         taoísta — cinematic setting (period-accurate ...)"  (160 chars)

v0.7.3: "chinese cinematic setting, period-accurate iconography,
         era-true palette, dramatic lighting"  (~90 chars, sin topic)
```

El topic ya está en el body de cada prompt (de la narración). Inyectarlo
al inicio como anchor lo cargaba CLIP en el peso de los tokens
iniciales → todas las imágenes con mismo sujeto. Ahora solo va una
pista de cultura (chino/nórdico/griego/etc. extraída del descriptor
con regex) seguida del estilo visual neutral.

Esto se activa SOLO en el path de fallback (cuando el LLM `/setting_tag`
falla, ~50% de las runs con Gemma 4B abliterated). Cuando el LLM produce
un `setting_tag` válido, el comportamiento es idéntico a v0.7.2.

#### Fix 2 — Directiva del preset `explainer` con prohibiciones en castellano

Gemma 4B abliterated ignora "AVOID dramatization" en inglés cuando
genera prosa en español porque su training data en español es
literatura mítica (no didáctica). Añadido un bloque obligatorio en
castellano que prohíbe explícitamente:

- **Palabras**: "destino", "monumental", "cósmico", "épico/épica",
  "trascender", "tapiz", "vasto/a", "majestuoso/a", "glorioso/a",
  "titánico/a", "primordial", "eterno/a", "sublime", "divino/sagrado"
  (como adjetivo enfático).
- **Metáforas**: "el corazón del universo", "el orden cósmico", "la
  propia estructura del cosmos", "el alma de", "el espíritu de".
- **Construcciones**: "no es solo X, es Y", "más que X, es Y", "su
  destino era", "se dedicó a", "emerge una figura", "una figura
  monumental".
- **Aperturas**: "En el vasto", "En tiempos remotos", "Hace eones",
  "Cuenta la leyenda", "Se dice que".

Reemplazadas por construcciones permitidas: "X es una deidad china
conocida por…", "El concepto de X surge en…", "Para entender X…",
"Los textos taoístas describen…", "Un ejemplo concreto es…".

Tono español obligatorio: profesor universitario claro estilo Punset
o Aberrón.

#### Sin cambios para `narrative_epic`

`narrative_epic` (default) sigue siendo byte-idéntico a v0.7.0/0.7.1/0.7.2.
La nueva directiva en castellano vive solo dentro del bloque
`_EXPLAINER_DIRECTIVE`, que solo se inyecta cuando `preset_id="explainer"`.
El cambio en `_topic_setting_prefix` solo afecta la rama de fallback —
en runs donde el LLM produjo setting_tag válido (~50%), el resultado
es idéntico.

## [0.7.2] — 2026-05-20

### Tres fixes contundentes en presets, anchors y diversidad de imágenes

La primera generación con preset "Divulgativo" en v0.7.1 (topic "La
leyenda del Emperador de Jade") expuso 3 bugs que ahora cierro:

1. **`_topic_setting_prefix` inyectaba 230 chars de prosa Wikipedia al
   inicio de cada prompt de imagen.** Cuando el LLM `/setting_tag`
   fallaba 4 veces (raw_len=0, ~50% con Gemma 4B abliterated), el
   fallback construía un descriptor a partir del brief crudo de
   Wikipedia — pero el brief llega prefijado por `[es] Title\n` y eso
   confundía el regex de cleanup, dejando el header completo dentro
   del descriptor. CLIP pesa fuertemente los tokens al inicio del
   prompt → 17 imágenes con el mismo "Emperador de Jade es una deidad
   de la mitología china…" al inicio = todas casi idénticas.
   - Fix: strip `[xx] Title\n` antes de extraer descriptor.
   - Fix: regex extra para limpiar repetición del topic en forma corta
     (`"X es una/un... "`).
   - Fix: truncar descriptor a 120 chars (era 220). Anything longer
     is prose, not a style anchor.

2. **`_enforce_subject_diversity` era demasiado tolerante.** Default
   `window=4, thresh=0.55`. Endurecido a `window=6, thresh=0.4` para
   que más prompts repetidos sean pivoteados a un facet distinto del
   pool topic-aware antes de llegar a ComfyUI.

3. **`image_subject_repeat_detected` solo emitía warning.** En el run
   real 16/17 pares consecutivos compartían sujeto y el sistema
   siguió como si nada. Ahora cuando ≥50% de los pares consecutivos
   coinciden, el log se promueve a **ERROR** con campo `repeat_ratio`,
   visible inmediatamente en `/diag/snapshot` y en pipeline-rust
   correlator.

### Observabilidad del preset en runtime

El bug de raíz que el run del Emperador de Jade reveló — guion claramente
épico cuando el usuario pidió divulgativo — era opaco porque NINGÚN log
mostraba qué `preset_id` recibió cada capa. Fix:

- **`pipeline/mod.rs`**: log `tracing::info!` con `preset_id` al entrar
  al pipeline (antes de tocar la DB). Si la UI envía `narrative_epic`
  por defecto en lugar del `explainer` seleccionado, queda en el JSONL.
- **`routes/script.py`**: `script_generate_start` y `script_generate_done`
  ahora incluyen `preset_id` en su payload de log.

Con estos 2 logs los próximos diagnósticos de "el preset no se aplicó"
serán inmediatos: si Rust dice `preset_id=narrative_epic` cuando el
usuario marcó "Divulgativo" → bug en UI/serde. Si Rust dice `explainer`
pero `script_generate_start` dice `narrative_epic` → bug en el body
JSON al sidecar. Si ambos dicen `explainer` → bug en `build_script_prompt`.

### Sin cambios de comportamiento para `narrative_epic`

`narrative_epic` (default cuando se omite preset) sigue siendo
byte-idéntico a v0.7.1. Los 3 fixes son aditivos:

- El fix de `_topic_setting_prefix` solo aplica cuando el setting_tag
  del LLM falla y se necesita el fallback — y la versión corregida
  sigue produciendo el mismo prefijo cinematic, solo sin el ruido
  Wikipedia que ya era un bug.
- El endurecimiento de `_enforce_subject_diversity` se ejecuta para
  todos los presets por igual — si los facets del pool resuelven la
  repetición, las imágenes serán más diversas en todos los modos.
- El escalado a ERROR de `image_subject_repeat_detected` es solo
  observabilidad — no cambia el output.

## [0.7.1] — 2026-05-20

### Cableado completo de música y voz por preset

v0.7.0 introdujo los 6 tipos de vídeo pero dejó la inyección de
música y voz como "fase 2" en `routes/music.py` y `routes/tts.py`.
v0.7.1 lo cierra: cuando el usuario elige un preset distinto de
`narrative_epic`, el sidecar **resuelve los descriptores adecuados
en las propias fases de audio**, no solo en el guion.

- **`routes/music.py`** — `MusicRequest.preset_id?: str`. En
  `get_music`, si el preset no es `narrative_epic`, se antepone
  `MUSIC_MOOD_TO_PROMPT[preset.music_mood]` al `style_hint` que
  ya derivaba del `setting_tag`. Documentary obtiene un score
  documental sobrio, listicle uno energético y moderno, deep_dive
  uno minimalista analítico, etc. La rama de fallback (cuando
  MusicGen falla y se cae a librería local) también recibe el
  `preset_id`.
- **`routes/tts.py`** — `TTSRequest.preset_id?: str`. La resolución
  del `instruction` que va al modelo de voz Qwen3-TTS sigue una
  cadena de prioridad explícita: caller-provided `instruction` ⟶
  `VOICE_TONE_TO_DESCRIPTOR[preset.voice_tone]` ⟶ legacy
  `"Read in a calm cinematic narrator voice."`. Documentary obtiene
  "measured documentary narrator, calm authority", explainer
  "warm patient teacher, clear articulation", listicle "upbeat
  enthusiastic presenter, fast pace", etc.
- **`pipeline/mod.rs`** — propaga `req.preset_id` al body JSON de
  `/tts` y de las **3 llamadas** a `/music` (primaria + 2 fallbacks).

#### Contrato byte-idéntico — sigue intacto

- Si el cliente omite `preset_id`, o lo manda como `"narrative_epic"`,
  ambas rutas **saltan por completo** el bloque de override.
  - Música: `style_hint` queda exactamente como lo formaba v0.7.0
    (topic-derived sin prefijo de preset).
  - Voz: `instruct` queda como la cadena literal v0.7.0
    `"Read in a calm cinematic narrator voice."`.
- Cualquier `instruction` explícita del caller siempre gana sobre
  el preset (compatible con el wizard de voice cloning y futuros
  callers que necesiten control fino).

#### Garantías de no-regresión

- **13 tests nuevos** en `apps/sidecar-py/tests/test_presets_wiring.py`
  que pinean exactamente:
  - El `style_hint` legacy pasa sin cambios para `narrative_epic`/`None`.
  - Documentary/explainer/listicle/deep_dive prependen el bias correcto.
  - El `instruct` para `narrative_epic`/`None` es **byte por byte**
    la cadena `"Read in a calm cinematic narrator voice."`.
  - `instruction` explícita gana sobre cualquier preset.
  - Documentary/explainer/listicle/comparative/deep_dive devuelven los
    descriptores documentados.
- **5 invariantes nuevos** en `scripts/parity-check.mjs` que verifican
  presencia de `preset_id` en los schemas, importación de las tablas
  desde `presets`, el guard `!= "narrative_epic"` antes del override,
  la cadena legacy literal, y que `pipeline/mod.rs` propague
  `preset_id` en ≥ 8 cuerpos JSON (4 v0.7.0 + 1 tts + 3 music).

#### Tests totales en sidecar-py

`22 passed in 0.04s` — 9 del registry (v0.7.0) + 13 del wiring (v0.7.1).

## [0.7.0] — 2026-05-20

### 6 tipos de vídeo — el guion ya no es solo "historia épica"

Hasta v0.6.x el LLM tenía un único modo: historia dramatizada con
beats virales (BEAT 1 hook, BEAT 7 CTA, STORY ARC). Servía para
xianxia y para temas con "lore", pero **convertía cualquier petición
en relato épico aunque el usuario pidiera un documental fidedigno**.
Bug real recurrente: pedir "cultura nórdica explicada" devolvía un
mito con personajes inventados.

v0.7.0 introduce un selector "Tipo de vídeo" con 6 presets
canónicos. El que se elige cambia la directiva de sistema del LLM,
la voz, el mood musical y el bias de estilo de imagen. El usuario
elige; el motor no decide por él.

- **`narrative_epic`** — comportamiento de v0.6.x byte por byte
  (default si no se toca el selector → cero regresión para
  proyectos antiguos). STORY BEATS + STORY ARC + cinematic anchor.
- **`documentary`** — tono BBC / National Geographic. Prohíbe
  diálogo inventado, exige FACTUAL CONTEXT, ancla en hechos del
  Wikipedia RAG. Voz reposada (descriptor de narrador).
- **`explainer`** — divulgativo, profesor pedagógico. Prohíbe
  dramatización; prohíbe "epic", "destiny", "legendary". Imágenes
  con bias "clean illustrative" en vez de cinematic.
- **`listicle`** — estructura de top-N numerado. Cada ítem es una
  unidad autónoma con su propio gancho.
- **`comparative`** — A vs B paralelos, contrastes y zonas
  compartidas. Estructura simétrica obligatoria.
- **`deep_dive`** — análisis exhaustivo y largo. **Único preset
  que fuerza `use_chapters=True`** independientemente de los
  minutos (el resto sigue la heurística de longitud de v0.5.0).

#### Contrato byte-idéntico (zero regression)

- Si `preset_id` se omite en la request, el sidecar resuelve
  `narrative_epic`. El template usado es `SCRIPT_PROMPT_TEMPLATE` de
  v0.6.x **literal**, no la nueva plantilla parametrizada. Por eso
  los proyectos en curso y los tests existentes pasan sin tocar
  nada.
- `IMAGE_STYLE_BIAS["cinematic"]` es exactamente el `_STYLE_SUFFIX`
  legacy de v0.6.x. Garantizado por test (`test_presets.py`) y
  parity-check.
- `narrative_epic.markers_per_minute = 5.0` para coincidir con
  `expected_min = target_minutes * 5` del audit existente.

#### Cableado interno

- **`apps/sidecar-py/src/xianxia_ai/presets.py` (nuevo)** —
  `VideoPreset` dataclass + dict `PRESETS` con las 6 entradas +
  3 tablas de mapeo abstracto (`VOICE_TONE_TO_DESCRIPTOR`,
  `MUSIC_MOOD_TO_PROMPT`, `IMAGE_STYLE_BIAS`). 9 tests verde en
  `tests/test_presets.py`.
- **`apps/sidecar-py/src/xianxia_ai/prompts.py`** — nueva función
  `build_script_prompt(preset_id, …)`. `narrative_epic` pasa por el
  template legacy intacto; el resto pasa por
  `PRESET_SCRIPT_PROMPT_TEMPLATE` que reemplaza el bloque "STORY
  BEATS + STORY ARC" por la directiva del preset, manteniendo el
  header y el FINAL REMINDER de v0.6.x. Two-pass format
  (`.replace()` → `.format()`) para que los `{language_name}` de
  dentro de la directiva se expandan en la pasada externa.
- **`apps/sidecar-py/src/xianxia_ai/routes/script.py`** —
  `ScriptRequest`, `OutlineRequest` y `PostprocessRequest` aceptan
  `preset_id` (default narrative_epic). `_finalize_script` resuelve
  `IMAGE_STYLE_BIAS[preset.image_style]` y lo propaga a
  `_inject_auto_image_markers` y `_rewrite_image_prompts_from_narration`
  como `style_suffix` opcional. `None` ⇒ legacy.
- **`apps/desktop/src-tauri/src/pipeline/mod.rs`** —
  `GenerateRequest.preset_id: String` con
  `#[serde(default = "default_preset_id")]`. Las 4 llamadas HTTP al
  sidecar (`/script/outline`, `/script` long-form,
  `/script/postprocess`, `/script` legacy < 7 min) propagan
  `preset_id`. `cargo check` verde.
- **`apps/desktop/src/routes/generator.tsx`** — selector "Tipo de
  vídeo" en grid 2x3 con 6 chips, ubicado justo antes de "Formato"
  (decisión narrativa de primer nivel, **visible**, no enterrada en
  "Opciones avanzadas"). Estado persistido en `localStorage` draft.
  TypeScript verde.

#### Scope honesto

- **Cableado mínimo viable shippeado en 0.7.0**: prompt LLM +
  bias de estilo de imagen + paso a Rust + UI + persistencia.
- **Deferred a v0.7.1**: aplicación efectiva de
  `MUSIC_MOOD_TO_PROMPT[preset.music_mood]` en `routes/music.py` y
  de `VOICE_TONE_TO_DESCRIPTOR[preset.voice_tone]` en
  `routes/tts.py`. Las tablas existen y los tests las guardan; la
  inyección a la query de los sidecars es one-liner pero requiere
  validar que no rompa los presets de voz actuales del usuario.
- **Parity-check** ampliado con 5 invariantes nuevos sobre presets
  (los 6 ids existen, deep_dive fuerza chapters, narrative_epic
  byte-idéntico, IMAGE_STYLE_BIAS cinematic byte-idéntico,
  get_preset() fallback).

## [0.6.8] — 2026-05-20

### Iconography bleed en `_style_anchor` — RESUELTO (causa real del "imágenes iguales")

Diagnóstico con datos del run real (no teoría): el LLM SÍ produce
markers `[IMAGE: …]` diversos (Thor con martillo, Fenrir, hall de
Valhalla, barco Naglfar, runas…), pero **8 de 15 imágenes salían el
mismo árbol ardiente**. La razón estaba en `_style_anchor`: asumía que
la **primera segment del paréntesis** del setting_tag era siempre la
paleta, pero Gemma frecuentemente mete ahí un objeto concreto
("burning world-tree, ash-grey palette, ember sparks"). Como ese
prefix se inyecta al INICIO de cada prompt y CLIP pondera los tokens
iniciales, **Z-Image pintaba el árbol ardiente para todos los planos**
sin importar qué pidiera el body.

- **Fix en `_style_anchor`**: si la "palette" extraída contiene
  cualquier sustantivo de objeto concreto (tree, hammer, throne,
  runes, dragon, temple, warrior, …) — vía la nueva regex
  `_STYLE_ANCHOR_HAS_OBJECT` —, **se descarta entera** y se devuelve
  solo el head (era+cultura). Anti-drift conservado, iconografía
  ya no se estampa.
- **Loggeo evidencial**: `_rewrite_image_prompts_from_narration`
  emite ahora `image_prompt_rewrite_start` con `setting_tag` real
  (truncado) + `style_anchor` extraído + `style_anchor_iconography_dropped`
  cuando el guard rechaza una palette. Esto deja **datos crudos** en
  `sidecar-py.log` para diagnosticar cualquier futura queja sin
  especular.
- Tests unitarios: `test_style_anchor_rejects_iconography_in_first_segment`
  (caso Norse real: "burning world-tree" → entero descartado) +
  `test_style_anchor_keeps_clean_palette` (paleta cromática real
  sobrevive). **22/22 tests del sidecar verde.**

## [0.6.7] — 2026-05-20

### Spinner real, Cancelar redondeado, feedback premium por fase

Tres arreglos visuales causa-raíz, todos confirmados leyendo el código
(no teoría):

- **Spinners "estáticos" en todas las versiones — RESUELTO**. El spinner
  era `<CircleNotch className="pulse">` pero `.pulse` (`soft-pulse`) es
  **solo opacidad**, no rota; un anillo ¾ que solo se atenúa parece
  congelado. Y el `@media (prefers-reduced-motion: reduce)` mataba TODAS
  las animaciones globalmente — si Windows tiene los efectos de
  animación desactivados, ni la opacidad se movía. Fix: nuevo
  `@keyframes xnx-spin` + clase `.spin` con rotación continua, aplicada
  a los 17 spinners (CircleNotch/ArrowsClockwise en 5 archivos), y
  **excepción en el bloque reduced-motion** para que el spinner siga
  girando aunque el SO pida reduced motion (es feedback funcional, no
  decorativo).
- **Botón "Cancelar" con marco cuadrado — RESUELTO**. `.btn-destructive`
  era un modificador suelto sin `border-radius` ni caja base (esperaba
  combinarse con `.btn`, pero se usaba solo) → degradado rojo en forma
  de **cuadrado**. Fix: `.btn-destructive` autosuficiente (inline-flex +
  padding + height + `border-radius:999px` + tipografía).
- **Feedback premium por fase** (portado del prototipo
  `design/screens/generator.jsx` que nunca se portó, cableado a
  señales REALES del `pipelineStore` — cero mock): `ScriptSkeleton`
  para Guion, `Waveform` (28 barras seno) para Voz, `MusicBars`
  (ecualizador 14 columnas) para Música, **rejilla real de
  `imageThumbs`** para Imágenes, `FilmProgress` con
  `progress` real para Vídeo, `CaptionFrame` (placeholder de
  subtítulos con cursor + barra real) para Subtítulos. Visuales
  driven por `useTick` JS (no CSS) para que sigan animando bajo
  reduced-motion. Sin partículas decorativas (regla dura preservada).

Validación: tsc+vite build verde, parity-check verde, cargo check
exit 0. Acumula todo lo ya shippeado en la serie 0.6.x (ventana
macÓS opaca, permisos de ventana, diversidad determinista de
imágenes, fix engagement TRIBE v2, música/auto-optimizar ON,
biblioteca separada por formato).

> **Issue conocido pendiente** (no abordado aquí — necesita
> investigación del `pipeline/mod.rs` post-música): tras
> `music_gen_done` algunos runs no continúan al ensamblado final
> (burn-in subs + mux música + SEO + watermark + library entry). La
> generación produce todos los artefactos individuales (vídeo base,
> subs, música) pero el `video.subs.mp4` queda sin generar. Tarea
> dedicada pendiente.

## [0.6.6] — 2026-05-19

### Engagement (TRIBE v2) arreglado + música IA y auto-optimización ON por defecto

- **FIX raíz del "Analizar engagement → Failed to fetch / 500"**: NO era
  VRAM ni 8 GB. `tribev2.demo_utils.from_pretrained` envuelve su primer
  argumento en `Path()` y luego lo `str()`-ea; en Windows
  `Path("facebook/tribev2")` → `"facebook\tribev2"`, que huggingface_hub
  rechaza (`HFValidationError`) **antes de descargar nada** → el modelo
  no cargaba JAMÁS en Windows (excepción no controlada → HTTP 500, que
  el webview mostraba como "TypeError: Failed to fetch" al caer la
  conexión). Confirmado leyendo el traceback real del sidecar y el
  código de la librería (su propia docstring documenta el repo
  `facebook/tribev2` con `config.yaml`+`best.ckpt` y que acepta un dir
  local). Fix en `engagement.py::_run_tribe_inference`: resolvemos el
  repo a un **directorio local** con `snapshot_download` (el id con `/`
  se valida bien) y se lo pasamos a `from_pretrained`; al existir la
  ruta, la librería toma su rama local y nunca construye el id
  mangleado. Reintento `local_files_only` para uso offline.
- **Sin más 500 sin controlar**: `/engagement/analyze` envuelve la
  inferencia y devuelve un **503 JSON limpio** con mensaje accionable
  (no un 500 de texto plano que el webview convierte en "Failed to
  fetch").
- **Defaults ON** (petición del usuario): "Generar música con IA"
  (ACE-Step, con su fallback automático MusicGen → biblioteca) y
  "Auto-optimizar valles aburridos" arrancan activados; el análisis de
  engagement ya estaba ON, del que depende auto-optimizar.

> Caveat honesto: el fix elimina el bug de carga (probado: la rama local
> evita el mangleo) y hace que los errores sean limpios. TRIBE v2 es un
> modelo fundacional fMRI; su **descarga inicial** (varios GB) requiere
> conectividad y su inferencia en una 4060 8 GB no está validada E2E en
> esta sesión — si en ese HW no rinde, ahora **falla con mensaje claro**
> en vez de colgar/500.

## [0.6.5] — 2026-05-19

### Diversidad de imágenes — anti-repetición de sujeto determinista

Arregla la queja crónica "muchas imágenes iguales o casi iguales". Causa
raíz: el pipeline rotaba cámara/paleta/hora-del-día por índice pero
**nunca el SUJETO**; para un tema concreto-único (agujeros negros, una
persona…) cada frase narrada repite el sujeto principal → cada imagen es
el mismo sujeto recoloreado. El único guardián, `_diversify_subjects`,
**solo escribía un warning y no actuaba**.

- **`_facet_pool`** (nuevo, `script.py`): mina deterministamente — SIN
  LLM — un pool de facetas concretas distintas del tema (nombres propios
  del brief de Wikipedia ya descargado + iconografía del setting tag),
  excluyendo las palabras-cabeza del propio tema.
- **`_enforce_subject_diversity`** (nuevo): anti-repeat por **ventana
  deslizante** con Jaccard de sujetos; el beat que se solapa demasiado
  con la ventana reciente recibe la siguiente faceta no usada como
  **sujeto principal** (CLIP pondera los tokens iniciales → la imagen
  diverge de verdad). Rotación por índice, determinista. Pool vacío →
  sin cambios (degradación elegante, cero regresión).
- Se cablea en `_rewrite_image_prompts_from_narration` tras la
  destilación; `_finalize_script` le pasa el brief. Filosofía idéntica a
  la rotación determinista de v0.2.1 (las reglas blandas a Gemma siempre
  regresaron — el historial lo demuestra).
- Tests unitarios (`tests/test_subject_diversity.py`, 4 casos) +
  invariante de parity que impide volver a "solo log". 20/20 tests del
  sidecar verdes.

> Aplica a las **próximas** generaciones; un vídeo ya renderizado no se
> reescribe. La prueba visual definitiva requiere una generación real.

## [0.6.4] — 2026-05-19

### HOTFIX — UI/animaciones rotas por la transparencia (vibrancy revertida)

La ventana transparente + acrylic de v0.6.2 rompía la **composición de
WebView2**: el feedback animado de progreso del pipeline no se veía y
los botones salían lavados (el "Cancelar" como un borrón rojo sin cara
sólida). Misma clase de bug WebView2 que el documentado en v0.3.0→v0.3.1
(`backdrop-filter`/`mix-blend` se recomponen mal), pero ahora **global**
porque toda la ventana era `transparent:true`.

- **Fix**: `tauri.conf.json` vuelve a `transparent:false`, se elimina
  `windowEffects` (acrylic) y se restaura `backgroundColor` opaco;
  `globals.css` vuelve el lienzo a `#15151c` opaco. Esto restaura de
  golpe **todas** las animaciones y el render correcto de controles.
- **Se conserva** lo bueno de la ventana macOS: `decorations:false`
  (frameless), esquinas redondeadas Win11 (`shadow:true`), semáforos
  funcionales (`MacTitlebar`), arranque maximizado y los permisos
  `core:window` de v0.6.3. La ventana sigue pareciendo macOS 2026, solo
  que con fondo sólido en vez de see-through.
- Decisión: la vibrancy see-through real es inviable de forma fiable con
  este diseño Liquid Glass (cargado de `backdrop-filter`) sobre WebView2;
  romper el render de la app es peor que no tener vibrancy. Revisitable
  más adelante con una técnica segura.

## [0.6.3] — 2026-05-19

### HOTFIX P0 — ventana frameless atrapada (faltaban permisos de ventana)

v0.6.2 dejó la ventana **inutilizable**: sin marco de Windows, los
semáforos no cerraban/minimizaban/maximizaban y la ventana no se podía
mover. Causa raíz: en Tauri 2 el set `core:window:default` **no concede**
las operaciones mutadoras de ventana; con marco nativo (≤ v0.6.1) no se
notaba porque el cromo del SO las hacía, pero al ir frameless (v0.6.2)
la ventana quedaba sin ningún control.

- **Fix**: `capabilities/default.json` concede explícitamente
  `core:window:allow-start-dragging`, `allow-minimize`, `allow-maximize`,
  `allow-unmaximize`, `allow-toggle-maximize`,
  `allow-internal-toggle-maximize`, `allow-is-maximized`, `allow-close`,
  `allow-destroy`. Ahora arrastrar la ventana y los tres semáforos
  funcionan. Validado con `cargo check` (valida el schema de
  capabilities; un permiso inválido rompería el build).
- Sin esto la ventana macOS de v0.6.2 era una regresión bloqueante: hay
  que matar el proceso (Alt+F4 / Administrador de tareas). Quien
  auto-actualice se auto-cura al relanzar (updater pasivo trae v0.6.3).

## [0.6.2] — 2026-05-19

### Ventana estilo macOS 2026 (frameless + vibrancy + semáforos funcionales)

La ventana del programa deja de usar el marco nativo de Windows y pasa a
ser una ventana **estilo macOS 2026**: sin decoración del SO, esquinas
redondeadas, material translúcido y semáforos **funcionales** (no el
adorno falso de v0.6.0).

- **Frameless + vibrancy** — `tauri.conf.json`: `decorations:false` +
  `transparent:true` + `windowEffects:{ effects:["acrylic"],
  color:[20,20,27,205] }`. En Windows 11 una ventana sin decoración con
  `shadow:true` obtiene **esquinas redondeadas nativas** del DWM (sin
  hacks CSS). Configuración verificada contra la doc vigente de Tauri 2.
- **Material translúcido real** — el fondo del lienzo
  (`globals.css`) pasa de opaco a un velo graphite semitransparente
  (alpha 0.72), de modo que el acrylic nativo difumina lo que hay
  detrás de la ventana (vibrancy) sin sacrificar legibilidad. El resto
  del sistema "Liquid Glass" queda intacto.
- **Semáforos funcionales** — nuevo `MacTitlebar`: rojo = cerrar,
  amarillo = minimizar, verde = maximizar/restaurar, vía
  `getCurrentWindow()` de `@tauri-apps/api`. Los glyphs (✕ ─ +) aparecen
  al pasar el cursor por el grupo, igual que macOS. Viven en el strip
  superior izquierdo (que sigue siendo `data-tauri-drag-region`, así que
  la ventana se arrastra desde ahí). No-op seguro en modo navegador.
- **Arranque maximizado** conservado (v0.6.1).

> Nota: el efecto vibrancy/acrylic sólo es observable ejecutando la app
> en Windows 11; la validación estática (tsc + build + parity +
> `cargo check` que valida el schema de Tauri) confirma que compila y la
> configuración es válida, pero el acabado visual final se verifica al
> abrir el instalador.

## [0.6.1] — 2026-05-19

### Pulido de UI — ventana nativa, arranque maximizado, biblioteca por formato

Lote de pulido visual sobre v0.6.0. **Cambios estrictamente cosméticos**:
ni el pipeline ni los invariantes triple-gate de LTX-2.3 se tocan
(parity-check verde, default Z-Image+HyperFrames intacto).

- **Ventana estilo nativo** — eliminados los falsos puntos de semáforo
  macOS (rojo/amarillo/verde) que eran mera decoración. La ventana usa
  los controles reales del sistema operativo. Se conserva la zona de
  arrastre (`data-tauri-drag-region`) y la alineación vertical de la
  barra lateral con la barra de título nativa.
- **Arranque maximizado** — la aplicación se inicia con la ventana
  maximizada por defecto (`maximized: true` en `tauri.conf.json`;
  `decorations` nativas intactas).
- **Biblioteca separada por formato** — los vídeos horizontales (16:9 ·
  YouTube) y verticales (9:16 · Shorts / TikTok) se muestran en secciones
  diferenciadas con su propia cuadrícula y contador, en vez de mezclados
  en una sola rejilla. Cada sección se oculta si no tiene vídeos.
- **Sin frases de relleno** — retiradas las coletillas que no aportan
  ("Procesamiento 100 % local. Sin APIs externas." en la barra lateral,
  "· 100 % local" en el pie del Resumen, "100 % local." en el subtítulo
  de Smart Shorts).

## [0.6.0] — 2026-05-19

### LTX-2.3 vídeo real — opción opt-in, tier-gated (enfoque C "capa de movimiento")

Generación de vídeo real con LTX-2.3 (22B) como **opción** para hardware
capaz. **El método por defecto/principal sigue siendo SIEMPRE
Z-Image+HyperFrames, byte-idéntico** — LTX es estrictamente aditivo y
**triple-gateado**: `ltx_video_capability() != None` (auto-detección de
VRAM) **AND** modelos LTX instalados **AND** opt-in explícito del usuario.
En máquinas no capaces (p. ej. la RTX 4060 8 GB de desarrollo) no se
ofrece nada y el programa no cambia en absoluto.

- **Autodetect** — `hardware.rs::ltx_video_capability()` → `None|Gguf|Full`
  por VRAM (Full ≥ 32 GB, Gguf ≥ 24 GB, None < 24 GB; umbrales conservadores
  GPU-only, sin CPU offload). 8 GB → None (probado empíricamente: LTX-2.3
  crashea pre-denoise en 8 GB).
- **Autoinstall** — `Component` opcional `ltx23-video` (patrón aislado
  acestep/depthflow) que descarga la variante correcta por tier
  (FP8 ≥32 GB / GGUF Q4_K_M ≥24 GB) + VAE + connector + text-encoder
  Gemma-3 + nodos ComfyUI-LTXVideo. Idempotente, sólo opt-in. Nombres de
  asset verificados upstream (`docs/superpowers/ltx23-pinned-facts.md`).
- **Autoconfig** — workflows ComfyUI `ltx23_video.json` / `_gguf.json`
  (espejo de `z_image_turbo*.json`, clases de nodo reales del nodo
  instalado) + ruta `routes/ltx_video.py /clip` img2video reusando el
  cliente ComfyUI existente.
- **Pipeline engine-aware** — fase visual: si `video_engine=="ltx"` cada
  keyframe ya *grounded* (Z-Image + setting_tag + rewrite-from-narration de
  v0.5.0, intacto) se anima con LTX-2.3 img2video y se pasa por la MISMA
  clave `clip_path` que ya consumía `/render/narrative` (precedente
  DepthFlow → cero cambios en el Node). Fallback automático a HyperFrames
  por beat ante cualquier fallo. Resume v0.5.0 reutilizado, artefactos
  LTX engine-namespaced (`ltx_clip_path`, sin mezclar con DepthFlow).
- **UI** — control "Motor de vídeo" en Generador + sección en Ajustes,
  **visible/activable sólo** si capability ≠ None y modelos instalados;
  default Imágenes; Liquid Glass, sin partículas, cero datos demo.

Validación estática: `cargo test` 17/17, `pytest` 16/16, `cargo check`
0 err, `pnpm build` verde, `parity-check` (todas las invariantes,
incluido el guard "default byte-idéntico"). Revisión de **máximo rigor**
en el cambio del pipeline: confirmado que el camino por defecto es
byte-idéntico (276 inserciones, 0 borrados, todo bajo el guard
`video_engine=="ltx"`). Ejecución por subagentes con doble review
(spec+calidad) + fix-loops por tarea (se cazaron y cerraron en review:
una incoherencia instalador↔workflow↔pinned-facts y un gate de modelos
incompleto).

> **Pendiente de validación E2E en hardware capaz (≥24-32 GB VRAM):** la
> generación real con LTX-2.3 NO se pudo ejecutar/validar en la RTX 4060
> 8 GB de desarrollo (probado imposible — crashea pre-denoise). Toda la
> integración está validada estáticamente y por revisión exhaustiva, pero
> el render LTX real, los nombres de input de `LTXAVTextEncoderLoader`, el
> patrón de frames de SaveImage y la descarga de `comfy_gemma_3_12B_it.safetensors`
> deben validarse en una máquina con la VRAM requerida antes de
> considerarse probados de extremo a extremo. **No se fabricó ningún
> resultado.** El camino por defecto sí está validado E2E como siempre.

## [0.5.0] — 2026-05-19

### Capítulos largos robustos — del multi-pass ciego a outline + por-capítulo

Cierra el gap del plan v0.2.0 de vídeos largos con capítulos. El camino
corto (`target_minutes < 7`) y todos los contratos aguas abajo
(marcadores `[CHAPTER:]/[IMAGE:]/[MUSIC:]` → tarjetas en `render.ts` →
capítulos YouTube en `seo.py`) quedan **intactos y verificados**.

- **Planner + outline** — nuevo `POST /script/outline`: el LLM local
  diseña un esquema estructurado de 3-6 capítulos (título, sinopsis,
  beats, target de palabras) que escenifica el tema como un misterio,
  antes de redactar. 2 intentos; si no parsea, degrada al multi-pass
  v0.1.38 (sin romper la generación).
- **Generación por capítulo con memoria** — nuevo `POST /script/chapter`:
  cada capítulo se redacta con un *running summary* estructurado
  (qué se contó, hilos abiertos, hechos usados, último párrafo) en vez
  de los 1200 chars crudos de antes → coherencia real en vídeos de
  15-25 min, sin deriva ni repetición (Jaccard anti-repeat).
- **Post-procesado idéntico** — se extrajo `_finalize_script` (refactor
  puro, camino corto byte-idéntico) y se expuso `POST /script/postprocess`
  para que el camino long-form reutilice EXACTAMENTE el setting_tag,
  el grounding de imágenes en la narración, la inyección de marcadores y
  la diversificación de sujetos. Sin esto se reintroducían los bugs
  recurrentes de deriva xianxia y desincronía imagen/narración —
  detectado y cerrado en revisión.
- **Schema 0003 + resume granular** — `script_outline` + `chapter_state`
  (migración nueva, 0001/0002 intactas). El guion reanuda desde el
  capítulo `pending/failed` sin regenerar los `done`; el pipeline reanuda
  saltando fases caras ya completas (TTS, imágenes, música, render) cuyo
  artefacto sigue en disco (`phase_already_done`). Comando
  `reset_project_progress` para regenerar desde cero.
- **Crossfade TTS** — uniones de chunk con `acrossfade` 80 ms (cadena
  pairwise `-filter_complex`, verificada contra el ffmpeg real;
  fallback a concat crudo si falla). `duration_seconds` se mide del WAV
  final → la timeline de beats (que ya usaba duración medida) sigue en
  sync sin tocar Rust.
- **UI ChapterPreview + ETA** — lista de capítulos con estado en vivo
  (evento `pipeline:chapter`) y ETA dinámico calculado de la duración
  real de los capítulos generados. Liquid Glass, sin partículas, **cero
  datos demo** (se oculta si no hay capítulos; ETA solo con ≥1 muestra
  real, jamás fabricado).

Validación estática: `cargo test` 15/15, `pytest` 12/12, `tsc`+`vite`
verde, `cargo check` 0 errores, `parity-check` (todas las invariantes,
incluido el guard de regresión del `acrossfade`). Ejecución por
subagentes con doble revisión (spec + calidad) por tarea.

> **Pendiente de validación E2E en stack real:** el smoke real
> `tests/manual/test_longform_chapters.py` está escrito y commiteado pero
> NO se ejecutó (el LLM local no estaba arrancado en la sesión de
> implementación). Debe correrse contra un sidecar+LLM vivo, o validarse
> generando un vídeo largo desde la app, antes de considerar la feature
> probada de extremo a extremo. No se fabricó ningún resultado.
>
> **Fast-follow conocido:** `/script/postprocess` invoca `_finalize_script`
> con `context_brief=""`, así que en long-form el `setting_tag` se genera
> sin el brief RAG de Wikipedia (el camino corto sí lo pasa). El tag aún
> se infiere del topic vía el fallback puro, pero para vídeos de 20 min la
> deriva de ambientación es medible. Cerrarlo requiere que el lado Rust
> recopile y envíe un `context_brief` al postprocess (mejora aditiva, no
> bloqueante; el resto de la feature es correcto).

## [0.4.0] — 2026-05-19

### Cero datos mock: el Planificador ahora es real (E1)

El único dato simulado que quedaba en toda la app era el calendario del
Planificador (`MOCK_SCHEDULED`). Se elimina y se cablea de verdad:

- Nueva tabla-consumidora real: `db/scheduled.rs` (`ScheduledUpload`,
  `NewScheduled`, `record/list/cancel`) sobre la tabla `scheduled_uploads`
  que ya existía pero **no tenía productor** (la función de publicación
  programada estaba dormida — el cron `scheduler::run_loop` ya volteaba
  `uploaded`→`published` pero nadie insertaba filas).
- Productor añadido en la **Fase 9** del pipeline (subida a YouTube),
  best-effort (un `warn!` si falla, nunca rompe la generación): si la
  privacidad es `public` → `published`; si hay `publish_at` programado →
  `uploaded`; si queda privado → `held`.
- Comandos `list_scheduled` / `cancel_scheduled` + bindings en `tauri.ts`.
- `scheduler.tsx` reescrito: consume `tauri.listScheduled` real
  (`refetchInterval` 8 s), estados con su meta (Programado/Publicado/
  Subido·privado/Error), marcadores de calendario y lista derivados de
  datos reales, cancelación con confirmación. «Programar nuevo» → Generador.

### TikTok — publicación asistida, honesta y opt-in (E2)

TikTok no ofrece API de subida libre para creadores individuales y el
método comunitario de cookie `sessionid` viola sus ToS, está protegido
anti-bot y se rompe constantemente. Fabricar un auto-uploader contra
endpoints adivinados sería deshonesto y contra la regla del proyecto
(«verificar upstream, nunca inventar endpoints»). Por eso es **publicación
asistida** real, no un bot:

- `tiktok/` (espejo del patrón de `youtube/`): `creds.rs` guarda el
  `sessionid` en el **llavero del SO** (nunca en claro), comandos
  `tiktok_status` / `tiktok_set_session` / `tiktok_clear_session`.
- Ajustes → nueva sección «TikTok (publicación asistida)»: panel con nota
  honesta de qué es y qué no es, input opcional de `sessionid` (reservado
  para una futura ruta oficial Content Posting API).
- Biblioteca: en vídeos **verticales** (Shorts), botón «Publicar en
  TikTok» → `library_reveal_video` revela el MP4 ya renderizado
  preseleccionado en el explorador + abre el subidor web de TikTok, listo
  para arrastrar. Útil, real, sin endpoints inventados ni mock.

### Fix (integración): el cron de publicación escribía a una columna inexistente

Al verificar E1 extremo a extremo se halló un bug **pre-existente** que E1
acaba de hacer visible (la tabla estaba dormida): `scheduler::process_due`
hacía `UPDATE scheduled_uploads SET last_error = ?` pero esa columna nunca
existió en el esquema (es `error_message`). El `.ok()` se tragaba el error
en silencio, así que el motivo del fallo de publicación se perdía y el
estado «Error» del Planificador jamás mostraría la causa. Corregido al
nombre real `error_message` + se sella `last_attempt_at`. El `status`
permanece `'uploaded'` a propósito (el diseño original reintenta cada tick;
`process_due` solo selecciona `'uploaded'`) — sin regresión de
comportamiento. `sqlx::query()` no valida en compile-time, por eso `cargo
check` no lo detectó; verificado a mano contra `0001_init.sql`.

Validado: `tsc -b && vite build` verde, `cargo check` + `cargo test`
(11/11) sin errores, parity-check (todas las invariantes OK). Sin tocar el
cableado existente.

## [0.3.1] — 2026-05-19

### Repaleta: fuera el jade verde → Oro champán sobre grafito azulado (DESIGN.md v2.1.0)

A petición del usuario se elimina por completo el acento Jade Imperial verde
y el lienzo verdoso. Nueva gama (la del modal de búsqueda, que contrasta
mejor): acento **Oro champán** `#d4b85a`/`#e8c96d`, lienzo **grafito azulado**
`#15151c` con washes oro tenues, status "running/ok" en **azul sereno**
`#7fa8d8` (sin verde). Hecho vía tokens en `globals.css` (`--accent*`,
`--green`/status, `--bg-base`, body washes) + sustitución de literales jade
en chrome y pantallas. Verificado: 0 ocurrencias de jade/verde en `src`,
`tsc -b && vite build` verde. DESIGN.md → v2.1.0. Sin tocar cableado.

### Fix: artefacto gráfico "se ilumina zona random" + transparencia de overlays + feedback de click

Depuración sistemática (reproducción en dev server + Playwright). **Causa raíz**
del destello aleatorio al clicar/procesar en el Generador: `mix-blend-mode:
screen` + `filter: blur` + `backdrop-filter` en elementos **interactivos/
animados** (`.btn*::after`, `.lg-tile::after`, `.btn`, `.segmented-btn.active`)
— bajo WebView2/Chromium esa capa con blend se recompone contra el backdrop
equivocado en cada repaint (click, re-render, animación `pulse`) → flash en una
zona arbitraria. Regresión introducida por el rediseño v0.3.0 (antes, con
Tailwind, no existía). Fix de raíz, no de síntoma:

- Eliminado `mix-blend-mode: screen` de todos los `::after` de botones y
  `.lg-tile`; quitado el `filter: blur` del `.lg-tile::after` (la baldosa
  contiene el spinner que gira cada frame). Estética de gema preservada por el
  `::before` especular + box-shadows (verificado: idéntico sobre el lienzo
  oscuro). Verificado en runtime: `mix-blend-mode:screen` count 20 → **0**.
- Quitado `backdrop-filter` de `.btn` y `.segmented-btn.active` (muestrear el
  backdrop cada repaint en un elemento interactivo es el mismo hazard);
  sustituido por un gradiente translúcido más opaco, idéntico sobre el lienzo
  fijo. `backdrop-filter` se mantiene solo en vidrio estático grande.
- **Transparencia de desplegables**: `--bg-popover` pasaba 0.42 de opacidad y
  el `backdrop-filter` NO opacifica de forma fiable sobre el `<main>` que
  scrollea detrás (otro stacking context) en WebView2 → el texto traspasaba.
  Subido a `rgba(22,22,28,0.985)` (casi opaco); System popover y Command
  Palette ya no dejan ver el contenido. Verificado visualmente.
- **Feedback de click marcado**: `:active` de todos los botones ahora
  `transform: scale(.955)` + `brightness` con transición spring (antes
  `translateY(.5px)` imperceptible).

### Mejoras de UX pedidas

- **Sidebar colapsable** (rail 64 px ↔ 232 px): botón "Colapsar", persistencia
  en `localStorage`, iconos `lg-tile` en modo rail, transición spring.
  Verificado: 232→64→232 + persistencia.
- **Animaciones Motion.dev reales** (la dep `motion` ya estaba): transición de
  ruta coordinada (`AnimatePresence` en `__root`), stagger de entrada de los
  ítems del sidebar, System popover y Command Palette con spring real +
  stagger de filas. Todo `transform/opacity`, guardado por
  `prefers-reduced-motion` (`useReducedMotion`).

### Revertido

- **Partículas/canvas decorativo eliminadas por completo**: se habían añadido
  por interpretar mal "shaders"; el usuario las prohíbe en este proyecto desde
  el inicio. Componente borrado, 0 referencias. Regla dura registrada en
  memoria para no repetirlo jamás. (El prototipo macOS canónico ya las excluía;
  "más vida visual" se resuelve con micro-interacciones + Motion, nunca
  partículas.)

`parity-check.mjs` 100 % verde (cambios solo-frontend). `tsc -b && vite build`
verde. Backend Rust/Python intacto.

## [0.3.0] — 2026-05-18

### Rediseño completo de UI/UX — "Liquid Glass" (macOS / iOS 26)

Transformación integral de la interfaz al nuevo sistema de diseño generado por
Claude Design (prototipo en `/design`), **sin tocar el backend** (supervisor
Rust + sidecars Python intactos) y **sin romper cableado** (rutas TanStack,
`pipelineStore`, IPC Tauri, react-query, `data-testid` y handlers preservados
verbatim en todas las pantallas). Ejecutado por etapas con build de validación
entre cada una (la app nunca quedó rota en un paso intermedio).

- **DESIGN.md v2.0.0** "Liquid Glass": lienzo oscuro `#06120e` con washes
  jade+oro, vidrio translúcido `backdrop-filter`, acento **Jade Imperial
  `#2eb189`** + **Oro champaña `#d4b85a`**, EB Garamond/Inter/JetBrains Mono,
  Phosphor Icons. Supersede el "Celestial Dark" v1.
- **Fundación** (`globals.css`): sistema CSS bespoke portado verbatim del
  prototipo (`.btn`/`.group`/`.row`/`.lg-tile`/`.toggle`/`.range`/`.segmented`/
  `.chip`/`.kbd`/`.dot`…), coexistiendo con Tailwind durante la migración.
  Fuentes Inter + JetBrains Mono; dep `@phosphor-icons/react`. `prefers-
  reduced-motion` preservado.
- **Chrome**: shell tipo ventana macOS — Sidebar vidrio (traffic-lights,
  `lg-tile` tintados por sección, anillo de pipeline **en vivo** desde
  `usePipelineStore`), Topbar (breadcrumb por ruta + ⌘K + System popover
  cableado a hardware/sidecars/llama **reales**), nuevo **Command Palette**
  (⌘K) que navega con el router real. `ensurePipelineSubscription` y
  `KeyboardShortcuts` intactos.
- **7 pantallas portadas** preservando toda la lógica/IPC: Resumen
  (pipeline en vivo + hardware reales; sin métricas inventadas), Generador
  (todo el wizard, draft, voice cloning autoinstalable, VoiceWizard,
  `GenerateRequest` exacto, cancelación), Smart Shorts (openDialog + fetch +
  drag-drop), Biblioteca (engagement TRIBE v2 + SEO pack v0.2.14 + fullscreen),
  Planificador (calendario), Instalador (wizard + `runInstall` + eventos),
  Ajustes (servicios, LLM model browser + HF search, OAuth, YouTube, música,
  voces clonadas, componentes opcionales — todas las queries/mutations/events).
- Primitivas glass reutilizables `components/ui-glass.tsx` (PageHeader/Group/Row).
- No se portó el `TweaksPanel` ni datos demo del prototipo (tooling de diseño);
  las analíticas mock (retención/trending) se omitieron por no tener backend
  que las alimente (DESIGN.md: no inventar métricas).

Validado: `tsc -b && vite build` verde tras CADA etapa (fundación, chrome,
y cada una de las 7 pantallas); `parity-check.mjs` 100 % verde (rediseño
solo-frontend, invariantes backend intactos).

## [0.2.17] — 2026-05-18

### Mejora: marca de agua de procedencia IA (Meta AudioSeal) en el vídeo final

Segunda técnica adoptada de `debpalash/OmniVoice-Studio`: marca de agua neuronal **imperceptible** en el audio del MP4 publicado, para que el artefacto sea verificablemente generado por IA (disclosure de IA de YouTube; complementa el SEO pack v0.2.14). Fase 13 best-effort, **espejo exacto** de la fase 12 SEO: el vídeo ya está hecho, nunca bloquea, nunca propaga error (siempre HTTP 200 con `watermarked:false` + motivo si algo falla).

- Nuevo `routes/watermark.py` (`POST /watermark`) + `scripts/watermark_runner.py` (proceso hijo aislado, misma disciplina que el aligner v0.2.16) + Fase 13 en `pipeline/mod.rs`.
- **El stream de vídeo se copia bit-idéntico** (`-c:v copy`); solo se re-encodea el audio (AAC). Verificado: h264 1280×720 360 frames idénticos antes/después.
- `audioseal>=0.2` añadido a `requirements-ai.txt` (wheel puro-Python ~63 KB; deps ya presentes) → autoinstalable sin botón. La ruta además **self-healea** vía `pip install` si falta (instalaciones existentes que no re-ejecutan el wizard).
- Hallazgos integration-only resueltos (capturados por la validación, no por test directo): (1) AudioSeal dispara `torch.compile`/inductor que necesita MSVC `cl` ausente en el runtime → se fuerza ejecución eager (`TORCHDYNAMO_DISABLE`/`torch._dynamo.config.disable`); (2) AudioSeal 0.2 **no resamplea** internamente → generar Y detectar al **mismo SR nativo** (dominios distintos ⇒ detección 0); (3) marca aplicada al audio 48 k estéreo a SR nativo, misma marca mono sumada a todos los canales, sin degradar la fidelidad (el watermark está enmascarado psicoacústicamente, ~27 dB SNR es su punto de operación, no ruido blanco).

Validado: **experimento de viabilidad** (roundtrip AAC real: detección 1.000, control 0.001, vídeo bit-idéntico) + **Capa 2 (servidor bundled real)** — POST `/watermark` → `watermarked:true`, vídeo bit-idéntico, detección **1.000** en el MP4 publicado, `watermark_applied` en el log. `parity-check.mjs`: 5 invariantes nuevos (dep autoinstalable, runner aislado dynamo-off SR-nativo, ruta vídeo-intacto/never-500/self-heal, router montado, Fase 13 best-effort sin `?`).

## [0.2.16] — 2026-05-18

### Mejora: alineación de subtítulos y cortes de Shorts con precisión WhisperX (técnica de OmniVoice-Studio)

Tras revisar el repo `debpalash/OmniVoice-Studio` (misma familia arquitectónica: Tauri 2 + Rust + FastAPI + React), se adopta su técnica de mayor valor: **alineación forzada wav2vec2** (lo que WhisperX hace internamente sobre faster-whisper). Se reproduce **sin dependencias nuevas** con `torchaudio.pipelines.MMS_FA`, ya presente en el runtime bundled (torchaudio 2.5.1+cu121, verificado). Descartado de OmniVoice: su auto-offload a CPU con ≤8 GB (viola la regla dura GPU-only del proyecto).

Capa **puramente aditiva con fallback duro**: refina los timings palabra-a-palabra que produce faster-whisper. Ante cualquier problema (VRAM baja, modelo no descargable offline, error) devuelve `None` y el llamador conserva los timings originales → salida byte-idéntica a v0.2.15. El texto se preserva verbatim; solo se ajustan start/end.

- Nuevo `models/aligner.py` + `scripts/aligner_runner.py`. Aplicado en `subtitles.py` (subtítulos/karaoke ASS) y `shorts_auto.py /from_video` (mejor agrupado en frases, snap a cortes de escena y guard de cold-open negro v0.2.15, que re-deriva el texto de las palabras supervivientes).
- **Aislamiento por subproceso obligatorio** (descubierto por la validación 3 capas, no por test directo): cargar el wav2vec2 de torchaudio en el mismo proceso que faster-whisper/ctranslate2 aborta con `cudnnGetLibConfig (error 127)` — **incluso descargando whisper antes** (probado empíricamente). Choque de símbolos cuDNN a nivel de DLL/proceso; descargar el modelo Python no libera la DLL. Solución: proceso hijo limpio (patrón ACE-Step/DepthFlow) que importa solo torchaudio; su salida libera todos los handles CUDA. Gateado por VRAM, timeout acotado (8 min, cubre la descarga única de ~1,18 GB del modelo), fallback duro en cualquier fallo del hijo.

### Consolidación faster-whisper (única fuente de verdad)

Nuevo `whisper_model.transcribe_words(audio, language, *, vad)`: los thresholds permisivos anti-drop (que protegen la PRIMERA frase de la narración, antes solo en `subtitles.py`) viven ahora en un único sitio. `shorts_auto.py /from_video` migra a él conservando `vad=True` (vídeo arbitrario) pero heredando esos thresholds → los Shorts dejan de perder las primeras palabras (las que llevan el gancho).

### Auditoría aditiva (cero cambio de comportamiento observable)

- Fase 12 SEO en `pipeline/mod.rs`: captura y registra **por qué** se omite (HTTP status / error de request) en vez de tragarlo en silencio; el motivo llega al log y al mensaje de UI. Sigue siendo best-effort, nunca bloquea.
- Verificado que `/shorts/auto` ya tenía guard de `req.words` vacío (no se añade código redundante).

Validado: **Capa 1 (directo)** — narración real española con tildes, 96/96 palabras refinadas, texto verbatim, timings monotónicos, 100 % afinados. **Capa 2 (sidecar bundled real)** — POST `/subtitles` en el servidor FastAPI real con ctranslate2 residente en su proceso: `aligner_refined 96/96` + SRT/ASS escritos, **sin error-127** → aislamiento confirmado en el contexto real del servidor. `parity-check.mjs`: 8 invariantes nuevos (aislamiento del aligner, runner limpio sin imports de transcripción, helper consolidado, fallback duro en subs/Shorts, export del módulo, diagnóstico Fase 12).

## [0.2.15] — 2026-05-16

### Fix: los Shorts abrían en negro (cold-open sobre la intro oscura)

Reportado con captura: el clip #1 mostraba ~1-6 s de imagen casi negra con un leve resplandor antes de aparecer contenido. Diagnóstico con frames reales extraídos de los MP4 generados: el short en sí está bien a partir de los ~2 s (Sun Wukong nítido, captions Hormozi), pero **arranca en negro**. Causa raíz: `render.ts` añade un segmento de intro `INTRO_SEC = 6.0` — los primeros 6 s de TODO vídeo narrativo son una title card animada **sobre negro puro** (con música underscore, sin narración). Al cortar un Short desde el inicio, el clip hereda ese cold-open negro — letal para la retención (el espectador desliza en el primer segundo). `blackdetect` confirmó negro de 0.02 s → 5.99 s en el short.

Fix (`routes/shorts_auto.py`, **guard en Shorts**, sin tocar el render long-form):
- Nuevo `_black_leadin_seconds()`: sondea con ffmpeg `blackdetect` (umbral por píxel `pix_th=0.10`) cuántos segundos near-black hay AL INICIO del candidato (solo cuenta una racha que empieza en el corte, no un beat oscuro a mitad).
- Nuevo `_guard_black_open()`: adelanta el `start` del candidato hasta el primer frame brillante. Topado para no comerse el contenido (≤ mitad del clip, ≤ 8 s, el resto debe seguir ≥ `min_duration`); re-deriva el `text` de las palabras supervivientes para que el hook del LLM refleje la apertura real; clips < 8 s intactos; cualquier fallo de ffmpeg → candidato sin tocar (best-effort).
- Se aplica a cada candidato elegido **antes** de generar hooks y cortar, en **ambos** endpoints (`/shorts/from_video` y `/shorts/auto`).
- Como la narración del vídeo narrativo empieza justo cuando acaba la intro de 6 s, recortar el negro **alinea el Short para abrir en el primer frame brillante exactamente cuando empieza la primera palabra** — no se pierde nada.

Validado contra un vídeo real con el bug (intro de 6 s): @0 detecta 6.12 s y adelanta el corte; @12 (imagen brillante) → no-op; clip corto → intacto. `parity-check.mjs`: 2 invariantes (helpers + blackdetect pix_th + `import re`; guard en ambos endpoints antes del cut).

100 % local, content-agnóstico (sirve para cualquier MP4 subido, no solo los nuestros). El render narrativo / la intro de marca no se tocan.

## [0.2.14] — 2026-05-16

### SEO metadata pack local — del MP4 a "listo para subir" (100 % local, sin APIs)

Hueco real del flujo: la app producía el vídeo pero el usuario escribía a mano título, descripción, tags y capítulos antes de subir a YouTube. Inspirado en la *capa de operaciones* de herramientas públicas de automatización de YouTube — pero con la filosofía **opuesta**: cero APIs cloud. La única llamada a modelo es el LLM local que ya escribió el guion; el resto es Python determinista (reproducible y gratis).

Nueva ruta sidecar **`POST /seo`** (`routes/seo.py`) + `SEO_PROMPT_TEMPLATE` en `prompts.py`:
- **Título + 3 variantes**: el LLM propone 6 candidatos; post-proceso determinista elige el óptimo (45-70 car., keyword principal presente, Title Case, tope duro 100).
- **Descripción por idioma**: hook en los primeros ~125 caracteres (lo que indexa YouTube), "📺 LO QUE VERÁS", "⏱️ CAPÍTULOS", "📝 SOBRE ESTE VÍDEO", hashtags, crédito de música. Cabeceras localizadas (en/es/pt/fr/de/it/zh/ja/ko/ru/hi/ar).
- **Capítulos con timestamps REALES**: derivados de los marcadores `[CHAPTER:]` del guion (los mismos tiempos que usa el vídeo), respetando las reglas de YouTube (primero en 0:00, ≥3, ≥10 s). Si el guion no los cumple → **no se inventan** (la deshonestía de timestamps fijos del repo de referencia se descarta a propósito).
- **Tags** con presupuesto de 500 caracteres, dedupe y priorización (keyword principal > secundarias > tema > long-tail).
- **Hashtags** ≤15, slug Unicode-safe.
- **SEO score** (0-100) con rúbrica honesta (longitud de título, keyword en título y en primeros 125 car., longitud/estructura de descripción, nº de tags, capítulos, hashtags).
- Degradación robusta: si el LLM falla o devuelve JSON inválido, **nunca rompe** — cae a keywords minadas de la narración.

Integración:
- **Pipeline (Fase 12, best-effort)**: tras el render, `wake_llm` + `POST /seo`; escribe `seo.json` + `seo.txt` (listo para copiar/pegar) junto al MP4. Nunca bloquea el pipeline (el vídeo ya está hecho). La Fase 1 ahora persiste `script.txt` para poder regenerar SEO retroactivamente.
- **Biblioteca**: panel "Generar metadatos SEO" en cada tarjeta (mismo patrón que el panel de engagement) con score, título+variantes, descripción multi-idioma con pestañas, tags, hashtags y capítulos — cada bloque con botón **Copiar**.
- `parity-check.mjs`: 5 invariantes (ruta local sin APIs + chapters de markers, router montado, prompt, fase 12 best-effort + script.txt, panel UI con copiar).

ACE-Step/MusicGen y el resto del pipeline no se tocan.

## [0.2.13] — 2026-05-16

### Fix DEFINITIVO de xformers: eliminado, MusicGen usa atención torch SDPA nativa

xformers se intentó autoinstalar en v0.2.7/0.2.8/0.2.9 (cada versión falló en el paso `pip`). Investigación definitiva contra el runtime real (Python 3.11.15, torch 2.5.1+cu121, win_amd64, 2026-05-16):

- **PyPI por defecto** → `xformers==0.0.28.post3` solo tiene **sdist** (no wheel Windows) → pip compila desde fuente en un entorno aislado sin torch → `ModuleNotFoundError: No module named 'torch'`.
- **Índice PyTorch cu121** (`--index-url`, el "fix" de v0.2.9) → solo hospeda xformers **hasta 0.0.27.post2**; `0.0.28.post3` no existe ahí → `No matching distribution found` (fallo inmediato).
- **`--only-binary=:all:` en PyPI** → las versiones saltan de `0.0.27.post2` a `0.0.29.post2`: **no existe NINGÚN wheel precompilado de xformers** que empareje con torch 2.5.1+cu121 en py3.11/Windows, en ningún índice.

Conclusión: xformers es **estructuralmente ininstalable** para este runtime — y **no hace falta**. Es solo un acelerador *opcional* de audiocraft 1.3.0. Pero `MusicGen` construye su LM con `memory_efficient=True`, y audiocraft mezcla esa flag con imports duros de xformers que **NO están protegidos por el switch de backend** y disparan en cadena al construir/generar (verificado en la fuente real, traza a traza):
1. `transformer.py:193/731` `_verify_xformers_memory_efficient_compat()` — guard de import en `__init__` (revienta al construir el modelo).
2. `transformer.py:241-242` `_get_mask` → `from xformers.ops import LowerTriangularMask` (cada paso de generación).
3. `transformer.py:54` `_is_profiled()` → `from xformers.profiler import profiler; profiler._Profiler._CURRENT_PROFILER` (cada capa).
4. `transformer.py:377` `q,k,v = ops.unbind(packed, dim=2)` — `ops` se fija al importar `transformer.py` (`from xformers import ops` → `None` si falta) → `None.unbind` peta a mitad de generación.

**Solo** la *llamada* final de atención respeta el backend (`transformer.py:415-419`): con `'torch'` corre `torch.nn.functional.scaled_dot_product_attention`; el `LowerTriangularMask` se usa únicamente como centinela causal truthy y `memory_efficient_attention` jamás se llama.

Fix (`_force_torch_attention()` en `routes/music.py`):
- Registra un **shim no-op de xformers en `sys.modules`** (`xformers`, `xformers.ops`, `xformers.profiler`) con `LowerTriangularMask` (centinela), `unbind`=`torch.unbind`, `memory_efficient_attention`/`profile` que lanzan si se llaman (nunca con backend torch), y `profiler._Profiler._CURRENT_PROFILER=None`. Satisface TODOS los imports duros sin xformers real.
- `set_efficient_attention_backend("torch")` → el cómputo real va por SDPA nativo de PyTorch.
- Rebind defensivo `_axt.ops = sys.modules["xformers.ops"]` (cubre el caso en que `transformer.py` ya se importó con `ops=None` antes del shim).
- Se invoca en `_musicgen` **antes** del `from audiocraft.models import MusicGen`, así el shim ya está en `sys.modules` cuando `transformer.py` fija su `ops` global. `XFORMERS_DISABLED=1` a nivel módulo.
- Eliminados `_XFORMERS_PIN` y toda la maquinaria `_ensure_xformers()` (pip).
- **`requirements-music.txt`**: `xformers==` eliminado (con comentario de por qué NO re-añadirlo).
- **`server.py`**: eliminado el warmup `_warm_xformers` del lifespan (dead code que lanzaba un pip fallido en cada arranque).
- **`parity-check.mjs`**: invariantes reescritas (shim `sys.modules`, rebind `ops`, backend torch, sin `_ensure_xformers`, requirements sin xformers, server sin warmup).

Validado **end-to-end contra el runtime real** (2026-05-16, RTX 4060): con xformers totalmente ausente, MusicGen-medium **construye Y genera** audio real — `wav (1,1,128000)`, 4 s @ 32 kHz, RMS 0.205, peak 0.974, no-silente. ACE-Step (generador principal) corre en su venv aislado cu128 y no se ve afectado; MusicGen es el fallback GPU y ahora es autosuficiente sin dependencias ininstalables.

## [0.2.12] — 2026-05-16

### Fix Shorts: "no candidate segments found in transcript" (HTTP 400)

El pipeline completo (incl. ACE-Step) generó perfecto, pero los Shorts fallaban con `HTTP 400: no candidate segments found in transcript`. Causa raíz confirmada en logs (`shorts.from_video: whisper unloaded after transcription` → error inmediato): la narración TTS-clone es muy fluida y casi no tiene pausas ≥0.4 s, así que `_group_into_sentences` (que solo partía por silencios) colapsaba un vídeo de ~4 min en 1-3 "frases" gigantes, cada una más larga que el `max_duration` de un short (60 s). `_candidate_segments` no podía formar ninguna ventana [25-60 s] → lista vacía → 400 que mataba toda la función de Shorts.

Fix (`routes/shorts_auto.py`, afecta a `/shorts/auto` y `/shorts/from_video`):
- **`_group_into_sentences` ahora parte por TRES señales** en vez de solo silencios: (1) gap ≥0.4 s, (2) la palabra previa termina en puntuación terminal (`. ! ? … 。！？`, robusto a ES/CJK), (3) cap de duración `max_sentence_dur`=12 s. La puntuación da fronteras de frase reales aunque el TTS no haga pausas; el cap es red de seguridad content-agnóstica.
- **`_candidate_segments` red de seguridad**: si aun así no hay candidatos pero existe transcript, emite UN candidato best-effort acumulando desde el inicio hasta `max_d` (o todo) si supera `min_d`. Nunca devuelve vacío con transcript usable → ya no hay 400 que tumbe los Shorts.

## [0.2.11] — 2026-05-16

### Fix: el pipeline "se reseteaba" al cambiar de sección

Bug reportado: iniciar una generación y navegar a otra sección hacía que, al volver, el progreso del pipeline apareciera reseteado (fases, thumbnails, proyecto activo). Causa: la generación corre en el backend Rust y NUNCA se detiene, pero el estado de progreso vivía en `useState` de `generator.tsx`; TanStack Router desmonta el componente al cambiar de ruta → estado borrado → al volver, componente remontado vacío (parecía reseteado aunque el backend seguía trabajando).

Fix (state architecture):
- **`apps/desktop/src/lib/pipelineStore.ts`** (NUEVO): store Zustand a nivel módulo (vive fuera del árbol de componentes) con `activeProjectId / phaseState / imageThumbs / error` + acciones. Filtro de project-id idéntico al anterior (`!aid || id===aid`).
- **`__root.tsx`**: `ensurePipelineSubscription()` registra los listeners de eventos del pipeline UNA vez en el layout raíz (que nunca se desmonta al navegar) → los eventos siguen actualizando el store aunque la ruta del generador no esté montada.
- **`generator.tsx`**: ahora es un lector puro del store. Eliminados sus `useState` de progreso, su `useEffect` de suscripción a eventos y el `activeRef`. `handleStart`/abort usan acciones del store.

Resultado: cambiar de sección y volver muestra el estado real y vivo de la generación en curso. (La recuperación tras recargar la app entera — no solo navegar — requiere una query al backend del run activo; queda como mejora separada, no es el bug reportado.) Parity-check: 3 invariantes nuevas que blindan que el progreso viva en el store y la suscripción esté en el root.

## [0.2.10] — 2026-05-15

### Seguridad del stack + limpieza dead-code (sin romper nada)

**Auditoría de dependencias** (`pnpm audit`): 4 vulnerabilidades, todas en deps **transitivas** de `apps/sidecar-node` (servidor local 127.0.0.1, no expuesto → riesgo real bajo, pero se parchea por higiene):
- **high** `fast-uri ≤3.1.1` (host confusion vía auth percent-encoded) — vía `fastify › @fastify/ajv-compiler`.
- **moderate** `hono <4.12.18` (CSS Declaration Injection en JSX SSR) — vía `hyperframes`.
- **moderate** `hono <4.12.18` (Cache Middleware ignora Vary: Authorization/Cookie).
- **low** `hono <4.12.18` (validación NumericDate de claims JWT).

Fix: `pnpm.overrides` en el root pinando `fast-uri ≥3.1.2` y `hono ≥4.12.18`. Ambos bumps **dentro del mismo major** → API-compatibles (`hyperframes` ya requiere `hono ^4.0.0`; `fast-uri` 3.1.1→3.1.2 es solo patch de seguridad). Blast radius mínimo: no toca ninguna dep directa. `pnpm audit` post-fix → **"No known vulnerabilities found"**. sidecar-node recompila sin errores (hyperframes intacto).

**Python**: runtime ya al día (fastapi 0.115, starlette 0.46.2, aiohttp 3.13.5, requests 2.32.5, urllib3 2.6.3, pillow 11.3) — sin CVEs conocidos, sin acción.

**Dead-code eliminado** (`cargo check` pasa de "2 warnings" a **cero**):
- `Supervisor::unload_llama()` (sidecars/mod.rs) — superseded por el flag `.llamacpp_suspended` + `_kill_llamacpp_process` (Python). Nunca cableado.
- `write_active_config()` (installer/llamacpp.rs) — superseded por `routes/models.py` que escribe `active.json` (contrato T3). `active_config_path()` / `read_active_config()` siguen en uso (ruta de lectura) → sin huérfanos.

## [0.2.9] — 2026-05-15

### ACE-Step v1.5 = generador PRINCIPAL de música (sin toggle, autoinstalable)

Corrección de diseño: v0.2.8 dejó ACE-Step como opt-in con componente manual del wizard — eso exigía 2 pasos manuales y contradecía el principio del proyecto (todo auto-detectable/instalable/configurable). v0.2.9 lo hace **principal e incondicional**:

- **`scripts/acestep_bootstrap.py`** (NUEVO): auto-instala el venv aislado en background — idempotente, crea `runtime/acestep-venv` (torch 2.7.1+cu128) + clona `ACE-Step-1.5@v0.1.7` en `runtime/acestep-repo` + nano-vllm `-e` + repo `-e --no-deps`. `is_ready()` / `ensure_async()` (daemon thread, lock).
- **`server.py`**: hilo de boot que llama `acestep_bootstrap.ensure_async()` (junto al warmup de xformers). Se instala durante las fases largas previas a música; cero acción del usuario.
- **`routes/music.py`**: ACE-Step es el primer intento SIEMPRE que se pide música IA (`want_ai_music = use_musicgen or use_acestep`). `_acestep_v15` nunca lanza: si el venv aún se instala / falla → None → MusicGen → biblioteca. Además dispara el bootstrap on-demand si el venv no está listo (no bloquea ese run).
- **Eliminado todo el opt-in**: `app_settings.acestep_enabled` + comando + registro lib.rs + `AcestepServiceRow` Settings + helper tauri.ts + flag `use_acestep` del pipeline. ACE-Step no tiene toggle. El componente installer Rust se mantiene como acelerador opcional de pre-instalación.
- `generator.tsx`: el toggle de música ahora dice "Generar música con IA" y explica que ACE-Step se autoinstala en segundo plano.

### Fix xformers auto-install (#241)

`pip install --no-deps xformers==0.0.28.post3` fallaba con `ModuleNotFoundError: No module named 'torch'` (no había wheel prebuilt en PyPI default → pip compilaba desde sdist en build-isolation sin torch). Fix: `--index-url https://download.pytorch.org/whl/cu121` (wheel prebuilt para torch 2.5.1+cu121). Aplica al boot warmup y on-demand. MusicGen (fallback de ACE-Step) ahora sí genera real.

### Fix imágenes: setting_tag fino, sin objetos omnipresentes (#242)

Causa confirmada con prompts reales (run Dioses olímpicos): el setting_tag completo — con objetos concretos `(deep ultramarine and gold, marble temples, olive groves, thunderbolts, celestial feasts)` — se inyectaba **prefijo + sufijo en CADA imagen** → todas compartían rayo/templo/olivos pese a que el beat narrara otra cosa. Fix: `_style_anchor()` extrae solo época+cultura+**paleta** (descarta los nombres de objeto) e inyecta **solo prefijo** (sin la duplicación sufijo). Mantiene anti-drift y cohesión de color; cada imagen ahora fiel a su momento narrado (el distiller ya varía sujeto/cámara/luz por beat). Aplicado a las dos rutas de construcción de prompt.

## [0.2.8] — 2026-05-15

### ACE-Step v1.5 (mejor generador música open-source) — opt-in, venv aislado

`ace-step/ACE-Step-1.5` v0.1.7 pinea `torch==2.7.1+cu128` (choca con la torch 2.5.1+cu121 del sidecar) + `nano-vllm` local. Integrado con el **patrón DepthFlow** (venv aislado + runner por subprocess), NO en el venv del sidecar:

- **Componente installer `python-deps-acestep`** (`AssetKind::AceStepVenv`, `acestep_venv_install` en runner.rs): crea `runtime/acestep-venv` con torch 2.7.1+cu128, clona `ACE-Step-1.5@v0.1.7` en `runtime/acestep-repo`, instala `nano-vllm -e` + repo `-e --no-deps`, smoke-test. flash-attn omitido (runner usa `use_flash_attention=False`).
- **`scripts/acestep_runner.py`**: corre en el venv aislado, API verificada (`AceStepHandler.initialize_service(config_path="acestep-v15-sft", offload_*=False)` + `generate_music(... thinking=False, instrumental=True)`), GPU-only (sin offload, 2B SFT <4 GB), checkpoint `ACE-Step/Ace-Step1.5` se baja solo al primer uso.
- **`routes/music.py` `_acestep_v15()`**: opt-in vía `use_acestep`. Detecta venv+repo+runner, pre-check VRAM ≥4.5 GB, subprocess con timeout 40 min. **NUNCA lanza excepción**: ante cualquier problema (venv ausente, VRAM, error, timeout) devuelve None → cae a MusicGen → biblioteca. El pipeline jamás se bloquea.
- **Opt-in gateado** como Ollama: `app_settings.acestep_enabled` (default false) + comando `app_settings_set_acestep_enabled` + toggle en Settings + flag `use_acestep` que el pipeline Rust lee fresco cada generación. `/music/backends` reporta `acestep_available` real.

Calidad: ACE-Step v1.5 supera objetivamente a MusicGen en instrumental cinematográfico multi-minuto (benchmark SongEval 8.09). Por defecto sigue MusicGen (zero-config) hasta que el usuario active el opt-in.

### Imágenes cohesivas (setting_tag robusto) + MusicGen autoinstalable

Validado v0.2.7 end-to-end OK (run Sun Wukong → `video.subs.mp4`). Dos mejoras de calidad/robustez sobre esa base estable:

**A — `_generate_setting_tag` robusto** (`routes/script.py`). Gemma 4B abliterated fallaba ~50% (`setting_tag_all_attempts_failed`) → caía a un placeholder genérico ("period-correct iconography, scene-appropriate palette") → imágenes que convergían visualmente aunque el rotador shot/palette/tod variara la composición (queja real del usuario: "imágenes muy parecidas entre sí"; el run que "lo hizo bien" fue uno donde el LLM acertó el tag — no-determinismo, no regresión). Fix de 3 partes:
- Prompt con **3 ejemplos few-shot** concretos (Journey to the West, Egipto, cyberpunk) mostrando el formato exacto — Gemma necesita ejemplos, no solo reglas.
- **Picker de línea inteligente** (prefiere la que tiene `setting` + paréntesis, no la primera) + criterio relajado (≥18 con paréntesis vs ≥15 ciego) + 4º intento con temperatura escalada.
- **Fallback temático determinista**: deriva era/cultura de la 1ª-2ª frase del brief Wikipedia ya descargado en vez del placeholder genérico → ancla CLIP fuerte aunque el LLM falle.

**B — xformers auto-install** (`routes/music.py` + `server.py`). MusicGen necesita xformers; faltaba → `ImportError` → 500 → SIEMPRE fallback a librería (MusicGen nunca generaba). Pedir "reinstala el componente" viola el principio del proyecto (todo autoinstalable). Solución de 2 capas, sin acción del usuario:
- **Boot warmup**: hilo background al arrancar el sidecar instala xformers durante las fases largas previas a música.
- **On-demand**: si aún falta en `/music`, `pip install xformers==0.0.28.post3 --no-deps` en el venv runtime (no toca la torch existente) + reintento.
- Si ambas fallan → fallback limpio a librería; la instalación persiste → siguiente run MusicGen funciona.

### Parity-check
Invariantes nuevas: whisper-evict ya cubierto en v0.2.7; v0.2.8 añade music.py auto-install xformers + server.py boot warmup. (setting_tag mantiene la invariante de rotación shot/palette/tod existente.)

## [0.2.7] — 2026-05-15

### Fix definitivo del deadlock de subtítulos + MusicGen real + TTS robusto

Validando v0.2.6 end-to-end (run Sun Wukong) se confirmó: thumbnail ✅ (Fix 1+2, sin cuelgue 30 min), carga de whisper ✅ (Fix 3, 6.9 s vs deadlock 15 min). Pero apareció un fallo más profundo en la misma fase y dos problemas de calidad:

**A — Whisper residente durante la traducción (causa del `pipeline failed`)**
La ruta `/subtitles` hacía transcribe + translate en la misma request **sin descargar whisper**. Durante la traducción ES→EN: whisper (~3 GB) + llama-server (~3 GB) co-residentes en 8 GB → CUDA Sysmem-fallback thrash → cada una de las 41 llamadas LLM tardaba 15-46 s en vez de ~3 s → 882 s totales → el timeout rust de 15 min mataba el pipeline aunque la ruta Python completaba a los 16.9 min. Fix: `routes/subtitles.py` descarga whisper de VRAM (`whisper_model.unload()` + `gc` + `empty_cache` + `synchronize`) tras `subtitles_source_written` y antes del bucle de traducción. Evento nuevo `subtitles_whisper_unloaded_pre_translate`.

**B — Timeout rust `/subtitles` 15 → 30 min** (`pipeline/mod.rs`). Red de seguridad: un long-form con muchas entradas × varios idiomas es legítimamente minutos de LLM aunque esté sano.

**C — Traducción batcheada** (`routes/subtitles.py` `_translate_entries`). Era 1 llamada LLM por entrada, secuencial (41 round-trips). Ahora `XIANXIA_TRANSLATE_BATCH` (12) entradas por llamada con protocolo numerado estricto y escalera de robustez: batch → 1 reintento → fallback per-entrada → fallback inglés. Nunca falla; siempre produce SRT/ASS.

**D — xformers para MusicGen** (`requirements-music.txt`). MusicGen lanzaba `ImportError: xformers is not installed` → HTTP 500 → SIEMPRE caía a librería (nunca generaba música real). Añadido `xformers==0.0.28.post3` (build exacto para torch 2.5.1+cu121 del runtime; declara `torch==2.5.1` así que pip no mueve torch).

**E — TTS clone robusto** (`pipeline/mod.rs`). El TTS clone (~7 GB) tardó 17 min vs ~2.5 normales por presión VRAM de apps de escritorio → thrash. La POST `/tts` **no tenía timeout** (un cuelgue real colgaría el pipeline para siempre). Añadido: `ensure_comfyui_vram` best-effort antes (reclaim de lo que controlamos; nunca aborta porque TTS es obligatorio) + timeout 25 min en `/tts` (acota un hang real → falla limpio en vez de colgar infinito).

### Parity-check

Invariantes nuevas: whisper unload antes de traducir, timeout `/subtitles` 30 min, `_translate_entries` batcheado, xformers en requirements-music, timeout `/tts`.

## [0.2.6] — 2026-05-15

### Drop completo de ACE-Step v1.5 → MusicGen-only GPU-only

ACE-Step v1.5 queda **retirado del pipeline**. Razones (investigación del repo oficial https://github.com/ace-step/ACE-Step y testing en RTX 4060 8 GB Windows):

- En 8 GB VRAM ACE-Step necesita `cpu_offload=True` (lo dice el README oficial). Sin offload, en Windows el driver entra en *thrash* WDDM y el sampler nunca termina — síntoma idéntico al [issue #87 "stuck at 0%"](https://github.com/ace-step/ACE-Step/issues/87) (abierto sin respuesta desde mayo 2025) y al [#344](https://github.com/ace-step/ACE-Step/issues/344) (OOM en 8 GB).
- Con offload, partes del modelo viven en RAM y rompen la **regla dura GPU-only** del proyecto (engram `feedback_no_cpu_offload`).
- El repo upstream no tiene release tag ni mantiene el inference loop desde enero 2026. Las dependencias se rompen con cada bump de `transformers` ([issue #354](https://github.com/ace-step/ACE-Step/issues/354)).

**Backend único v0.2.6**: MusicGen-medium fp16 GPU-only.

- Cabe en ~3.5 GB VRAM sin offload.
- Long-form vía chunks de 30 s con crossfade 4 s (ya implementado).
- Pre-check VRAM ≥ 4 GB antes de cargar → 503 limpio + fallback a librería local si no hay margen.
- Pipeline rust mantiene timeout 12 min + fallback a librería local. Cero stalls posibles en fase de música.

### Cambios concretos

- `apps/sidecar-py/src/xianxia_ai/routes/music.py` — eliminado `_acestep()`, `_have_acestep()`, `_ACESTEP_MIN_FREE_VRAM_GB`, `mood_to_prompt_acestep()`, `_MOOD_BASE_ACESTEP`. `_musicgen()` ahora con pre-check VRAM 4 GB y `set_device(0)`. `/music/backends` devuelve `acestep_available: false` por compatibilidad wire (eliminado del response en v0.2.7).
- `apps/sidecar-py/requirements-music.txt` — eliminada línea `acestep @ git+...`, solo queda `audiocraft>=1.3.0`.
- `apps/desktop/src-tauri/src/installer/manifest.rs` — componente `python-deps-music` renombrado a "MusicGen-medium (música cinematográfica generada en GPU)", tamaño 6 GB → 4 GB.
- `apps/desktop/src-tauri/src/installer/verify.rs` — `acestep_installed` siempre `false` (campo se mantiene un release más por compat), check de paquete `acestep` removido.
- `apps/desktop/src/lib/tauri-shim.ts` — check ACE-Step removido del browser-mode summary.
- `apps/desktop/src/routes/generator.tsx`, `settings.tsx`, `install.tsx` — labels y descripciones actualizadas.
- `apps/desktop/src-tauri/src/pipeline/mod.rs` — comentarios actualizados (el timeout 12 min ahora cubre MusicGen, no ACE-Step).
- `apps/sidecar-py/src/xianxia_ai/routes/unload.py`, `scripts/depthflow_runner.py`, `installer/{manifest,runner}.rs` — comentarios limpiados.
- README.md fila Música actualizada.

### Plan de retirada total (v0.2.7)

- Eliminar `acestep_available` del response `/music/backends`.
- Eliminar campo `acestep_installed` de `StackSummary`.
- Tras este release queda sin trazas en el code base.

## [0.2.0] — 2026-05-12

### Migración mayor — llama.cpp como runtime LLM primario (Ollama queda como fallback)

v0.1.x usaba Ollama (con `xianxia-llm` = Gemma 4 abliterated GGUF) como única ruta para script + metadata + shorts detection + traducción. v0.2.0 introduce **llama.cpp** (https://github.com/ggml-org/llama.cpp) como runtime alternativo: comparte los mismos GGUFs (descarga cero adicional para usuarios v0.1.x), corre en `:8733` paralelo a Ollama, y se autodetecta vía health probe. La abstracción `LLMBackend` desacopla los call sites de cualquier runtime concreto.

**Por qué llama.cpp**:
* Soporte directo de GGUF arbitrarios sin tener que envolverlos en un Modelfile de Ollama.
* OpenAI-compatible `/v1/chat/completions` + `response_format: json_schema` con GBNF (garantía estructural, no solo "valid JSON").
* Menor footprint en VRAM (sin keep_alive, sin daemon residente — el proceso muere cuando se cierra la app).
* Releases binarios por flavor de hardware (CUDA / Vulkan / Metal / CPU) sin compilar nada.

### Añadido

* **`apps/sidecar-py/src/xianxia_ai/llm_backend.py`** — abstracción `LLMBackend` ABC con dos impls: `OllamaBackend` (legacy `/api/chat`) y `LlamaCppBackend` (`/v1/chat/completions`). `get_backend()` con modo `"auto"` (default): probe a `:8733/health`, fallback Ollama. Selector vía env `XIANXIA_LLM_BACKEND={llamacpp,ollama,auto}`.
* **`apps/desktop/src-tauri/src/installer/llamacpp.rs`** — installer Rust del binario llama-server. 6 flavors auto-detectados desde `crate::hardware::detect_hardware()`: WindowsCuda12, WindowsVulkan, WindowsCpu, MacosArm64, LinuxVulkan, LinuxCpu. Tag pinned `b9114` (configurable de un solo punto). Para Windows CUDA descarga ADEMÁS el bundle cudart (DLLs runtime) y lo extrae junto al binario. Tauri commands `llamacpp_status` + `llamacpp_install` expuestos al frontend.
* **`apps/desktop/src-tauri/src/installer/llamacpp.rs::LlmModelConfig`** — esquema de configuración del modelo activo (`<data_dir>/models/active.json`). Campos: gguf_path, context_size, gpu_layers, flash_attention, chat_template, threads/batch/ubatch, parallel, extra_args, model_id/architecture/quantization. `to_args()` genera el argv estable para `llama-server`.
* **`apps/sidecar-py/src/xianxia_ai/gguf_meta.py`** — parser KV del header GGUF, **cero deps externas** (no requiere el pip package `gguf`). Extrae `general.architecture`, `tokenizer.chat_template` (Jinja embedded — CRÍTICO), context_length, embedding_length, block_count, eos/bos. `quantization_from_filename()` regex captura Q4_K_M / Q5_K_S / IQ3_XS / F16 / BF16 desde el nombre.
* **`apps/sidecar-py/src/xianxia_ai/llm_recommender.py`** — reglas estilo llmfit (https://github.com/AlexsJones/llmfit) reimplementadas en Python. Computa `gpu_layers` desde VRAM disponible × bytes-por-capa, `context_size` capped a training ctx, `flash_attention` si vram_gb≥6 + GPU NVIDIA/Apple. Sampling defaults por familia tomados de `generation_config.json` oficiales: Gemma (temp 1.0, top_p 0.95, top_k 64), Qwen3 (0.7/0.8/20), Llama 3.1 (0.6/0.9/50), Mistral (0.7/0.95/50), Phi-3 (greedy), DeepSeek (0.6/0.95). Cada recomendación incluye `rationale: list[str]` que la UI muestra.
* **`apps/sidecar-py/src/xianxia_ai/routes/models.py`** — endpoints `/models/*` montados en server.py:
  * GET /models/local — escanea `<data_dir>/models/` + legacy `hf-cache/hub` (cero re-descargas para v0.1.x users).
  * POST /models/inspect — dump completo de metadata GGUF con KV bounded.
  * POST /models/recommend — auto-config dado un GGUF (probe `/install/hardware`).
  * GET /models/search?q= — HuggingFace API `/api/models?filter=gguf&sort=downloads`.
  * GET /models/files?repo_id= — lista quants disponibles en un repo HF con sizes.
  * POST /models/download — `huggingface_hub.hf_hub_download` resume-friendly, también baja README.md.
  * POST /models/activate — calcula recomendación + escribe `active.json` atomically + llama `llm_backend.reset_backend()`.
  * GET /models/active, POST /models/delete.
* **Supervisor en `apps/desktop/src-tauri/src/sidecars/mod.rs`** — `spawn_llama_server` con `LlmModelConfig.to_args()`. CWD = dir del binario (Windows CUDA encuentra cudart DLLs adyacentes sin tocar PATH). `spawn_llama_if_needed()` skip silencioso si no hay install o GGUF descubierto. `probe_llamacpp` acepta 200/503 (llama.cpp emite 503 durante warmup mmap). `unload_llama()` público para `/unload?target=llm`. `XIANXIA_LLM_BACKEND` propagado al Python sidecar.
* **`apps/desktop/src/routes/settings.tsx::LlmModelPanel`** — nueva sección "Modelo LLM (llama.cpp)" con: runtime status + botón "Instalar llama.cpp", tarjeta del modelo activo, lista de GGUFs locales con "Activar", buscador HF inline con resultados expandibles + "Descargar + activar".

### Migración v0.1.x → v0.2.0

* **Zero-config**: el default `XIANXIA_LLM_BACKEND=auto` hace que el backend probe llama.cpp primero y caiga en Ollama si no responde. Sin acción del usuario, todo sigue funcionando como v0.1.x.
* **GGUFs reutilizados**: `discover_default_config()` escanea `<data_dir>/hf-cache/hub/models--*/snapshots/*/*.gguf` (la cache HF que ya tienes de v0.1.x). El supervisor spawns llama-server con el primer GGUF que encuentre, sin re-descargar nada.
* **UI**: para forzar llama.cpp el usuario instala el runtime y activa un modelo desde Settings → Modelo LLM. Una vez activo, `models/active.json` declara la elección y `reset_backend()` lo reflecta en caliente.

### Refactor

* 10 callsites Python que hacían `httpx.post("…:11434/api/generate")` directo migrados a `llm_generate(...)` que rutea por el backend abstracto:
  * `routes/script.py` (7 sites: /script principal, /metadata, key_facts extraction, setting_tag, visual distillation, /suggest, /hooks)
  * `routes/shorts_auto.py` (2: scoring + viral hook generation)
  * `routes/subtitles.py` (1: translation pipeline)
  * `routes/shorts.py` (ya usaba `llm.generate()` desde v0.1.10 — re-encajado en la nueva abstracción)
* `routes/unload.py` — `_unload_llm()` reemplaza `_unload_ollama()`. Acepta target `"llm"` (canónico v0.2.0) y `"ollama"` (alias retrocompat).
* `routes/diag.py` — `_llm_running()` reemplaza `_ollama_running()`. Campo `/diag/vram::llm_running` con tag de backend.

### Parity check

`scripts/parity-check.mjs` ampliado de 22 a **35 invariantes**. Las 13 nuevas validan:
* T2: `llamacpp.rs` define LLAMACPP_TAG + pick_flavor + active config; lib.rs registra los Tauri commands.
* T3: supervisor implementa spawn/probe/respawn de llama-server; `XIANXIA_LLM_BACKEND` propagado al Python con default "auto".
* T4: gguf_meta.py + llm_recommender.py existen; routes/models.py expone los 5 endpoints clave; server.py monta el router; active.json es el contrato compartido con T3.
* T5: tauri.ts exporta los 4 helpers críticos; settings.tsx renderiza LlmModelPanel; tauri-shim.ts stub para browser-mode.
* T6: llm_backend.py implementa el routing "auto".
* T1: ningún route POSTea a `/api/generate` directo (debe usar `llm_generate`).

## [0.1.23] — 2026-05-07

### Corregido — transición `inkwash` horrible en narrative pipeline

* `apps/desktop/src-tauri/src/pipeline/mod.rs::normalise_beat_timeline`
  cicleba transitions cross / flash / cross / **inkwash** / whip. El
  inkwash es un *clip-path circle iris* que cierra con círculo negro
  y vuelve a abrir. En videos donde dos beats consecutivos muestran
  composiciones similares (mismo personaje, mismo escenario, mismo
  prompt → ComfyUI genera imágenes muy parecidas), el iris se abre
  sobre una imagen casi idéntica → "cierre y apertura sobre la misma
  imagen" — el usuario lo describió como "extremadamente horrible".
* Cycle nuevo: `cross / flash / cross / whip`. Cross-fade domina (3
  de 4 slots) que es la transición más segura cuando dos beats son
  visualmente similares. Flash y whip se intercalan para acento.
* El test `transitions too repetitive` sigue pasando (≥ 2 kinds
  distintos en el ciclo).

## [0.1.22] — 2026-05-07 (sprint completo OpusClip-grade)

### Smart shorts OpusClip-grade — basado en research, no en suposiciones

Investigación previa con 4 agentes paralelos (Playwright sobre opusclip.com,
github-research-expert sobre clones OS, Context7 sobre HyperFrames + faster-whisper,
Explore sobre código actual) reveló que el "dinamismo" de OpusClip no viene de
zoom punches forzados — viene de active speaker tracking + Hormozi captions
auténticos + segments coherentes con el contenido visual del source.

* **Captions Mozi-style**: 2-3 palabras por grupo, una activa en amarillo +
  scale-punch, outline negro grueso de 8 direcciones (no pill background),
  font 96 px, hard-cut entre grupos sin overlap. Refactor del template
  `apps/sidecar-node/src/templates/short.html` + render.ts groups builder.
* **Active speaker tracking** vía mouth-region std-dev (lip-movement proxy
  pure-OpenCV, sin pyannote, sin HF token) que reemplaza `max(area)` cuando
  hay múltiples caras detectadas.
* **Dual-mode reframe automático**: tight crop con cinematography para
  shots con cara dominante (>6 % área, presencia >40 %), blur-fill 16:9
  para shots cinemáticos wide. Hard cuts entre modos = sensación de edición
  OpusClip.
* **Parallax en blur mode**: bg blureado zoom 1.0 → 1.04 + drift ±20 px,
  fg sharp zoom 1.0 → 1.025 + drift opuesto ±8 px → sensación de profundidad
  real. Soft-feather 16 px en bordes top/bottom para mezcla suave.
* **Tight mode = composición fija** (mediana de samples confiables) +
  Ken Burns slow zoom 1.0 → 1.04 con smoothstep ease. Cero pan dentro
  del segmento → cero movimientos erráticos.
* **PySceneDetect threshold 18** (vs 27): detecta los cuts naturales del
  anime, ningún cut artificial sintético sobre los reales (los sintéticos
  cortaban shots por la mitad → "imágenes inconexas con audio").
* **Face-presence scoring** multiplicativo: candidatos con
  `face_pres < 30 %` se penalizan a 40 % del score; segments con caras
  visibles consistentemente reciben hasta +10 % boost. Evita elegir
  segments sin contenido visible.
* **HyperFrames composición duración** = clip + 1.2 s tail buffer →
  el CTA card tiene tiempo de aparecer sin truncar el final.

### Corregido — bugs reales, validados e2e

* **Deadlock subprocess.PIPE en stderr** (raíz del cuelgue de v0.1.19/0.1.21).
  ffmpeg sin `-nostats` escribe progreso por frame; con `stderr=PIPE` y sin
  drainer, el buffer 64 KB se llena al ~frame 138 y ffmpeg bloquea el
  `write(stderr)` mientras Python espera dentro de `proc.wait()` → infinito.
  Fix: `-hide_banner -nostats -loglevel error` + quitado `-movflags +faststart`
  del encode primario (segundo camino al hang con NVENC + close-stdin).
* **Mediapipe legacy** (`mp.solutions`) eliminado en 0.10.x → AttributeError
  silencioso → personajes con cabezas cortadas. Reemplazado por cascadas
  Haar + perfil de OpenCV (zero-deps, 100 % hit rate validado).
* **Whisper unload tras transcripción** libera handle cuDNN antes de YOLO
  load (los dos cargando cuDNN simultáneamente segfaultaba el FastAPI
  worker con `Could not load symbol cudnnGetLibConfig`).
* **YOLOv8 tier postponed a v0.1.23** (subprocess-aislado): aun con whisper
  unloaded el segfault persistía en el mismo proceso. Decisión técnica
  documentada — Haar + saliency cubren el caso para shorts con caras
  detectables (60 %+ del video del usuario tiene caras Haar-detectables).
* **HyperFrames `<video src="">` placeholder**: render.ts ahora valida
  clip_path antes de stage.copy y `throw` si falla → no más HTTP 500 con
  cryptic 45 s de espera + "first frame not decoded".
* **Captions overlap** entre grupos consecutivos (groupOff demasiado tarde,
  fade out solapaba con fade in del siguiente). Fix: hard-cut cuando
  gap < 0.25 s, hard-kill `visibility: hidden` 0.15 s después del fade.

### v0.1.23 abierto

Sprint dedicado a artefactos del **narrative pipeline** (parallax 2.5D,
rembg masks): el video largo que la app genera tiene a veces halos en
bordes y composición errática. v0.1.20 añadió validación de mask pero
no es suficiente.

## [0.1.22 RAW] — el verdadero cuelgue de Pass 2 (deadlock subprocess.PIPE)

* **Diagnóstico definitivo**, validado e2e contra el vídeo real del
  usuario (`01KR14TA79VG8T68ZMFXYGQ430/video.mp4`, 1920×1080 24 fps,
  segmento 12 s-32 s):
  * v0.1.19 (lectura secuencial Pass 1) y v0.1.21 (release+reopen del
    cap antes de Pass 2) **no arreglaron el bug original**. El cap
    nunca era el problema.
  * El bug es un deadlock clásico de `subprocess.PIPE`: el comando
    ffmpeg de Pass 2 se llamaba sin `-nostats`, así que ffmpeg
    escribía una línea de progreso por cada frame (`frame=N fps=X
    q=Y...`) al stderr. Como `Popen(stderr=subprocess.PIPE)` no tiene
    lector en background, el buffer del pipe (~64 KB en Windows) se
    llena alrededor del frame 138 y ffmpeg bloquea su siguiente
    `write(stderr)`. Mientras tanto Python está dentro de
    `proc.wait()`, que sólo lee stderr DESPUÉS de que ffmpeg salga,
    y ffmpeg no puede salir porque está bloqueado escribiendo:
    interbloqueo perfecto, infinito.
  * Combinar `-movflags +faststart` con NVENC + el cierre de stdin
    es un segundo camino al mismo cuelgue (la fase de mover el moov
    al inicio del fichero también se atasca).
* **Fix integral en `apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py`**:
  * Añadidos `-hide_banner -nostats -loglevel error` al subprocess
    de Pass 2 → ffmpeg ya no escribe progreso, pipe nunca se llena.
  * Eliminado `-movflags +faststart` del encode primario. El MP4
    resultante deja el moov al final del fichero — formato estándar
    aceptado por YouTube y todos los players nativos. Si una futura
    feature necesita streaming progresivo desde el primer byte, se
    añade un post-pass `ffmpeg -i out.mp4 -c copy -movflags +faststart`
    que es prácticamente instantáneo.
* **Validación e2e** (script `test_pass2_fix.py`):
  * Pass 1: 21.8 s (97 muestras ROI sobre 480 frames)
  * Pass 2: 6.4 s (481 frames piped + encode NVENC + close limpio)
  * MP4 final: 37 MB, 481 frames, 20.04 s, h264+aac, rc=0, moov válido
* La razón por la que no se detectó antes: en una corrida normal con
  `-progress -` o `stderr=DEVNULL` el bug no aparece. La combinación
  `stderr=PIPE` + sin `-nostats` es la que lo dispara, y solo
  importaba para clips suficientemente largos como para superar 138
  frames de buffer. Los smart shorts del usuario tenían exactamente
  ese tamaño.

## [0.1.21] — 2026-05-07

### Corregido — smart short se quedaba colgado en Pass 2 (mismo bug de v0.1.10 replicado)

* `apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py::_smart_reframe_to_vertical`
  El fix de v0.1.19 sustituyó el random-seek de Pass 1 por lectura
  secuencial pero **olvidé aplicar el mismo cambio a Pass 2**. Tras
  terminar Pass 1 el `cv2.VideoCapture` queda con el cursor en EOF;
  llamar a `cap.set(CAP_PROP_POS_FRAMES, start_f)` para volver al
  inicio del segmento se cuelga indefinidamente en x264 MP4 con
  keyframes dispersos (síntoma observado: `pass1 done` aparece en el
  log, luego 4 + minutos de Python a 128 % CPU sin un solo heartbeat,
  ffmpeg vivo escribiendo un MP4 de 48 bytes sin `moov` atom).
  Solución integral: liberar y re-abrir el `VideoCapture` al empezar
  Pass 2 — un único seek hacia adelante sobre un cap nuevo es
  instantáneo. Mismo patrón que ya usa Pass 1.
* Añadido log `pass2 done: N frames in T s (rc=K)` para que cualquier
  futura regresión sea visible en el JSONL al final del encode.



### Corregido — recortes mal hechos en parallax 2.5D

* **rembg producía masks rotos en planos detalle** (caras zoom, abstractos,
  screenshots): cobertura ínfima o saturada, múltiples blobs disjuntos.
  El composite resultante se veía con cabezas flotantes, fragmentos de
  ropa sueltos, espadas a la deriva. Ahora `apps/sidecar-py/src/xianxia_ai/routes/depth.py`
  valida cada mask: si la cobertura cae fuera de `[4%, 92%]` o si hay
  más de 4 componentes conectados significativos (≥0,4 % de área), el
  beat se marca como **single-layer** (sin separación bg/fg) y se
  registra un warning con `coverage` y `components` para diagnóstico.
* **Pan del foreground excedía los bordes**: el rango previo (`±90 px`)
  contra una escala de `0.96→1.02` dejaba el sujeto fuera de cuadro en
  composiciones donde el personaje estaba cerca del borde — visible
  como espadas/manos cortadas. Reducidos los rangos en
  `apps/sidecar-node/src/templates/narrative.html` a `bg ±18`, `mid ±38`,
  `fg ±55`, y subida la escala mínima de fg a `1.06` para garantizar
  overhang en los cuatro bordes durante todo el pan.
* **Pipeline Rust** (`apps/desktop/src-tauri/src/pipeline/mod.rs`):
  cuando el sidecar devuelve `fg_path=""` ya no se asigna
  `foreground_path` al beat, así el template Node lo renderiza como
  `<img class="single">` (que la animación trata como Ken Burns suave)
  en lugar de un composite con un png FG vacío.



### Corregido — smart shorts se colgaba indefinidamente

* `apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py::_smart_reframe_to_vertical`
  Pass 1 hacía `cap.set(CAP_PROP_POS_FRAMES, X)` random seek por cada
  sample. En MP4s con keyframes dispersos cada seek tarda segundos
  enteros y, peor, en algunas combinaciones codec/contenedor se cuelga
  indefinidamente. El usuario reportó un short que estuvo > 7 min sin
  avanzar (ffmpeg vivo pero esperando frames del pipe que nunca
  llegaban). Refactor a **lectura secuencial** desde `start_f` con
  modulo skip — sin seeks aleatorios.
* Añadido logging de progreso cada 50 samples (Pass 1) y cada 60
  frames (Pass 2). Si vuelve a quedarse colgado, en el JSONL se ve
  exactamente en qué sample ocurrió en lugar de tener que matar
  ffmpeg a ciegas.
* Bug colateral: `_cut_short` llamaba `log.warning(...)` si el smart
  reframe fallaba, pero `log` no estaba importado en el módulo —
  cualquier error real se transformaba en `NameError` y un 500 sin
  contexto. Añadido `log = logging.getLogger("xianxia.shorts")` al
  top del archivo.

## [0.1.18] — 2026-05-07

### Mejorado — Voice cloning realmente autoinstalable (sin botón)

Hasta ahora el banner de voice cloning aparecía con un botón "Instalar voice
cloning (7 GB)" que el usuario tenía que pulsar manualmente. El usuario pidió
explícitamente que TODO sea **autodetectable, autoinstalable y autoconfigurable**
— pulsar un botón rompe esa promesa.

* `apps/desktop/src/routes/generator.tsx`:
  - **Auto-trigger silencioso de la instalación**: un `useEffect` detecta
    `cloningStatus.base_model_installed === false` + `registered_clones > 0`
    y dispara `install_optional_component('model-qwen-tts-base')` en
    background **sin que el usuario tenga que hacer nada**. Una sola vez
    por sesión (protegido por `useRef` flag).
  - **Banner cambia de estado en vivo**:
    1. Mientras descarga → banner verde "Instalando voice cloning
       automáticamente…" con spinner, **sin botón** ni decisión.
    2. Si todo va bien → banner desaparece solo cuando el polling cada
       5 s detecta `base_model_installed: true`. Las voces clonadas
       aparecen en el dropdown automáticamente.
    3. Si falla (sin internet, antivirus, etc.) → banner ámbar con
       botón "Reintentar instalación" como red de seguridad. NO
       toast de error scary durante el auto-attempt silencioso.
* La generación normal NO se bloquea durante la descarga: el usuario
  puede seguir generando con voces preset mientras Base se baja en
  background.

### Notas

* La auto-instalación NO se reintenta automáticamente si falla — se
  marca el flag `autoInstallAttempted` para evitar bucles si la red
  sigue mal. El usuario puede reintentar manualmente con el botón del
  banner ámbar.
* `tauri.installOptionalComponent('model-qwen-tts-base')` ya emite
  eventos de progreso de descarga internamente; el polling de
  `/tts/cloning/status` cubre la transición de "downloading" a
  "installed" sin recargar la app.

## [0.1.17] — 2026-05-07

### Añadido — Selectores separados de idioma audio + idiomas subtítulos en la UI

* `apps/desktop/src/routes/generator.tsx` deja de tener el viejo
  multi-toggle "Idiomas" (que confundía audio con subs). Ahora son
  **dos campos independientes**:
  - **Idioma del audio (narración)** — single-select, 10 idiomas
    (EN/ES/ZH/JA/KO/DE/FR/IT/PT/RU). Define en qué idioma se genera el
    script y se sintetiza el TTS, y filtra el catálogo de voces.
  - **Idiomas de subtítulos (multi)** — multi-select sobre los mismos
    10 idiomas. Cada uno produce SRT + ASS. El idioma del audio aparece
    marcado con badge "audio" y no se puede desmarcar (porque es el que
    se quema en el MP4 final). Los demás van como pistas externas para
    YouTube.
* `GenerateRequest` (TypeScript + Rust) gana los campos
  `audio_language: string` y `subtitle_languages: string[]`. El campo
  legacy `languages` se sigue enviando con backcompat (audio en `[0]`).
* `apps/desktop/src-tauri/src/pipeline/mod.rs` lee los nuevos campos
  primero y cae al `languages` antiguo cuando no están — usuarios con
  drafts anteriores no pierden nada.
* `/subtitles` ahora recibe `source_language=audio_language` y
  `target_languages=subtitle_languages` (con la audio language
  garantizada en la lista para que el burn-in tenga su pista).

### Añadido — Banner UI con instalación inline de voice cloning

* Cuando hay clones registradas o el usuario selecciona una voz
  `clone:*`, aparece encima del select un banner ámbar con el texto
  contextual de `/tts/cloning/status` y un botón **"Instalar voice
  cloning (≈7 GB)"** que invoca `install_optional_component(
  "model-qwen-tts-base")` directamente desde el wizard — sin saltar
  a Ajustes.
* La query a `/tts/cloning/status` se refresca cada 5 s mientras Base
  no esté instalado, así que en cuanto la descarga termina el banner
  desaparece y el dropdown desbloquea las voces clonadas en vivo.
* Toasts de progreso: "Descargando Qwen3-TTS Base…" → "Voice cloning
  instalado" o el error específico si algo falló.

### Notas técnicas

* Auto-detección sin reinicio: `tts_base_model.is_available()` escanea
  el HF cache en cada request, así que en cuanto el installer extrae
  los pesos el sidecar Python las ve sin necesidad de reload.
* El selector de audio fuerza la inclusión del idioma elegido en
  `subtitleLanguages` para que el burn-in nunca se quede sin pista.
* Backcompat 100 %: el campo `languages` sigue presente en el
  payload, así que comandos `start_generation` antiguos siguen
  funcionando idéntico.

## [0.1.16] — 2026-05-07

### Corregido — voice cloning real (no más "error decoding response body")

* `apps/sidecar-py/src/xianxia_ai/routes/tts.py::_do_synthesize_clone`
  ahora carga el modelo correcto. El bundled `Qwen3-TTS-1.7B-CustomVoice`
  **no soporta voice cloning** (lo confirma el model card oficial:
  https://github.com/QwenLM/Qwen3-TTS), solo `generate_custom_voice()`
  con preset speakers. La variante `Qwen3-TTS-1.7B-Base` es la que
  expone `generate_voice_clone()`.
* Antes: el endpoint `/tts` lanzaba un `ValueError` no manejado →
  FastAPI 500 sin body JSON → Rust pipeline reportaba "error decoding
  response body" sin nada accionable para el usuario.
* Ahora: cuando una voz registrada como clone se selecciona, la
  función swapea el modelo (unload de CustomVoice → load Base) y llama
  a `generate_voice_clone()`. Si Base no está instalado retorna 503
  con un `detail` claro: "Voice cloning requires the Qwen3-TTS-Base
  model (≈7 GB) and it's not installed yet. Open Ajustes → Componentes
  opcionales → Voice Cloning to download it."

### Añadido — Voice cloning como componente opcional autoinstalable

* `apps/sidecar-py/src/xianxia_ai/models/tts_base_model.py` (nuevo) —
  loader paralelo al `tts_model` con `is_available()` que escanea el
  HF cache para detectar si los pesos del Base están descargados,
  `load()` con `local_files_only=True` para evitar descargas en hot
  path, y `unload()` para liberar VRAM.
* `apps/desktop/src-tauri/src/installer/manifest.rs` registra
  `model-qwen-tts-base` (≈7 GB, `Qwen/Qwen3-TTS-12Hz-1.7B-Base`,
  target `models/tts-base`) con `required: false` — el usuario lo
  instala desde **Ajustes → Componentes opcionales** cuando quiere
  voice cloning. Una vez descargado se autodetecta sin reiniciar la
  app.
* Endpoint nuevo `GET /tts/cloning/status` devuelve
  `{base_model_installed, registered_clones, hint}` para que la UI
  muestre el banner correcto sin tener que adivinar.
* `list_voices` filtra automáticamente las voces `kind="clone"` del
  catálogo cuando `is_available()` devuelve `False` — el usuario no
  puede seleccionar una clone que no se podría ejecutar (mejor que ver
  el error sólo al darle a Generar).

### VRAM lifecycle

* Custom + Base no caben simultáneamente en 8 GB (cada uno ≈7 GB).
  El swap es secuencial: si una request llega con `is_clone=True` y
  CustomVoice está cargado, se hace `tts_model.unload()` antes de
  `tts_base_model.load()`. La siguiente request preset hará el swap
  inverso. Coste: ~15-25 s por swap en RTX 4060.

## [0.1.15] — 2026-05-07

### Mejorado — Shorts virales con HyperFrames-enhanced composition (OpusClip-grade)

Smart reframing v0.1.13 producía un vertical limpio pero sin overlays: solo el clip + ASS quemado. v0.1.15 añade un **segundo pase HyperFrames** que compone encima del vertical reframed:

* **Hook overlay (1.5–2 s al inicio)** — frase enganche generada por Gemma 4B con system prompt agresivo ("4 a 8 palabras MAX en el idioma del transcript, shock/curiosity/promise"). Pop-in con `back.out(2.0)` + breath sutil + pop-out al terminar.
* **Captions animados word-by-word** — cada palabra se compone como `<span class="word">` con dos children apilados (white base + yellow active overlay). GSAP timeline anima:
  - Pop-in 80 ms antes de oírse: `opacity 0→1 + y 22→0 + scale 0.85→1` con `back.out(2.5)`.
  - Active highlight: el yellow span aparece con `opacity 0→1` + scale 1→1.10 al inicio de la palabra, vuelve al final.
  - Group fade-out cada 5 palabras para no saturar la pantalla.
  - Sub que hace HyperFrames-ofical: opacity-only para el cambio de color (color/background/clipPath NO están en la lista de properties soportadas oficialmente, así que se evita).
* **Progress bar inferior** con `scaleX 0→1` linear sobre toda la duración del clip + gradient `#ffd23f → #ff6b35`.
* **CTA card final 1.5 s** — fondo opaco (#08080e 94 %) con título grande pop-in `back.out(2.5)` + sub-line con slide-up. Copy localizada por idioma detectado por Whisper (en/es/zh/ja/ko/de/fr/it/pt/ru).
* **Vignette + bottom gradient** persistente para legibilidad de captions sobre cualquier escena.

### Investigación HyperFrames

* Leído `node_modules/hyperframes/dist/docs/{compositions,data-attributes,gsap,examples,rendering}.md` y `skills/hyperframes/patterns.md`. Reglas críticas adoptadas:
  - **Wrapper div sin `data-*`** alrededor del `<video>` para poder controlar opacity desde CSS — la runtime fuerza `opacity:1` a cualquier elemento con `data-start`/`data-duration` mientras está activo.
  - **GSAP properties oficialmente soportadas**: opacity, x, y, scale, scaleX/Y, rotation, width, height, visibility. Nada de animar `color`/`background` directamente — se sustituye con opacidad apilada.
  - **Timeline siempre `paused: true`** y registrada en `window.__timelines["short"]`. La runtime maneja play/seek.
  - Sentinel `tl.set({},{},DURATION)` para que el renderer no corte antes del último tween.

### Cambios

* `apps/sidecar-node/src/templates/short.html` — reescrito como composition v2 con 6 layers GSAP-animadas + comentarios extensos sobre las reglas de HyperFrames.
* `apps/sidecar-node/src/render.ts::renderShort` acepta ahora `{clip_path, duration, hook, words, cta_title?, cta_sub?, out_path}` y construye el HTML con divs por palabra.
* `apps/sidecar-node/src/server.ts` — endpoint `/render/short` actualizado al nuevo schema.
* `apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py`:
  - Nuevo `_render_enhanced_short_via_hyperframes()` POSTea al Node tras el smart reframe.
  - Nuevo `_generate_short_hook()` llama a Gemma con system prompt en mayúsculas para forzar el idioma del transcript + hook 4-8 palabras.
  - `_cut_short()` extendido con kwargs `enhanced_words`/`enhanced_hook`/`enhanced_cta_*` y fallback automático al ASS burn-in si la pasada HyperFrames falla.
  - `_CTA_DEFAULTS` localizada por idioma (10 idiomas).
  - El call site de `/shorts/from_video` pre-genera hooks en serie antes del bucle (Ollama 4B 1-3 s/hook).

### Notas técnicas

* Pipeline para cada Short: Pass 1 smart reframe (~2× tiempo real) → hook gen (~2 s) → Pass 2 HyperFrames (~3-4× tiempo real) ≈ 5-7× tiempo real total. Para un Short de 45 s, ~4 min de procesamiento en RTX 4060 8 GB.
* Captions HTML+GSAP > ASS quemado: edges nítidos sobre cualquier resolución (Chromium subpixel), sin artefactos libass al panear, animación rica imposible en ASS.
* El ASS legacy se sigue generando como **safety net**: si la pasada Node falla por cualquier razón, `_cut_short` cae al `_burn_subs_into_vertical` y el Short se entrega con captions quemados aunque sin overlay rico.
* Hook localization: Gemma 4B abliterated escribe en el idioma del transcript gracias al system prompt + uso de `info.language` de Whisper como contexto. Si Whisper detecta "es", el hook sale en español.

## [0.1.14] — 2026-05-07

### Corregido — /script ignoraba el idioma seleccionado en la UI

* `apps/sidecar-py/src/xianxia_ai/routes/script.py::generate_script` ahora
  acepta `languages[0]` (el primer item del array `languages` enviado por
  la UI) y mapea IETF tag → nombre completo (en/es/zh/ja/ko/de/fr/it/pt/ru
  con variantes). El nombre se inyecta en `SCRIPT_PROMPT_TEMPLATE` como
  `{language_name}` y se refuerza con un **system prompt agresivo en
  mayúsculas**: `"YOU MUST WRITE THE ENTIRE NARRATION IN {LANGUAGE}."`.
* `apps/sidecar-py/src/xianxia_ai/prompts.py::SCRIPT_PROMPT_TEMPLATE`
  reescrito con bloque LANGUAGE no-negociable triplicado (apertura,
  sección dedicada, recordatorio final): el modelo Gemma 4B abliterated
  por sí solo ignoraba la instrucción cuando estaba enterrada en el
  cuerpo del prompt; con la triple capa + system override ya respeta
  el idioma sin desviarse al inglés.
* Verificado e2e: pidiendo `language=es` el script sale ahora literalmente
  en español ("Desde el corazón de las Montañas Ancestrales…"), los
  marker bodies (`[IMAGE: …]`, etc.) se mantienen en inglés (correcto
  porque son instrucciones del pipeline, no parte de lo que el viewer
  oye), y el TTS Qwen3-TTS-1.7B con `language=Spanish` ahora puede
  leer texto realmente español en lugar de pronunciar inglés "a la
  española".

### Notas técnicas

* El bug venía de v0.1.12: ese release ya corrigió el TTS hardcoded a
  "English" → ahora respeta el idioma seleccionado, pero la
  **generación del script base** seguía siendo en inglés. El TTS
  recibía `language=Spanish` y leía un script inglés, lo que producía
  audio raro con palabras inglesas pronunciadas como si fueran
  españolas. v0.1.14 cierra el círculo.
* El system prompt mayúsculas + repetición triplicada es necesario
  porque Gemma 4B abliterated tiene un "default mode" muy fuerte
  hacia el inglés cuando recibe prompts técnicos largos. La
  redundancia es deliberada — modelo pequeño, instrucción clara.

## [0.1.13] — 2026-05-07

### Mejorado — Smart reframing OpusClip-like en /shorts/from_video

* `apps/sidecar-py/src/xianxia_ai/routes/shorts_auto.py::_cut_short` ya
  no es un center crop tonto. Cuando el source es 16:9 (o cualquier
  aspect > 9:16) ahora corre `_smart_reframe_to_vertical()`:
  - **Pass 1 — ROI tracking**: muestrea el clip a ~5 fps y, por cada
    frame, busca el sujeto dominante usando mediapipe FaceDetection
    (modelo de larga distancia, conf > 0.45). Si no detecta cara,
    cae a `cv2.saliency.StaticSaliencyFineGrained` y toma el centroide
    de masa del mapa de saliencia (cubre screencasts, paisajes, UI,
    etc.).
  - **Smooth pan trajectory**: EMA con α=0.15 sobre `(cx, cy, zoom)`.
    El primer frame parte del primer sample para que no haya snap
    inicial. Todas las posiciones quedan clamped dentro del frame
    original — no se introducen barras negras.
  - **Adaptive zoom 1.0×–1.45×**: ROI pequeño (cara distante o icon)
    aumenta el zoom hasta 1.45×; ROI grande mantiene 1.0×. Suaviza
    también con la misma EMA.
  - **Pass 2 — render**: re-lee frames en orden, calcula ventana
    `(src_h/zoom × 9/16, src_h/zoom)` centrada en `(cx, cy)`,
    Lanczos-resize a 1080×1920 y emite BGR24 raw por stdin a ffmpeg
    que lo muxea con el slice de audio del source y el master loudnorm
    (-14 LUFS / -1.5 dBTP).
  - **Burn-in en pasada separada** sobre el vertical ya reframeado
    para que el ASS quede en el sistema de coordenadas 1080×1920 (no
    en el original) y nunca se salga de la zona segura.
  - **Fallback**: si mediapipe / saliency no están disponibles, o si el
    source ya es ≤9:16, conserva el viejo center-crop como
    `_cut_short_center_crop()`. Un Short se produce SIEMPRE.
* `_probe_dimensions()` con ffprobe (en lugar de abrir cap OpenCV
  para una sola property) para decidir si el reframe inteligente
  aplica.

### Notas técnicas

* Aspect ratio target: 9:16 = 0.5625. El umbral `src_ar > target_ar*1.05`
  evita reprocesar vídeos que ya son verticales o casi-cuadrados.
* Cada Short tarda ~2× tiempo real con NVENC en RTX 4060 8 GB
  (limitado por mediapipe + cv2.read; el encode es prácticamente
  gratis). Para un Short de 45 s eso son ~90 s de procesamiento.
* mediapipe + opencv-contrib están en el runtime instalado de la
  app (`apps/sidecar-py/requirements-vision.txt`). No requiere
  instalación adicional para usuarios upgradeados.

## [0.1.12] — 2026-05-07

### Corregido — multi-idioma audio (TTS hardcodeaba inglés)

* `apps/desktop/src-tauri/src/pipeline/mod.rs` Phase 3 hardcodeaba
  `"language": "English"` en la llamada a `/tts`, ignorando el idioma
  marcado en la UI. Ahora mapea `languages[0]` (IETF tag) → nombre
  Qwen3 ("en"→English, "es"→Spanish, "zh"→Chinese, "ja"→Japanese,
  "ko"→Korean, "de"→German, "fr"→French, "it"→Italian, "pt"→Portuguese,
  "ru"→Russian) y se lo pasa al TTS. La fase emite ahora "Sintetizando
  voz en {idioma}…" para feedback visual. Los subtítulos ya estaban
  bien (source = primary, targets = lista completa); el bug afectaba
  solo al audio.

### Añadido — animación de subtítulos más expresiva

* `_word_karaoke_ass` y `_segment_karaoke_ass` ahora emiten cada
  Dialogue con un cocktail de animaciones libass:
  - `\fad(120,160)` — fade asimétrico (entrada rápida, salida suave).
  - `\fscx88\fscy88` inicial + `\t(0,220,\fscx100\fscy100)` — pop-in
    desde 88 % a 100 % en los primeros 220 ms (la línea "salta" a
    pantalla en lugar de aparecer cortada).
  - `\an2` explícito para anclar al borde inferior.
  Mantiene la legibilidad y las reglas anti-overlap de v0.1.11.

### Mejorado — bordes parallax (rembg sin halos)

* `apps/sidecar-py/src/xianxia_ai/routes/depth.py`:
  - Pre-erode del mask antes del Gaussian blur: el sujeto se hace
    1-2 px más estrecho dentro del recorte, eliminando los píxeles
    semi-transparentes que arrastraban color del fondo original
    (los halos verdes/dorados visibles cuando el FG se compone sobre
    otro fondo durante el parallax).
  - Curva gamma 0.85 sobre el alpha tras el blur: endurece la zona
    alta-opacidad sin tocar el borde de transición. Evita el look
    "pegatina recortada".
  - **Decontamination del FG**: en píxeles con alpha entre 30 y 200
    (la franja soft-edge), se mezcla 35 % el color medio del interior
    del sujeto. Reemplaza el color residual del fondo original que
    rembg deja en bordes semitransparentes — el principal causante
    visible de los halos.
  - Dilatación del mask de inpaint subida de `radius/2` a `radius*1.5`,
    así la zona reconstruida del bg cubre todo el contorno fantasma
    cuando el fg se desplaza por parallax.
* Pipeline Rust sube los defaults de `/depth/batch` de
  `inpaint_radius=12, feather_pixels=4` a `(16, 8)` para aprovechar
  los nuevos pasos de pulido.

### Corregido — DB upgrade hazard (auto-heal)

* `apps/desktop/src-tauri/src/db/mod.rs::init_pool` ahora detecta el
  error específico "migration N was previously applied but has been
  modified", archiva la DB rota como `xianxia.broken-{ts}.db` (con
  sus -wal/-shm), y crea una limpia. Era el síntoma que dejaba a los
  usuarios upgradeados desde v0.1.7+ con `db init failed` permanente
  y proyectos no-persistentes (memory-pool fallback).
* Los proyectos previos pierden sus rows de DB, pero los assets en
  disco (MP4 + thumbnails) siguen ahí y reaparecen via `library_list_videos`
  (que lee del filesystem, no de la DB).

## [0.1.11] — 2026-05-07

### Corregido — defectos visuales severos en el output final

Tras inspeccionar el MP4 producido por v0.1.10 con ffprobe + frame
dump, el equipo (Claude + usuario) detectó cuatro fallos coincidentes
que el "exit code 0 + subtitles_done en logs" estaba ocultando:

1. **Mux desincronizado en `postProcessCinematic`** (Node sidecar)
   producía `video_stream_duration=3.36 s` mientras `audio` y
   `container` eran 22.2 s. Causa: combinar `-vf` con
   `-filter_complex` en un mismo invocación de FFmpeg desconectaba
   los timings. Fix integral en `apps/sidecar-node/src/render.ts`:
   • todo el procesamiento (cinematic look + audio mix) va dentro de
     un único `-filter_complex` que deja `[v]` y `[a]` etiquetados;
   • `+faststart` para que el moov llegue al inicio del archivo;
   • decode software (NVDEC chocaba con el filter graph mixed);
   • **auto-defensa runtime**: tras escribir el MP4, ffprobe verifica
     que `video_dur / container_dur ∈ [0.95, 1.05]` y lanza error si
     no, lo que hace al Rust caller fallar limpio al render fallback
     en vez de entregar un archivo roto silenciosamente.

2. **Subtítulos ilegibles** (chunks 42 chars + solape +0.15 s + 
   `Collisions: Normal` + `BorderStyle: 1` + `MarginV: 90`):
   libass apilaba dos captions en filas distintas porque los
   eventos de Whisper se solapaban entre sí, y el outline puro no
   sobrevivía sobre frames con artefactos. Fix en
   `apps/sidecar-py/src/xianxia_ai/routes/subtitles.py`:
   • `max_chars=28` (22 vertical) — una sola línea por chunk;
   • monotonic non-overlap forzado entre chunks consecutivos;
   • `Collisions: Reverse`, `WrapStyle: 2`;
   • `BorderStyle: 3` (caja opaca) — legible sobre cualquier fondo;
   • `MarginV: 130`, `MarginL/R: 120` (zona segura amplia).

3. **Parallax solo aplicado a la primera imagen** (en realidad a
   ninguna): `narrative.html` exigía `if (bg && mid && fg)` pero
   rembg solo segmenta `bg + fg` (no `mid`). Resultado: ningún beat
   tenía las 3 capas y la animación caía al fallback `single` que
   tampoco existía como `<img>`. Fix: animaciones independientes
   por capa (`if (bg)`, `if (mid)`, `if (fg)`) con escala suave
   añadida al fondo.

4. **17 s de pantalla negra al inicio + 34 s al final**: los
   timestamps de los markers `[IMAGE: …]` venían de un cálculo a
   150 wpm que no coincidía con la velocidad real del TTS Qwen3.
   Fix en `apps/desktop/src-tauri/src/pipeline/mod.rs`: tras Phase
   3 TTS leemos `duration_seconds` real del audio y `normalise_beat_timeline()`
   distribuye las imágenes uniformemente sobre toda la duración con
   transiciones alternadas (cross/flash/inkwash/whip).

### Corregido — biblioteca

5. **`library_list_videos` priorizaba el .mp4 sin subs**: al elegir
   "el más grande", listaba el video sin subtítulos en vez del
   `*.subs.mp4`. Nuevo `video_rank()` con prioridad explícita:
   `.subs > video > resto`, desempate por mtime.

### Corregido — rendimiento TTS

6. **Chunks de TTS demasiado largos** (default 600 chars producía
   chunks de 5–6 min cada uno por escalado super-lineal del decoder
   autoregresivo). Bajado a `chunk_chars=220` → ~30–80 s por chunk
   en RTX 4060 8 GB.

### Añadido — pruebas

* **9 tests unitarios** que blindan los fixes:
  - Rust (`cargo test`): 6 tests sobre `normalise_beat_timeline`
    (head=0, tail=audio_dur, sin gaps, dur≥1s, transitions
    alternadas, edge cases) + 2 tests `video_rank`.
  - Python (`pytest tests/test_subtitles_layout.py`): 6 tests sobre
    el ASS — no-overlap entre chunks, max-chars, header con
    BorderStyle=3 y Collisions: Reverse, end>start defensivo,
    timestamp format.
  - **Auto-defensa en runtime**: ffprobe del output del
    postProcessCinematic con assert sobre la ratio video/container.
* **Harness e2e** (`tests/e2e/smoke_pipeline.py`): replica el flujo
  Rust contra los sidecars Python+Node, genera horizontal/vertical
  reales, hace ffprobe + frame dump + verdict JSON con assertions.

### Migrations

* **Restaurada `0001_init.sql`** al hash original del commit
  `64ea299`. La modificación en `500dc17` (seed expandido inline)
  hacía que SQLx rechazara la DB de cualquier instalación previa
  con `migration 1 was previously applied but has been modified`,
  forzando memory-pool fallback y proyectos no persistentes. Las
  voces nuevas siguen estando en `0002_voices_expanded.sql` con
  `INSERT OR IGNORE`.

## [0.1.10] — 2026-05-07

### Añadido — observabilidad estructurada JSONL

* **Sidecar Python (`xianxia_ai/logging_utils.py`)**: cada log es un
  objeto JSON en `<cache>/logs/sidecar-py.jsonl` con `ts` ISO ms,
  `level`, `source=python`, `request_id`, `project_id`, `phase` y
  campos arbitrarios. Middleware FastAPI inyecta `request_id` por
  petición y emite un evento `http_request` con `duration_ms` y
  `status` cuando termina.
* **Sidecar Node (`logger.ts`)**: pino con destino NDJSON a
  `<cache>/logs/sidecar-node.jsonl`, schema compatible con el
  Python. Pretty stderr opcional con `XIANXIA_LOG_PRETTY=1`.
* **Pipeline Rust (`diag.rs`)**: `tracing-subscriber` con layer
  JSON a `<cache>/logs/pipeline-rust.jsonl` además del console
  layer dev. `#[instrument]` en cada fase deja un span con
  duration_ms automático.
* **Endpoint `POST /diag/snapshot`**: devuelve en una llamada los
  últimos N MB combinados de los 4 streams (rust + python + node +
  comfyui + vram), filtrable por `project_id`, `since`, `level`.
  Permite reconstruir un run completo sin hacer tail manual de
  varios archivos.
* **Endpoints `GET /diag/health`, `/diag/vram`, `/diag/list`**:
  status del sidecar, snapshot VRAM cross-process (ComfyUI
  /system_stats + Ollama /api/ps + cuda.mem_get_info) y listado
  de archivos de log con tamaños.
* **VRAM monitor periódico** (Rust supervisor): cada 30 s captura
  Comfy + Ollama y escribe línea JSONL en `vram.jsonl`. Permite
  correlacionar phase transitions con uso real de VRAM al
  diagnosticar races entre unloads.
* **Log rotation automática** (`diag::rotate_logs`): al arrancar
  la app, archivos > 7 días se gzipean a `archive/<name>.gz` y se
  borran los originales. Archive > 28 días se purgan. Footprint
  total se mantiene < 80 MB incluso en semanas de testing intenso.

### Corregido — `subtitles` y `tts` bloqueaban el event loop

El run 8 (v0.1.9) se atascó en Phase 8 con "error sending request
for url 8731/subtitles". Causa raíz: `generate_subtitles` era
`async def` pero dentro hacía `whisper_model.load()` y
`model.transcribe()` que son **síncronos CPU/GPU-bound**, lo que
bloqueaba el event loop entero. Mientras /subtitles procesaba,
ningún otro request podía progresar y el cliente Rust hacía
timeout antes de recibir respuesta.

Fix integral:
* `subtitles.generate_subtitles` ahora envuelve `whisper_model.load()`
  y `model.transcribe()` en `asyncio.to_thread()` — el evento loop
  queda libre para servir /health, /unload y la siguiente fase.
* `tts.synthesize` movido `tts_model.load()` cold-start al
  threadpool por la misma razón (5-30 s de carga inicial).
* Ambos endpoints emiten ahora eventos JSONL detallados de cada
  paso (load_start, load_done, transcribe_start, transcribe_done,
  translate_start, translate_done) con `duration_ms` para hacer
  diagnóstico granular sin guesswork.

### Notas de diseño

Esta versión es deuda operacional necesaria antes de v0.2.0
long-form: sin logs estructurados sería imposible diagnosticar
fallos en pipelines de 30+ min con múltiples capítulos.

## [0.1.9] — 2026-05-06

### Corregido — ComfyUI cache-hit infinito

Generaciones reales con v0.1.8 expusieron un bug que se manifestaba
como pipeline colgado en Phase 4 imagen 2:

- `image.py` invocaba `xianxia_workflow(..., seed=req.seed or 42)`. Si
  el cliente Rust no pasaba `seed` (caso por defecto), TODAS las
  imágenes usaban `seed=42`. ComfyUI considera workflow + seed
  + prompt como clave de cache; si dos prompts colisionan o son
  idénticos en algún sub-paso, ComfyUI marca todos los nodos como
  `execution_cached` y devuelve `outputs: {}` con `status_str=success`.
  El sidecar entraba a poll eternal en /history porque nunca veía
  outputs y eventualmente disparaba el timeout 1800s.
- Fix: `secrets.randbelow(2**31)` genera seed nuevo por request si el
  cliente no lo fija. Imposible cache-hit por colisión de seed.
- Fix de robustez complementario: `comfyui_client.wait_for_image`
  detecta el caso `status=success + outputs={}` (cache-hit residual
  por cualquier otro motivo) y recupera el output buscando la última
  `xianxia_*.png` modificada en el output dir. Si tampoco encuentra
  nada, lanza `RuntimeError` explícito en vez de colgar.

## [0.1.8] — 2026-05-06

### Corregido — pipeline ahora completa de extremo a extremo

Versión consolidada que corrige la cadena de fallos identificada en
generaciones reales: ffmpeg fuera del PATH del sidecar, race condition
HyperFrames vs fallback FFmpeg, traducción de subs abortando el
pipeline, burn-in mudo, sidecar Node huérfano sobreviviendo a los
auto-updates, y varios bugs UI.

#### Las cuatro leyes Auto sobre ffmpeg

- **Autoinstalable**: el manifest del wizard descarga ffmpeg-essentials
  8.0 (gyan.dev) a `runtime/ffmpeg/bin/` cuando el sistema no lo tiene.
- **Autodetectable**: `verify_stack` lo encuentra en runtime,
  `node_modules/.bin/`, PATH del sistema, o WinGet Links — en ese
  orden, devolviendo la primera ruta válida.
- **Autoconfigurable**: el supervisor Rust calcula un PATH ampliado en
  cada `spawn_python()`/`spawn_node()`/`spawn_comfyui()` que prepende
  `runtime/ffmpeg/bin`, `runtime/sidecar-node/node_modules/.bin`,
  `runtime/python/python` y `LOCALAPPDATA/Microsoft/WinGet/Links` al
  PATH heredado, garantizando que cualquier `subprocess.run("ffmpeg")`
  o `execa("ffmpeg")` funcione sin importar la instalación del usuario.
- **Autorreparable**: el sidecar Python autoinyecta el PATH
  (`server.py`) en su entorno como cinturón y tirantes; los endpoints
  de render usan `execa({preferLocal:true})` para que HyperFrames
  encuentre ffmpeg via `node_modules/.bin/`.

#### HyperFrames como motor principal sin race

`Phase 6` esperaba a que el archivo `out_path` apareciera con un único
check. En discos lentos eso disparaba el fallback a FFmpeg directo
incluso cuando HyperFrames había triunfado, perdiendo el parallax 2.5D
y las atmospherics. Ahora `try_hyperframes_render` poll cada 2 s hasta
30 s antes de declarar fallo, y el fallback FFmpeg solo se activa
cuando realmente HyperFrames no produjo nada.

#### Phase 8 subtitles autorreparable

- `_translate_entries` ahora captura excepciones por entrada (Ollama
  500 al traducir es típico cuando ComfyUI acaba de liberar VRAM) y
  reintenta una vez tras 8 s. Si vuelve a fallar, devuelve la entrada
  en inglés como fallback. El endpoint `/subtitles` ya nunca devuelve
  500 por traducción rota.
- `/subtitles/burn-in` valida que el MP4 generado existe y pesa más
  de 1 KB. Antes ffmpeg podía retornar exit 0 con archivo vacío en
  rare quirks NVENC y nadie se daba cuenta.
- En el lado Rust, Phase 8 burn-in es non-fatal: si falla, deja el
  vídeo sin subs como `final_video` con un toast informativo en vez
  de abortar el pipeline.

#### Workflow Z-Image-Turbo con text encoder GGUF

- `z_image_turbo_gguf.json` carga el text encoder Qwen3-4B vía
  `CLIPLoaderGGUF` (custom node ComfyUI-GGUF) usando
  `Qwen_3_4b-imatrix-IQ4_XS.gguf` (~2.2 GB) en lugar del
  `qwen_3_4b_fp8_mixed.safetensors` (~5.4 GB) anterior.
- En tarjetas de 8 GB VRAM esto elimina el thrashing entre Z-Image
  Turbo Q4_K_M y el text encoder: los step times bajan de ~95 s/step
  a ~7-8 s/step (12× más rápido por imagen).
- El manifest entry `z-image-comfy-clip` apunta al GGUF; el wizard lo
  descarga automáticamente desde
  `worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF`.

#### Más fixes

- **`kill_orphan_sidecars`** ahora identifica orphans con criterio
  dual: exe path bajo `<data_dir>/runtime/` O cmdline que apunte ahí.
  El fix anterior dejaba viva una `node.exe` del sistema corriendo
  `runtime/sidecar-node/dist/server.js` tras un auto-update.
- **Botón "Cancelar generación"** en Generator + comando
  `abort_generation` que cancela el JoinHandle del pipeline y marca
  el proyecto como `cancelled`.
- **Sidebar y updater-panel comparten cache de versión**
  (`tauri.getAppVersion` con queryKey `app-version`), eliminando el
  bug `v[object Object]` que aparecía cuando los dos componentes
  fetcheaban la misma key con shapes distintos.
- **`init_memory_pool`** ahora usa `sqlite:file::memory:?cache=shared`
  para que las 4 conexiones del pool compartan el mismo schema.
  Antes cada conexión tenía su propia DB y los `INSERT INTO
  pipeline_steps` fallaban con "no such table" en mid-pipeline cuando
  el setup caía al fallback en memoria.

## [0.1.7] — 2026-05-06

### Corregido

- **HyperFrames vuelve a funcionar como motor primario de render**.
  La integración estaba escrita para una API anterior a HyperFrames 0.4
  (cuando aceptaba un `.html` suelto). En 0.4.45 el CLI exige un
  *directorio de proyecto* con `index.html` + `hyperframes.json` +
  `meta.json` y un schema lint estricto en el HTML
  (`data-composition-id`, `data-width`, `data-height`, registry de
  timeline en `window.__timelines`, sin `Math.random()`, sin selectores
  con template literals). Las tres plantillas (`narrative.html`,
  `short.html`, `thumbnail.html`) están reescritas al nuevo schema; el
  sidecar Node ahora hace **scaffold del project dir + staging de
  todos los assets** (narración, música, imágenes, capas de
  profundidad) dentro de `assets/` para que Chromium los cargue
  (antes los `file://` absolutos eran bloqueados por la sandbox).
- **Fallback automático a FFmpeg si HyperFrames falla**. El pipeline
  ya nunca aborta en Phase 6: intenta HyperFrames, valida que el MP4
  exista en disco después del 200 OK, y solo si no llega cae a
  `/render` del sidecar Python (zoompan + xfade + NVENC + grade
  cinematic). El emit final reporta el motor real usado.
- **Phase 7 (thumbnail) ya no aborta el pipeline**. Si Z-Image se
  cuelga por VRAM thrashing o el render Node falla, el pipeline
  extrae un frame del MP4 generado vía FFmpeg y lo usa como
  thumbnail. Antes un timeout en thumbnail tiraba toda la
  generación. Además ahora liberamos la VRAM (`/unload?target=tts`,
  `/unload?target=music`) antes de invocar ComfyUI para el thumbnail,
  lo que reduce el step de ~95 s a ~7 s.

## [0.1.6] — 2026-05-06

### Corregido

- **Pipeline ya no muere en Fase 2 (Metadatos)**. Gemma 4 a veces
  anidaba `tags` y `chapters` *dentro* del dict `description` en vez
  de ponerlos al nivel superior, lo que reventaba la validación
  Pydantic con un 500 que el cliente Rust traducía como
  `error decoding response body`. Ahora el handler normaliza la
  respuesta del LLM tolerando: `tags` como string CSV o como lista,
  `chapters` como lista o vacío, y `description` con claves no-idioma
  promovidas automáticamente al nivel superior. El pipeline avanza a
  TTS aunque el LLM se desvíe del schema.

## [0.1.5] — 2026-05-06

### Corregido

- **Sidecars huérfanos tras auto-update se cierran solos**. Cuando el
  updater pasivo aplicaba v0.1.X → v0.1.X+1, el `.exe` nuevo arrancaba
  pero los procesos `python.exe` / `node.exe` lanzados por la versión
  anterior seguían ocupando los puertos 8731/8732/8188 con código
  obsoleto (p. ej. el CORS de v0.1.3 no tenía `tauri.localhost`, así
  que «Cargando voces…» no se desbloqueaba pese al fix). El nuevo
  setup llama a `kill_orphan_sidecars()`: identifica todos los
  procesos cuyo ejecutable vive dentro de `<data_dir>/runtime/` y los
  termina, así el supervisor nuevo siempre toma puertos limpios.
- **`state not managed for field 'pool' on command 'start_generation'`**.
  El pool SQLite se inicializaba en una tarea `spawn` y, si el usuario
  pulsaba «Iniciar generación» antes de que terminara, el comando
  fallaba con ese error. Ahora la inicialización se hace bloqueante
  en el `setup` (~1-2 s) y, si SQLite falla por permisos / FS,
  caemos a un pool en memoria con migraciones aplicadas para que
  la UI siga operativa hasta el siguiente arranque.
- **Texto del clip de Qwen3-TTS ajustado a 3-15 s**. La doc oficial
  permite «rapid voice clone» desde 3 s; antes la UI sugería 5-15 s
  innecesariamente.
- **Botón «Ideas IA» informa cuando falla**. Si el endpoint
  `/script/suggest` no responde (servicio caído, LLM timeout) ahora
  se muestra un toast con la causa concreta en vez de quedarse en
  silencio.

## [0.1.4] — 2026-05-06

### Corregido

- **CORS bloqueaba al webview Tauri 2 en Windows**. La app instalada
  hace fetch desde el origin `http://tauri.localhost` (WebView2),
  pero los sidecars solo permitían `http://localhost:1420` y
  `tauri://localhost`. El selector "Voz narradora" se quedaba en
  «Cargando voces…» indefinidamente y, en silencio, también fallaban
  `/music/backends`, `/engagement/backend` y otros endpoints. Ahora
  los dos sidecars admiten `http(s)://tauri.localhost` y
  `http://asset.localhost` además de los origins de dev.
- **HyperFrames CLI detectado en producción**. `verify_stack` solo
  miraba el path embebido del workspace (`CARGO_MANIFEST_DIR`), que
  no existe en el .exe instalado. Ahora también escanea
  `<data_dir>/runtime/sidecar-node/node_modules/.bin/hyperframes`
  donde la extracción del bundle lo deja.

## [0.1.3] — 2026-05-06

### Corregido

- **Ventanas de terminal ya no parpadean**. Todos los `Command::new`
  (sidecars, `nvidia-smi`, `ffmpeg`, `wmic`, `ollama serve`, `pip
  install`, `npm install`, ComfyUI, etc.) se lanzan ahora con el flag
  `CREATE_NO_WINDOW` en Windows, vía un nuevo trait `HideConsole` en
  `process_ext.rs`. Antes la app spawneaba terminales constantemente
  durante el arranque y la verificación de stack.
- **Sidecars Python y Node ahora arrancan en el .exe instalado**. El
  build pre-empaqueta `apps/sidecar-py/` (sin `__pycache__` ni venv)
  y `apps/sidecar-node/` con sus `node_modules` reales (incluyendo
  HyperFrames CLI y todas las deps materializadas vía npm) como
  recursos del bundle. En el primer arranque (o tras una actualización)
  Rust los extrae a `<data_dir>/runtime/sidecar-{py,node}/` y la
  supervisión los spawnea como cualquier runtime instalado.
- **Versión real en la sidebar**. Antes la cabecera mostraba `v0.1.0`
  hardcodeado; ahora consume `get_app_version` y refleja la versión
  publicada (`v0.1.3`, `v0.1.4`, …).
- **HyperFrames CLI detectable en el .exe**. Al ir el binario dentro
  del bundle de `node_modules/.bin/hyperframes`, el `verify_stack` lo
  encuentra sin necesidad del workspace de desarrollo.

### Cambios internos

- Nuevo módulo `apps/desktop/src-tauri/src/process_ext.rs` con un
  trait `HideConsole` cross-platform (no-op fuera de Windows).
- Nuevo módulo `apps/desktop/src-tauri/src/sidecars/extract.rs` para
  copiar recursos a `runtime/` con marker `.bundle-version`.
- Nuevo script `scripts/prepare-sidecars.mjs` que sanea la estructura
  para Tauri (excluye caches Python, materializa deps Node con npm).
- `pnpm tauri:build` corre `pnpm sidecars:prepare` antes del bundle.

## [0.1.2] — 2026-05-06

### Corregido

- **HyperFrames como motor primario de render** (era la intención
  original del proyecto). El pipeline lo usaba sólo cuando TODOS
  los beats tenían depth layers segmentados, lo que dejaba fuera
  cualquier vídeo con un fallo puntual de `rembg`. Ahora HyperFrames
  se usa siempre que el Node sidecar esté arriba; los beats sin
  depth siguen renderizando con la composición normal (single
  layer + atmospherics + transitions + grade), y el fallback a
  FFmpeg directo queda reservado para cuando el sidecar no
  responde.
- **HyperFrames también para vertical** (1080×1920). El `width`/
  `height` se pasan al template responsive, así que Shorts y
  vídeos verticales se autoeditan con el mismo motor que el
  long-form horizontal.

### Documentación

- README: la fila Stack `Vídeo` se reescribió para reflejar
  HyperFrames como motor primario, FFmpeg como post-pass + fallback.
  Añadidas filas para ComfyUI custom nodes (ComfyUI-GGUF +
  rgthree-comfy) y la stack de visión 2.5D (rembg + onnxruntime +
  MediaPipe + YOLO11n-pose).

## [0.1.1] — 2026-05-06

### Añadido

- **Engagement Phase 11** con Meta TRIBE v2 — análisis fMRI in-silico
  (Yeo 7-network atlas) para detectar valles aburridos y un score
  global 0-100. Auto-fix opcional con cuts DMN + swells auditivos.
- **Smart Shorts standalone** (ruta `/shorts`) — extrae 1-N Shorts
  virales de un MP4 existente con LLM scoring (hook + climax +
  standalone) sin tocar el flujo de generación principal. Drag-and-drop
  + 5 caption styles + sliders count/duración.
- **ACE-Step v1.5** preferido para música, MusicGen-medium como
  fallback automático. Pre-master FFmpeg unificado a -16 LUFS.
- **Voice cloning nativo Qwen3-TTS** — UI en Ajustes para grabar/subir
  clones, panel de gestión, integración con el pipeline.
- **5 caption styles** (xianxia / hormozi / mrbeast / minimal / neon),
  **4 animation presets** (cinematic / dynamic / minimal / dramatic),
  **9 export presets** multi-plataforma (YouTube Shorts/1080p/4K, IG
  Reels/4:5/1:1, TikTok, X, FB Reels) con LUFS específicos.
- **Componentes opcionales autoinstalables** desde Ajustes — TRIBE
  v2 (~12 GB), ACE-Step + MusicGen (~6 GB), Vision stack. Cada card
  detecta el estado, instala con stream de progreso y respawnea el
  sidecar Python automáticamente.
- **UX**: sistema toast + confirmDialog tematizado (sustituye
  `window.alert`/`confirm`), atajos de teclado globales (`d/g/s/l/p/,`
  + `?` ayuda + `Esc` cierra), draft auto-save del Generator en
  localStorage, sidebar agrupada en 4 categorías, Settings con
  accordion `<details>`, Library con engagement panel + heatmap +
  empty state CTAs.
- **Render**: 60 fps + 2× canvas + lanczos downscale, Steadicam sway
  sinusoidal, NVENC p7 + tune hq + spatial-aq, chunked render
  (>12 beats) via concat demuxer.

### Corregido

- `start_generation` fallaba por `missing field use_musicgen` —
  todos los campos opcionales del `GenerateRequest` ahora son
  `#[serde(default)]`.
- Python sidecar aparecía como STOPPED durante TTS — supervisor
  tolerante (puerto bound + child alive ⇒ Running) y synthesis
  envuelto en `asyncio.run_in_executor`.
- 403 Forbidden en `asset.localhost` desde Library — scope del
  protocol expandido con `$HOME/AppData/Roaming/xianxia/**` y
  variantes macOS/Linux para cubrir el path real de ProjectDirs.
- "Abrir carpeta" de la Library — ahora ejecuta `explorer.exe`
  directamente desde Rust (la regex de `shell:open` rechaza paths
  Windows `C:\…`).
- Spawn loops del supervisor por orphan Python bloqueando el puerto
  8731 — `SpawnGuard` con backoff exponencial 0→5→15→30 s.

### Build & release

- Workflow GitHub Actions `.github/workflows/release.yml` que
  compila NSIS .exe + MSI en `windows-latest` al hacer push de un
  tag `v*` o disparar manualmente.
- Branding completo del installer (NSIS header/sidebar + WiX
  banner/dialog) generado desde el logo SVG master con script
  `pnpm installer:assets`.
- Selector de idioma del installer (Spanish + English).
- Licencia bilingüe ES/EN.
- Script `pnpm version:bump` que sincroniza la versión en
  `package.json`, `apps/desktop/package.json`,
  `apps/desktop/src-tauri/tauri.conf.json` y
  `apps/desktop/src-tauri/Cargo.toml`.

## [0.1.0] — 2026-05-05

Primera línea funcional: pipeline 11 fases (guion → metadatos → voz
→ imágenes → música → vídeo → thumbnail → subs → upload → shorts →
engagement), wizard de instalación con auto-detección de hardware,
biblioteca con engagement panel, scheduler, ajustes con OAuth
YouTube, Tauri 2 supervisor de sidecars (Python FastAPI · Node
Fastify · Ollama · ComfyUI), Z-Image-Turbo Q4_K_M GGUF para
inferencia visual en 8 GB VRAM.

[Unreleased]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/SwonDev/Xianxia_Studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/SwonDev/Xianxia_Studio/releases/tag/v0.1.0
