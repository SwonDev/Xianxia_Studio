// Smart Shorts — drop an MP4, get viral clips

const SmartShorts = () => {
  const [hasFile, setHasFile] = React.useState(true);

  const clips = [
    { id: 1, t: "00:42 – 01:09", score: 94, label: "Vehement", hook: "El maestro se levanta del trance" },
    { id: 2, t: "03:15 – 03:48", score: 87, label: "Sublime",  hook: "La espada queda flotando" },
    { id: 3, t: "07:21 – 07:52", score: 81, label: "Mistério", hook: "Las nueve preguntas" },
    { id: 4, t: "12:08 – 12:36", score: 76, label: "Cierre",   hook: "Y entonces, recordó su nombre" },
  ];

  return (
    <div className="screen-inner page-enter">
      <header style={{ marginBottom: 36 }}>
        <span className="eyebrow">Smart Shorts</span>
        <h1 className="h-display" style={{ marginTop: 12, marginBottom: 12 }}>
          De un vídeo largo a <span className="em">clips virales</span>.
        </h1>
        <p className="lede">
          Sube un MP4 y la IA local identifica los fragmentos más cinematográficos,
          los recorta en vertical, añade subtítulos y los exporta listos para subir.
        </p>
      </header>

      {!hasFile ? (
        <DropZone onSelect={() => setHasFile(true)} />
      ) : (
        <>
          <SourceCard onReplace={() => setHasFile(false)} />

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "32px 0 16px" }}>
            <div>
              <h2 className="h-section">4 clips detectados</h2>
              <p style={{ fontSize: 12.5, color: "var(--paper-400)", margin: "4px 0 0" }}>
                Ordenados por puntuación de engagement (TRIBE v2). Puntos altos = mayor probabilidad viral.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary">
                <Icons.Refresh /> Reanalizar
              </button>
              <button className="btn btn-primary">
                <Icons.Download /> Exportar 4 clips
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
            {clips.map((c) => <ClipCard key={c.id} clip={c} />)}
          </div>
        </>
      )}
    </div>
  );
};

const DropZone = ({ onSelect }) => (
  <button
    onClick={onSelect}
    style={{
      width: "100%",
      padding: "64px 32px",
      border: "2px dashed var(--border-default)",
      borderRadius: 16,
      background: "rgba(255,255,255,0.012)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
      transition: "all 200ms var(--ease-std)",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)"; e.currentTarget.style.background = "rgba(201,168,76,0.03)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.background = "rgba(255,255,255,0.012)"; }}
  >
    <div style={{
      width: 64, height: 64, borderRadius: 16,
      background: "linear-gradient(135deg, rgba(201,168,76,0.18), rgba(82,183,136,0.12))",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "var(--gold-300)",
    }}>
      <Icons.Upload style={{ width: 28, height: 28 }} />
    </div>
    <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--paper-50)" }}>
      Suelta tu vídeo aquí
    </div>
    <div style={{ fontSize: 13, color: "var(--paper-300)" }}>
      o haz clic para seleccionar · MP4, MOV, MKV · hasta 4 GB
    </div>
  </button>
);

const SourceCard = ({ onReplace }) => (
  <section style={{
    display: "grid",
    gridTemplateColumns: "200px 1fr auto",
    gap: 20,
    padding: 18,
    border: "1px solid var(--border-default)",
    borderRadius: 14,
    background: "rgba(255,255,255,0.015)",
    alignItems: "center",
  }}>
    <div style={{
      aspectRatio: "16/9", width: 200,
      borderRadius: 8,
      background: "radial-gradient(120% 100% at 30% 30%, #6b3a1f, #1c1c26 70%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      position: "relative", overflow: "hidden",
    }}>
      <Icons.Play style={{ width: 28, height: 28, color: "rgba(232,232,240,0.55)" }}/>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 70% 70%, rgba(255,255,255,0.08), transparent 60%)" }}/>
    </div>
    <div>
      <div style={{ fontSize: 11, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
        Vídeo de origen
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--paper-50)", margin: "4px 0" }}>
        documental-cultivadores-acto2.mp4
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--paper-400)", marginTop: 4 }}>
        <span>14:32</span>
        <span>·</span>
        <span>1920×1080</span>
        <span>·</span>
        <span>384 MB</span>
        <span>·</span>
        <Pill icon="Check" tone="jade">Analizado</Pill>
      </div>
    </div>
    <button className="btn btn-ghost" onClick={onReplace}>
      <Icons.Refresh /> Reemplazar
    </button>
  </section>
);

const ClipCard = ({ clip }) => {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--border-default)" }}>
      {/* Vertical thumbnail */}
      <div style={{
        aspectRatio: "16/9",
        position: "relative",
        background: `radial-gradient(120% 80% at 30% 30%, hsl(${clip.id * 47}, 32%, 35%), var(--obsidian-900))`,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderBottom: "1px solid var(--border-subtle)",
      }}>
        {/* vertical crop overlay */}
        <div style={{
          position: "absolute",
          top: 8, bottom: 8,
          left: "50%", transform: "translateX(-50%)",
          aspectRatio: "9/16",
          height: "calc(100% - 16px)",
          border: "1.5px solid var(--gold-300)",
          boxShadow: "0 0 0 200px rgba(10,10,15,0.55)",
          borderRadius: 4,
        }}/>
        <div style={{ position: "absolute", top: 10, left: 10 }}>
          <Pill tone="gold" icon="Bolt">{clip.score}</Pill>
        </div>
        <div style={{ position: "absolute", bottom: 10, right: 10 }} className="mono">
          <Pill>{clip.t.split(" – ")[1]}</Pill>
        </div>
        <button style={{
          position: "absolute",
          width: 48, height: 48, borderRadius: 999,
          background: "rgba(232,201,109,0.95)",
          color: "var(--obsidian-950)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4), 0 0 0 4px rgba(232,201,109,0.2)",
          zIndex: 2,
        }}>
          <Icons.Play style={{ width: 16, height: 16, marginLeft: 2 }} />
        </button>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 16.5, color: "var(--paper-50)", lineHeight: 1.3 }}>
            {clip.hook}
          </div>
          <span className="mono" style={{ fontSize: 11, color: "var(--paper-400)", whiteSpace: "nowrap" }}>{clip.t}</span>
        </div>

        {/* engagement bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--paper-400)" }}>
          <Icons.Brain style={{ width: 11, height: 11 }} />
          <div style={{
            flex: 1, height: 4, borderRadius: 999,
            background: "rgba(255,255,255,0.05)",
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: `${clip.score}%`,
              background: "linear-gradient(90deg, var(--gold-500), var(--jade-400))",
              borderRadius: 999,
            }}/>
          </div>
          <span style={{ color: "var(--paper-200)", fontFamily: "var(--font-mono)" }}>{clip.score}</span>
          <span style={{ color: "var(--paper-400)" }}>· {clip.label}</span>
        </div>

        <div style={{ display: "flex", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
          <button className="btn btn-ghost" style={{ height: 26, fontSize: 11.5, padding: "0 8px", flex: 1 }}>
            <Icons.Edit /> Editar
          </button>
          <button className="btn btn-ghost" style={{ height: 26, fontSize: 11.5, padding: "0 8px", flex: 1 }}>
            <Icons.Eye /> Vista previa
          </button>
          <button className="btn btn-primary" style={{ height: 26, fontSize: 11.5, padding: "0 10px", flex: 1 }}>
            <Icons.Download /> Exportar
          </button>
        </div>
      </div>
    </div>
  );
};

window.SmartShorts = SmartShorts;
