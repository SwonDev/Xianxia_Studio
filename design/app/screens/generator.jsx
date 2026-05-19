// Generator — clean form when idle, vivid live pipeline when running

const Generator = ({ pipeline, setPipeline }) => {
  const running = pipeline.running;

  return (
    <div className="screen-inner page-enter" style={{ maxWidth: 1200 }}>
      {running ? <RunningView pipeline={pipeline} setPipeline={setPipeline} /> : <IdleView setPipeline={setPipeline} />}
    </div>
  );
};

/* ============== IDLE ============== */

const IdleView = ({ setPipeline }) => {
  const [topic, setTopic] = React.useState("La leyenda del cultivador que olvidó su nombre");
  const [duration, setDuration] = React.useState("5min");
  const [format, setFormat] = React.useState("long");
  const [tone, setTone] = React.useState("cinematic");
  const [voice, setVoice] = React.useState("celeste-es");
  const [advanced, setAdvanced] = React.useState(false);

  const start = () => {
    setPipeline({ running: true, currentPhase: 0, subProgress: 0, progress: 0, label: "Investigación", phaseStarted: Date.now() });
  };

  return (
    <>
      <header style={{ marginBottom: 40 }}>
        <span className="eyebrow">Nuevo vídeo</span>
        <h1 className="h-display" style={{ marginTop: 12, marginBottom: 12 }}>
          Un tema. Un clic. <span className="em">Un vídeo cinematográfico.</span>
        </h1>
        <p className="lede">
          Escribe lo que quieres contar. El pipeline genera guion, narración, imágenes, música,
          edición y subtítulos enteramente en local. Sin claves, sin envíos.
        </p>
      </header>

      {/* Topic — the hero input */}
      <section style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005))",
        border: "1px solid var(--border-default)",
        borderRadius: 16,
        padding: 28,
        marginBottom: 32,
        position: "relative",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}>
        <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Icons.Sparkles style={{ width: 13, height: 13, color: "var(--gold-400)" }}/>
          <span>De qué trata tu vídeo</span>
        </label>
        <textarea
          className="textarea"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          placeholder="Por ejemplo: 'La historia del Emperador de Jade y los nueve dragones'"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            fontSize: 22,
            fontFamily: "var(--font-display)",
            lineHeight: 1.35,
            color: "var(--paper-50)",
            outline: "none",
            boxShadow: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 16, borderTop: "1px dashed var(--border-subtle)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11.5, color: "var(--paper-400)" }}>
            <Pill icon="Brain" tone="gold">Qwen 2.5 14B</Pill>
            <span>·</span>
            <span>{topic.length} caracteres</span>
            <span>·</span>
            <span>~ 92 s para guion</span>
          </div>
          <button className="btn btn-ghost" style={{ height: 26, fontSize: 11.5 }}>
            <Icons.Wand /> Sugerir tema
          </button>
        </div>
      </section>

      {/* Key choices grid */}
      <section style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        marginBottom: 16,
      }}>
        <ChoiceCard
          label="Formato"
          icon="Film"
          options={[
            { value: "long", label: "Horizontal · 16:9",  hint: "YouTube · canal principal" },
            { value: "short", label: "Vertical · 9:16",  hint: "Shorts · Reels · TikTok" },
          ]}
          value={format}
          onChange={setFormat}
        />
        <ChoiceCard
          label="Duración objetivo"
          icon="Clock"
          options={[
            { value: "30s",  label: "30 s",  hint: "Short" },
            { value: "5min", label: "5 min", hint: "Estándar" },
            { value: "30min",label: "30 min", hint: "Documental" },
          ]}
          value={duration}
          onChange={setDuration}
        />
      </section>

      <section style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        marginBottom: 24,
      }}>
        <ChoiceCard
          label="Tono narrativo"
          icon="Brain"
          options={[
            { value: "cinematic", label: "Cinematográfico", hint: "Solemne y épico" },
            { value: "doc",       label: "Documental",      hint: "Pausado y claro" },
            { value: "mystery",   label: "Misterio",        hint: "Suspense" },
          ]}
          value={tone}
          onChange={setTone}
        />
        <VoiceCard voice={voice} onChange={setVoice} />
      </section>

      {/* Advanced toggle */}
      <section style={{ marginBottom: 32 }}>
        <button
          onClick={() => setAdvanced((a) => !a)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            color: "var(--paper-300)", fontSize: 12.5,
            padding: "8px 12px",
            borderRadius: 8,
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          <Icons.Sliders style={{ width: 13, height: 13 }} />
          <span>Opciones avanzadas</span>
          <Icons.ChevronDown style={{ width: 12, height: 12, transition: "transform 200ms", transform: advanced ? "rotate(180deg)" : "" }} />
        </button>

        {advanced && (
          <div style={{
            marginTop: 8,
            padding: 20,
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20,
            animation: "pageIn 280ms var(--ease-mac)",
          }}>
            <Adv label="Estilo visual" value="Pintura tradicional china" />
            <Adv label="Banda sonora" value="Guzheng + cuerda etérea" />
            <Adv label="Subtítulos" value="Cinematográfico (karaoke)" />
            <Adv label="Idioma" value="Español + EN/ZH automático" />
            <Adv label="Engagement (TRIBE)" value="Activado · objetivo 78" />
            <Adv label="Publicar tras render" value="No, revisar antes" />
          </div>
        )}
      </section>

      {/* Sticky CTA bar */}
      <section style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 24px",
        background: "rgba(13,13,20,0.6)",
        backdropFilter: "blur(20px)",
        border: "1px solid var(--border-default)",
        borderRadius: 14,
        position: "sticky",
        bottom: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Pill tone="jade" icon="Check">Sistema listo</Pill>
          <span style={{ fontSize: 12, color: "var(--paper-400)" }}>
            Estimado: ~ <strong style={{ color: "var(--paper-200)" }}>8 min</strong> de render en tu hardware
          </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-secondary">
            <Icons.Edit />
            Guardar como borrador
          </button>
          <button className="btn btn-primary btn-lg" onClick={start}>
            <Icons.Sparkles />
            Iniciar generación
            <span className="kbd" style={{ marginLeft: 4, fontSize: 10, background: "rgba(0,0,0,0.15)", borderColor: "rgba(0,0,0,0.18)", color: "rgba(10,10,15,0.7)" }}>⌘↵</span>
          </button>
        </div>
      </section>
    </>
  );
};

const ChoiceCard = ({ label, icon, options, value, onChange }) => {
  const Icon = Icons[icon];
  return (
    <div style={{
      padding: 18,
      borderRadius: 12,
      border: "1px solid var(--border-subtle)",
      background: "rgba(255,255,255,0.015)",
    }}>
      <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <Icon style={{ width: 12, height: 12, color: "var(--paper-400)" }} />
        <span>{label}</span>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 8,
                border: active ? "1px solid rgba(201,168,76,0.4)" : "1px solid var(--border-subtle)",
                background: active ? "rgba(201,168,76,0.07)" : "rgba(255,255,255,0.01)",
                textAlign: "left",
                transition: "all 160ms var(--ease-std)",
                color: active ? "var(--gold-200)" : "var(--paper-100)",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{o.label}</span>
                <span style={{ fontSize: 11, color: "var(--paper-400)", marginTop: 2 }}>{o.hint}</span>
              </span>
              {active && <Icons.Check style={{ width: 14, height: 14, color: "var(--gold-300)" }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const VoiceCard = ({ voice, onChange }) => {
  const voices = [
    { id: "celeste-es", name: "Celeste", lang: "ES", style: "Solemne" },
    { id: "wei-es",     name: "Wei",     lang: "ES", style: "Cálido" },
    { id: "lin-en",     name: "Lin",     lang: "EN", style: "Misterio" },
    { id: "clone",      name: "Clonar tu voz", lang: "—", style: "5 s de audio" },
  ];
  return (
    <div style={{
      padding: 18,
      borderRadius: 12,
      border: "1px solid var(--border-subtle)",
      background: "rgba(255,255,255,0.015)",
    }}>
      <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <Icons.Mic style={{ width: 12, height: 12, color: "var(--paper-400)" }} />
        <span>Voz</span>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {voices.map((v) => {
          const active = voice === v.id;
          return (
            <button
              key={v.id}
              onClick={() => onChange(v.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                border: active ? "1px solid rgba(201,168,76,0.4)" : "1px solid var(--border-subtle)",
                background: active ? "rgba(201,168,76,0.07)" : "rgba(255,255,255,0.01)",
                textAlign: "left",
                transition: "all 160ms var(--ease-std)",
              }}
            >
              <div style={{
                width: 26, height: 26, borderRadius: 999,
                background: v.id === "clone"
                  ? "linear-gradient(135deg, var(--jade-500), var(--jade-600))"
                  : `linear-gradient(135deg, hsl(${v.name.charCodeAt(0) * 5}, 35%, 38%), hsl(${v.name.charCodeAt(0) * 5}, 30%, 25%))`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, color: "var(--paper-50)", fontWeight: 600,
                flexShrink: 0,
              }}>
                {v.id === "clone" ? <Icons.Plus style={{ width: 13, height: 13 }} /> : v.name[0]}
              </div>
              <div style={{ flex: 1, lineHeight: 1.2 }}>
                <div style={{ fontSize: 12.5, color: active ? "var(--gold-200)" : "var(--paper-100)", fontWeight: 500 }}>
                  {v.name}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--paper-400)" }}>
                  {v.style} {v.lang !== "—" && <>· {v.lang}</>}
                </div>
              </div>
              {v.id !== "clone" && (
                <button style={{
                  width: 22, height: 22, borderRadius: 999,
                  background: "rgba(255,255,255,0.06)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icons.Play style={{ width: 10, height: 10, color: "var(--paper-200)" }} />
                </button>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const Adv = ({ label, value }) => (
  <div>
    <div style={{ fontSize: 11, color: "var(--paper-400)", marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, color: "var(--paper-100)", display: "flex", alignItems: "center", gap: 6 }}>
      {value} <Icons.ChevronDown style={{ width: 11, height: 11, color: "var(--paper-400)" }} />
    </div>
  </div>
);

/* ============== RUNNING ============== */

const RunningView = ({ pipeline, setPipeline }) => {
  const phases = MockData.pipelinePhases;
  const phase = phases[pipeline.currentPhase];
  const PhaseIcon = Icons[phase.icon];

  const total = phases.length;
  const completed = pipeline.currentPhase;
  const overall = (completed + pipeline.subProgress) / total;
  const eta = Math.max(0, Math.round((1 - overall) * 480)); // seconds
  const elapsed = Math.round(((completed + pipeline.subProgress) * 480));

  const cancel = () => {
    setPipeline({ running: false, currentPhase: 0, subProgress: 0, progress: 0, label: "" });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 32 }}>

      {/* LEFT — vertical timeline */}
      <aside style={{
        position: "sticky",
        top: 8,
        alignSelf: "start",
      }}>
        <div style={{ marginBottom: 20 }}>
          <span className="eyebrow">Pipeline</span>
          <div style={{ marginTop: 8, fontFamily: "var(--font-display)", fontSize: 22, color: "var(--paper-50)" }}>
            {Math.round(overall * 100)}% completado
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11.5, color: "var(--paper-400)", marginTop: 4 }}>
            <span>{fmtTime(elapsed)} transcurrido</span>
            <span>·</span>
            <span>~ {fmtTime(eta)} restante</span>
          </div>
        </div>

        <div style={{ position: "relative", paddingLeft: 22 }}>
          {/* line */}
          <div style={{
            position: "absolute", left: 11, top: 8, bottom: 8,
            width: 1.5,
            background: "var(--border-subtle)",
          }}/>
          <div style={{
            position: "absolute", left: 11, top: 8,
            width: 1.5,
            height: `calc(${overall * 100}% - 16px)`,
            background: "linear-gradient(180deg, var(--gold-400), var(--jade-400))",
            boxShadow: "0 0 8px rgba(201,168,76,0.4)",
            transition: "height 600ms var(--ease-mac)",
          }}/>

          {phases.map((p, i) => {
            const state = i < pipeline.currentPhase ? "done" : i === pipeline.currentPhase ? "active" : "pending";
            return <TimelineNode key={p.id} phase={p} state={state} index={i} />;
          })}
        </div>

        <button onClick={cancel} className="btn btn-secondary" style={{ marginTop: 24, width: "100%" }}>
          <Icons.X />
          Cancelar generación
        </button>
      </aside>

      {/* RIGHT — current phase + log + preview */}
      <main>
        <header style={{ marginBottom: 24 }}>
          <span className="eyebrow" style={{ color: "var(--jade-400)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", animation: "pulse 1.4s var(--ease-mac) infinite" }}/>
              En marcha
            </span>
          </span>
          <h1 className="h-display" style={{ marginTop: 10 }}>
            La leyenda del cultivador
            <br />
            <span className="em" style={{ fontSize: 26 }}>que olvidó su nombre</span>
          </h1>
        </header>

        {/* Current phase card */}
        <section style={{
          padding: 28,
          borderRadius: 16,
          background: "linear-gradient(180deg, rgba(201,168,76,0.08), rgba(201,168,76,0.02))",
          border: "1px solid rgba(201,168,76,0.25)",
          marginBottom: 24,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03) inset, 0 0 32px rgba(201,168,76,calc(0.08 * var(--glow-strength)))",
          position: "relative",
          overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 18, marginBottom: 20 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: "linear-gradient(135deg, var(--gold-300), var(--gold-600))",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 20px rgba(201,168,76,0.4)",
              color: "var(--obsidian-950)",
              flexShrink: 0,
            }}>
              <PhaseIcon style={{ width: 22, height: 22 }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "var(--gold-300)", textTransform: "uppercase", letterSpacing: "0.16em", fontWeight: 600, marginBottom: 4 }}>
                Fase {pipeline.currentPhase + 1} de {total}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--paper-50)", marginBottom: 2 }}>
                {phase.label}
              </div>
              <div style={{ fontSize: 13, color: "var(--paper-300)" }}>{phase.desc}</div>
            </div>
            <Pill icon="Clock" tone="gold">~ {fmtTime(Math.round((1 - pipeline.subProgress) * 60))} restante</Pill>
          </div>

          {/* Sub-progress bar */}
          <div style={{
            height: 6, borderRadius: 999,
            background: "rgba(255,255,255,0.05)",
            overflow: "hidden", position: "relative",
            marginBottom: 16,
          }}>
            <div style={{
              position: "absolute", inset: 0,
              width: `${pipeline.subProgress * 100}%`,
              background: "linear-gradient(90deg, var(--gold-300), var(--gold-500))",
              boxShadow: "0 0 12px rgba(201,168,76,0.5)",
              transition: "width 400ms var(--ease-mac)",
              borderRadius: 999,
            }}/>
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)",
              width: "30%",
              transform: `translateX(${pipeline.subProgress * 100 * 3}%)`,
              transition: "transform 800ms linear",
            }}/>
          </div>

          {/* Live status line */}
          <div className="mono" style={{ fontSize: 11.5, color: "var(--paper-300)", display: "flex", alignItems: "center", gap: 8 }}>
            <Icons.Activity style={{ width: 12, height: 12, color: "var(--jade-400)" }} />
            <PhaseLiveStatus phaseId={phase.id} sub={pipeline.subProgress} />
          </div>
        </section>

        {/* Live log */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 className="h-section-label">Registro en vivo</h2>
            <Pill icon="Activity">streaming</Pill>
          </div>
          <LiveLog phaseIndex={pipeline.currentPhase} />
        </section>

        {/* Outputs so far */}
        <section>
          <h2 className="h-section-label" style={{ marginBottom: 12 }}>Generado hasta ahora</h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 10,
          }}>
            <OutputTile done={pipeline.currentPhase >= 2} icon="Edit" label="Guion · 1.842 palabras" />
            <OutputTile done={pipeline.currentPhase >= 3} icon="Mic" label="Narración · 5:12" />
            <OutputTile done={pipeline.currentPhase >= 4} icon="Image" label="38 imágenes" />
            <OutputTile done={pipeline.currentPhase >= 5} icon="Music" label="Banda sonora" />
          </div>
        </section>

      </main>
    </div>
  );
};

const TimelineNode = ({ phase, state, index }) => {
  const Icon = Icons[phase.icon];
  return (
    <div style={{
      position: "relative",
      marginBottom: 14,
      paddingLeft: 14,
      opacity: state === "pending" ? 0.45 : 1,
      transition: "opacity 300ms",
    }}>
      <div style={{
        position: "absolute",
        left: -16,
        top: 2,
        width: 16, height: 16,
        borderRadius: 999,
        background: state === "done" ? "var(--jade-400)" : state === "active" ? "var(--gold-400)" : "var(--obsidian-800)",
        border: state === "pending" ? "1.5px solid var(--border-default)" : "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: state === "active" ? "0 0 0 4px rgba(201,168,76,0.22), 0 0 12px rgba(201,168,76,0.5)" : "none",
        transition: "all 240ms var(--ease-mac)",
        zIndex: 1,
      }}>
        {state === "done" && <Icons.Check style={{ width: 9, height: 9, color: "var(--obsidian-950)", strokeWidth: 3 }}/>}
        {state === "active" && (
          <div style={{
            width: 6, height: 6, borderRadius: 999,
            background: "var(--obsidian-950)",
            animation: "pulse 1.2s var(--ease-mac) infinite",
          }}/>
        )}
      </div>
      <div style={{
        fontSize: 12,
        color: state === "active" ? "var(--gold-200)" : state === "done" ? "var(--paper-200)" : "var(--paper-400)",
        fontWeight: state === "active" ? 600 : 500,
        lineHeight: 1.25,
      }}>
        {phase.label}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--paper-400)", marginTop: 1 }}>
        {state === "done" ? "Completado" : state === "active" ? "En curso…" : "Pendiente"}
      </div>
    </div>
  );
};

const PhaseLiveStatus = ({ phaseId, sub }) => {
  const messages = {
    research:  ["consultando referencias", "extrayendo motivos visuales", "analizando arquetipos xianxia"],
    outline:   ["estructurando 3 actos", "definiendo beats emocionales", "calibrando ritmo"],
    script:    ["redactando acto I", "transición acto II", "puliendo cierre"],
    voice:     ["sintetizando segmento 12/24", "ajustando prosodia", "aplicando respiraciones"],
    imagery:   ["render 18/38 · monasterio en niebla", "render 22/38 · cultivador frente al abismo", "render 31/38 · espadas suspendidas"],
    music:     ["motivo principal · guzheng", "capas atmosféricas", "mezclando dinámica"],
    edit:      ["aplicando parallax 2.5D", "componiendo HyperFrames", "transiciones cinemáticas"],
    subs:      ["alineando palabra a palabra", "estilo karaoke aplicado", "exportando .ass"],
    engage:    ["TRIBE v2 · analizando 312 ventanas", "corrigiendo valle entre 03:12–03:48", "predicción: 81/100"],
    export:    ["render master 4K", "preset YouTube · loudness -14 LUFS", "preset TikTok · vertical"],
  };
  const msgs = messages[phaseId] || ["procesando"];
  const idx = Math.min(msgs.length - 1, Math.floor(sub * msgs.length));
  return <span>› {msgs[idx]}</span>;
};

const OutputTile = ({ done, icon, label }) => {
  const Icon = Icons[icon];
  return (
    <div style={{
      padding: 14,
      borderRadius: 10,
      border: "1px solid var(--border-subtle)",
      background: "rgba(255,255,255,0.015)",
      opacity: done ? 1 : 0.4,
      transition: "opacity 400ms, border-color 400ms",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <Icon style={{ width: 16, height: 16, color: done ? "var(--jade-400)" : "var(--paper-400)" }} />
      <span style={{ fontSize: 11.5, color: done ? "var(--paper-100)" : "var(--paper-400)" }}>{label}</span>
    </div>
  );
};

const LiveLog = ({ phaseIndex }) => {
  const phases = MockData.pipelinePhases;
  const entries = React.useMemo(() => {
    const items = [];
    for (let i = 0; i <= phaseIndex; i++) {
      const p = phases[i];
      items.push({ t: `00:${String(i * 47 % 60).padStart(2, "0")}`, level: "info", msg: `${p.label.toLowerCase()} · iniciado` });
      if (i < phaseIndex) {
        items.push({ t: `00:${String((i * 47 + 32) % 60).padStart(2, "0")}`, level: "ok",   msg: `${p.label.toLowerCase()} · completado` });
      }
    }
    items.push({ t: "00:43", level: "info", msg: "› " + (phases[phaseIndex]?.desc || "procesando") + "…" });
    return items.slice(-6);
  }, [phaseIndex]);

  return (
    <div style={{
      background: "var(--obsidian-925)",
      border: "1px solid var(--border-subtle)",
      borderRadius: 10,
      padding: "12px 16px",
      fontFamily: "var(--font-mono)",
      fontSize: 11.5,
      lineHeight: 1.7,
      maxHeight: 160,
      overflow: "hidden",
      position: "relative",
    }}>
      {entries.map((e, i) => (
        <div key={i} style={{
          display: "grid",
          gridTemplateColumns: "52px 14px 1fr",
          gap: 6,
          alignItems: "center",
          color: e.level === "ok" ? "var(--jade-300)" : "var(--paper-300)",
          opacity: i === entries.length - 1 ? 1 : 0.55,
        }}>
          <span style={{ color: "var(--paper-500)" }}>{e.t}</span>
          <span>{e.level === "ok" ? "✓" : "›"}</span>
          <span>{e.msg}</span>
        </div>
      ))}
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: 30,
        background: "linear-gradient(180deg, transparent, var(--obsidian-925))",
        pointerEvents: "none",
      }}/>
    </div>
  );
};

const fmtTime = (s) => {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
};

window.Generator = Generator;
