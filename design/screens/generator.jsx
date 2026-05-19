/* eslint-disable */
// Generator — Apple-style settings page + clean pipeline.

const PHASE_DEFS = [
  { n: 1,  label: "Guion",        icon: "Type",     hint: "Gemma 4 abliterated" },
  { n: 2,  label: "Metadatos",    icon: "Captions", hint: "Título · descripción · tags" },
  { n: 3,  label: "Narración",    icon: "Volume",   hint: "Qwen3-TTS" },
  { n: 4,  label: "Imágenes",     icon: "Image",    hint: "Z-Image-Turbo" },
  { n: 5,  label: "Música",       icon: "Music",    hint: "Biblioteca local" },
  { n: 6,  label: "Vídeo",        icon: "Film",     hint: "HyperFrames · GSAP" },
  { n: 7,  label: "Thumbnail",    icon: "Layout",   hint: "Bilingüe" },
  { n: 8,  label: "Subtítulos",   icon: "Captions", hint: "faster-whisper" },
  { n: 9,  label: "Subida",       icon: "Upload",   hint: "YouTube API" },
  { n: 10, label: "Programación", icon: "Calendar", hint: "Cron + Shorts auto" },
];

const TOPIC_PRESETS = [
  "La leyenda del Emperador de Jade",
  "Norse mythology — Ragnarök",
  "Black holes y los límites de la física",
  "La caída del Imperio Romano",
];

const VOICE_PRESETS = [
  { id: "vivian",     label: "Vivian",          tone: "Cálida · femenina · neutral", lang: "ES" },
  { id: "yunyang",    label: "Yunyang",         tone: "Profunda · masculina · grave", lang: "ZH·EN" },
  { id: "narrator",   label: "Narrator",        tone: "Documental · masculina",       lang: "EN" },
  { id: "clone:mine", label: "Mi voz clonada",  tone: "5s de tu propio audio",        lang: "Auto" },
];

function Generator({ pipeline, onStart, onStop }) {
  const [topic, setTopic] = React.useState("La leyenda del Emperador de Jade");
  const [minutes, setMinutes] = React.useState(12);
  const [voice, setVoice] = React.useState("vivian");
  const [vertical, setVertical] = React.useState(false);
  const [animation, setAnimation] = React.useState("cinematic");
  const [autoShorts, setAutoShorts] = React.useState(true);
  const [analyzeEngagement, setAnalyzeEngagement] = React.useState(true);
  const [burnSubs, setBurnSubs] = React.useState(true);

  return (
    <div className="route-enter" style={{
      maxWidth: 1180, margin: "0 auto", padding: "28px 32px 56px",
    }}>
      <PageHeader
        title="Generador"
        subtitle="Un tema, diez fases automáticas. Todo se ejecuta en tu propia máquina."
        action={
          pipeline.running ? (
            <button className="btn large" onClick={onStop}>
              <I.Pause size={11}/> Pausar
            </button>
          ) : (
            <button className="btn-primary large" onClick={onStart}>
              <I.Sparkles size={11}/> Iniciar generación
            </button>
          )
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 360px",
        gap: 28,
        alignItems: "flex-start",
      }}>
        <div>
          {/* Tema */}
          <Group label="Tema">
            <div className="row" style={{ display: "block", padding: "12px 14px" }}>
              <textarea
                className="input"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Escribe un tema o pega un guión…"
                rows={2}
                style={{ fontSize: 13, lineHeight: 1.45, background: "rgba(0,0,0,0.20)" }}
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                {TOPIC_PRESETS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTopic(t)}
                    style={{
                      padding: "2px 8px", fontSize: 11.5,
                      borderRadius: 4,
                      background: topic === t ? "var(--accent-bg)" : "rgba(255,255,255,0.06)",
                      color: topic === t ? "var(--accent-soft)" : "var(--text-secondary)",
                      transition: "all 100ms",
                    }}
                  >{t}</button>
                ))}
                <button className="btn-ghost" style={{ padding: "2px 6px", fontSize: 11.5 }}>
                  <I.Wand size={10}/> Sugerirme
                </button>
              </div>
            </div>
          </Group>

          {/* Formato */}
          <Group label="Formato">
            <Row title="Duración" sub={`${minutes} minutos · monetizable`} control={
              <div style={{ width: 160, display: "flex", alignItems: "center", gap: 8 }}>
                <input type="range" min={3} max={30} value={minutes} onChange={(e) => setMinutes(+e.target.value)} className="range"/>
                <span className="mono" style={{ width: 32, textAlign: "right" }}>{minutes}m</span>
              </div>
            }/>
            <Row title="Aspecto" control={
              <div className="segmented">
                <button className={"segmented-btn" + (!vertical ? " active" : "")} onClick={() => setVertical(false)}>16:9</button>
                <button className={"segmented-btn" + (vertical ? " active" : "")} onClick={() => setVertical(true)}>9:16</button>
              </div>
            }/>
            <Row title="Estilo cinematográfico" sub="Define ritmo, cámara y atmósfera" control={
              <div className="segmented">
                {["cinematic","dynamic","minimal","dramatic"].map(a => (
                  <button key={a} className={"segmented-btn" + (animation === a ? " active" : "")} onClick={() => setAnimation(a)} style={{ textTransform: "capitalize" }}>{a}</button>
                ))}
              </div>
            }/>
          </Group>

          {/* Voz */}
          <Group label="Voz">
            {VOICE_PRESETS.map((v) => (
              <Row
                key={v.id}
                title={v.label}
                sub={v.tone}
                value={v.lang}
                control={
                  <button
                    onClick={() => setVoice(v.id)}
                    className={"lg-radio" + (voice === v.id ? " on" : "")}
                  />
                }
                hoverable
                onClick={() => setVoice(v.id)}
              />
            ))}
          </Group>

          {/* Extras */}
          <Group label="Extras" footer="Estas opciones se aplican al final del pipeline y añaden 2-4 minutos a la generación total.">
            <Row
              title="Auto-engagement TRIBE v2"
              sub="Detecta valles aburridos y los corrige automáticamente"
              control={<button className={"toggle" + (analyzeEngagement ? " on" : "")} onClick={() => setAnalyzeEngagement(!analyzeEngagement)}/>}
            />
            <Row
              title="Quemar subtítulos"
              sub="ASS karaoke palabra a palabra, estilo seleccionado"
              control={<button className={"toggle" + (burnSubs ? " on" : "")} onClick={() => setBurnSubs(!burnSubs)}/>}
            />
            <Row
              title="Auto-Shorts al terminar"
              sub="Extrae 3 clips virales de 45s del vídeo final"
              control={<button className={"toggle" + (autoShorts ? " on" : "")} onClick={() => setAutoShorts(!autoShorts)}/>}
            />
          </Group>

          {/* Estimación + start */}
          <div style={{
            background: "var(--bg-list)",
            borderRadius: "var(--r-lg)",
            padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 14,
            marginTop: 22,
          }}>
            <div style={{ flex: 1 }}>
              <div className="caption" style={{ marginBottom: 2 }}>Estimación</div>
              <div style={{ fontSize: 12.5 }}>
                <strong>~22 min</strong> · 3.4 GB · 18 escenas · 280 imágenes
              </div>
            </div>
            <button className="btn" onClick={() => window.__previewScene?.()}>
              <I.Eye size={11}/> Vista previa 30s
            </button>
            <button className="btn-primary large" onClick={onStart} disabled={pipeline.running}>
              {pipeline.running ? "Generando…" : "Iniciar"}
            </button>
          </div>

          {/* Error card */}
          {pipeline.error && (
            <div className="fade-up" style={{
              marginTop: 14,
              padding: "12px 14px",
              background: "rgba(200,82,94,0.10)",
              borderRadius: 10,
              boxShadow: "0 0 0 0.5px rgba(200,82,94,0.40), inset 0 1px 0 rgba(255,255,255,0.06)",
              display: "flex", alignItems: "flex-start", gap: 12,
            }}>
              <span className="lg-tile lg" style={{ "--tint": "#c8525e" }}>
                <I.Warning size={14}/>
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{pipeline.error.title}</div>
                <div className="caption" style={{ marginTop: 2 }}>{pipeline.error.body}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  {(pipeline.error.actions || []).map((a, i) => (
                    <button key={i} className={i === 0 ? "btn-primary" : "btn"} style={{ height: 24, fontSize: 11.5 }}>
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Pipeline column */}
        <PipelineColumn pipeline={pipeline}/>
      </div>
    </div>
  );
}

function PipelineColumn({ pipeline }) {
  return (
    <aside style={{ position: "sticky", top: 0 }}>
      <div style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px" }}>
        <span className="title" style={{ fontSize: 13 }}>Pipeline</span>
        <span className="caption">
          {pipeline.running ? (
            <>Fase <strong style={{ color: "var(--accent-soft)" }}>{pipeline.phase}</strong> de 10 · {String(Math.floor(pipeline.elapsed / 60)).padStart(2,"0")}:{String(pipeline.elapsed % 60).padStart(2,"0")}</>
          ) : "Sin tareas"}
        </span>
      </div>
      <div className="group" style={{ padding: "4px 0" }}>
        {PHASE_DEFS.map((p) => {
          const state = !pipeline.running
            ? "pending"
            : p.n < pipeline.phase ? "done"
            : p.n === pipeline.phase ? "running"
            : "pending";
          return <PhaseRow key={p.n} phase={p} state={state} pipeline={pipeline}/>;
        })}
      </div>
    </aside>
  );
}

function PhaseRow({ phase, state, pipeline }) {
  const Icon = I[phase.icon];
  const isRunning = state === "running";
  const isDone = state === "done";
  const [showActions, setShowActions] = React.useState(false);
  const [showLog, setShowLog] = React.useState(false);

  return (
    <div
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      style={{
      padding: "8px 14px",
      display: "flex",
      gap: 10,
      alignItems: isRunning || showLog ? "flex-start" : "center",
      transition: "background 200ms",
      background: isRunning ? "rgba(46,177,137,0.07)" : "transparent",
      minHeight: 34,
      borderRadius: 0,
      position: "relative",
    }}>
      <div style={{ paddingTop: isRunning ? 2 : 0, flexShrink: 0 }}>
        {isDone ? (
          <span className="lg-orb done">
            <I.Check size={9} strokeWidth={3}/>
          </span>
        ) : isRunning ? (
          <div style={{ position: "relative", width: 18, height: 18 }}>
            <span className="lg-orb running" style={{ position: "absolute", inset: 0 }}/>
            <svg width="22" height="22" viewBox="0 0 22 22" style={{ position: "absolute", inset: -2, transform: "rotate(-90deg)" }}>
              <circle cx="11" cy="11" r="10" fill="none" stroke="rgba(94,216,166,0.85)" strokeWidth="1.5"
                strokeDasharray={`${(pipeline.subProgress / 100) * 62.8} 62.8`}
                strokeLinecap="round"
                style={{ transition: "stroke-dasharray 400ms var(--ease-spring)", filter: "drop-shadow(0 0 4px rgba(94,216,166,0.85))" }}
              />
            </svg>
          </div>
        ) : (
          <span className="lg-orb pending"/>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon size={11} style={{ color: isDone || isRunning ? "var(--text-secondary)" : "var(--text-quaternary)", flexShrink: 0 }}/>
          <span style={{
            fontSize: 12.5,
            fontWeight: isRunning ? 500 : 400,
            color: isRunning || isDone ? "var(--text-primary)" : "var(--text-tertiary)",
          }}>{phase.label}</span>
          {isRunning && <span className="mono" style={{ color: "var(--accent-soft)", fontSize: 10.5 }}>{Math.round(pipeline.subProgress)}%</span>}
          {isDone && <span className="mono" style={{ color: "var(--green)", fontSize: 10.5 }}>{phase.n * 14 + 22}s</span>}

          {showActions && (isRunning || isDone) && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 2, animation: "fade-up 160ms ease both" }}>
              {isRunning && (
                <button className="btn-ghost" style={{ height: 18, padding: "0 5px" }} title="Cancelar fase">
                  <I.X size={9}/>
                </button>
              )}
              {isDone && (
                <button className="btn-ghost" style={{ height: 18, padding: "0 5px" }} title="Re-ejecutar">
                  <I.Refresh size={9}/>
                </button>
              )}
              <button className="btn-ghost" style={{ height: 18, padding: "0 5px" }} title="Ver log" onClick={() => setShowLog(!showLog)}>
                <I.Activity size={9}/>
              </button>
            </div>
          )}
        </div>
        {isRunning && (
          <div style={{ marginTop: 6 }}>
            <PhaseDetail phase={phase} pipeline={pipeline}/>
          </div>
        )}
        {!isRunning && !showLog && (
          <div className="caption" style={{ fontSize: 10.5, marginTop: 1 }}>
            {phase.hint}
          </div>
        )}
        {showLog && (
          <div className="fade-up" style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "rgba(0,0,0,0.40)",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            lineHeight: 1.55,
            color: "var(--text-secondary)",
            maxHeight: 120,
            overflowY: "auto",
          }}>
            <div style={{ color: "var(--accent-soft)" }}>[14:32:18.412]</div>
            <div>→ loading model unsloth/gemma-4-E4B-it-abliterated</div>
            <div>→ context length: 8192 tokens · temperature: 0.78</div>
            <div style={{ color: "var(--green)" }}>✓ model loaded in 1.2s</div>
            <div>→ tokens emitted: {pipeline.tokens} · {pipeline.tps} tok/s</div>
          </div>
        )}
      </div>
    </div>
  );
}

function PhaseDetail({ phase, pipeline }) {
  if (phase.n === 1) {
    return (
      <div style={{
        padding: "8px 10px",
        background: "rgba(0,0,0,0.20)",
        borderRadius: 5,
        fontSize: 11.5,
        color: "var(--text-secondary)",
        lineHeight: 1.45,
      }}>
        "Bajo los Nueve Cielos, donde la luz de la luna se quiebra contra picos de jade…"
        <div className="mono" style={{ marginTop: 6, fontSize: 10, color: "var(--accent-soft)" }}>
          {pipeline.tokens} tokens · {pipeline.tps} tok/s
        </div>
      </div>
    );
  }
  if (phase.n === 3) return <Waveform/>;
  if (phase.n === 4) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            aspectRatio: "1",
            borderRadius: 3,
            background: i < pipeline.imageCount ? `hsl(${260 + i*15}, 30%, 20%)` : "rgba(255,255,255,0.04)",
            position: "relative",
            overflow: "hidden",
          }}>
            {i >= pipeline.imageCount && <div className="skel" style={{ position: "absolute", inset: 0 }}/>}
          </div>
        ))}
      </div>
    );
  }
  if (phase.n === 6) {
    return (
      <div style={{
        height: 36, borderRadius: 5,
        background: "rgba(0,0,0,0.20)",
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--text-tertiary)",
      }}>
        <I.Film size={16}/>
        <div style={{
          position: "absolute", bottom: 0, left: 0, height: 1.5,
          width: `${pipeline.subProgress}%`,
          background: "var(--accent)",
          transition: "width 500ms",
        }}/>
      </div>
    );
  }
  return <div className="caption" style={{ fontSize: 11 }}>{pipeline.message}</div>;
}

function Waveform() {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const i = setInterval(() => setTick(t => t+1), 120);
    return () => clearInterval(i);
  }, []);
  const bars = Array.from({ length: 28 }, (_, i) => 3 + Math.abs(Math.sin((i + tick) * 0.4) * 12 + Math.sin((i + tick*0.5)*0.7) * 4));
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 2, height: 24,
      padding: "0 6px",
      background: "rgba(0,0,0,0.20)",
      borderRadius: 5,
    }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          flex: 1, height: h,
          background: "var(--accent)",
          borderRadius: 0.5,
          opacity: 0.3 + (h / 16) * 0.7,
        }}/>
      ))}
    </div>
  );
}

Object.assign(window, { Generator, PHASE_DEFS });
