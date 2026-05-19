/* eslint-disable */
// Dashboard — System Settings-style inset groups. No quotes, no italic, no shimmer.

function Dashboard({ onNavigate, pipeline }) {
  return (
    <div className="route-enter page">
      <PageHeader
        title="Resumen"
        subtitle="Todo lo que ocurre en el estudio en una sola pantalla."
        action={
          <button className="btn-primary large" onClick={() => onNavigate("generator")}>
            <I.Plus size={11} strokeWidth={2.5}/>
            Nuevo vídeo
          </button>
        }
      />

      {/* Live pipeline strip — only when running */}
      {pipeline.running && (
        <div style={{ marginBottom: 22 }} className="fade-up">
          <LivePipelineStrip pipeline={pipeline} onClick={() => onNavigate("generator")}/>
        </div>
      )}

      {/* Stats — inset group, 4 rows */}
      <Group label="Resumen">
        <Row
          icon="Pencil" iconColor="#7a8a8a"
          title="Borradores" sub="Sin generar todavía"
          value="2" chev onClick={() => onNavigate("library")}
        />
        <Row
          icon="Calendar" iconColor="#d4b85a"
          title="En cola" sub="Próximo: viernes 14:00"
          value="1" chev onClick={() => onNavigate("scheduler")}
        />
        <Row
          icon="Library" iconColor="#5ed8a6"
          title="Publicados" sub="Último: hace 2 días · 2.4K vistas"
          value="12" chev onClick={() => onNavigate("library")}
        />
        <Row
          icon="Bolt" iconColor="#d4b85a"
          title="Hardware" sub="Intel i9 · RTX 4080 · 32 GB"
          value="Ultra" chev onClick={() => onNavigate("settings")}
        />
      </Group>

      {/* Retention curve — last published */}
      <RetentionCurve onClick={() => onNavigate("library")}/>

      {/* Trending topics */}
      <TrendingTopics onPick={(t) => onNavigate("generator")}/>

      {/* Recent activity */}
      <Group label="Actividad reciente">
        <RecentRow
          title="El Emperador de Jade y los Nueve Cielos"
          status="publishing" progress={86} duration="13:24"
          onClick={() => onNavigate("library")}
        />
        <RecentRow
          title="Norse mythology — Ragnarök and the fall of the gods"
          status="ready" duration="12:08" size="580 MB"
          onClick={() => onNavigate("library")}
        />
        <RecentRow
          title="Black holes and the limits of physics"
          status="published" duration="10:41" views="1.2K"
          onClick={() => onNavigate("library")}
        />
        <RecentRow
          title="La leyenda de los espadachines del Bosque Lunar"
          status="draft" duration="—"
          onClick={() => onNavigate("library")}
        />
      </Group>

      {/* Shortcuts */}
      <Group label="Atajos">
        <Row
          icon="Sparkles" iconColor="#2eb189"
          title="Generar vídeo nuevo" sub="Tema → vídeo cinematográfico"
          value="⌘N" chev onClick={() => onNavigate("generator")}
        />
        <Row
          icon="Scissors" iconColor="#1f9e7a"
          title="Smart Shorts" sub="Extraer clips virales de un MP4"
          value="⌘S" chev onClick={() => onNavigate("shorts")}
        />
        <Row
          icon="Mic" iconColor="#d4b85a"
          title="Clonar mi voz" sub="5 segundos de audio bastan"
          chev onClick={() => window.__openVoiceClone?.()}
        />
      </Group>

      <div style={{
        textAlign: "center",
        fontSize: 11,
        color: "var(--text-tertiary)",
        marginTop: 32,
      }}>
        Xianxia Studio 0.2.10 · 100% local · Apache 2.0
      </div>
    </div>
  );
}

function RecentRow({ title, status, progress, duration, size, views, onClick }) {
  const statusInfo = {
    publishing: { dot: "dot-running pulse", label: "Publicando", color: "var(--orange)" },
    ready: { dot: "dot-running", label: "Listo", color: "var(--green)" },
    published: { dot: "dot-running", label: "Publicado", color: "var(--green)" },
    draft: { dot: "dot-missing", label: "Borrador", color: "var(--text-tertiary)" },
  }[status];

  return (
    <div className="row row-hoverable" onClick={onClick}>
      {/* Thumbnail — plain dark, no SVG decoration */}
      <div style={{
        width: 36, height: 22, borderRadius: 3,
        background: "rgba(0,0,0,0.4)",
        boxShadow: "0 0 0 0.5px rgba(255,255,255,0.06) inset",
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
      }}>
        {status === "publishing" && (
          <div style={{
            position: "absolute", bottom: 0, left: 0,
            height: 2, width: `${progress}%`,
            background: "var(--accent)",
          }}/>
        )}
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          color: "var(--text-tertiary)",
        }}>
          <I.Play size={8}/>
        </div>
      </div>

      <div className="row-label">
        <div className="row-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
        <div className="row-sub">
          {duration}
          {size && <> · {size}</>}
          {views && <> · {views} vistas</>}
          {status === "publishing" && <> · {progress}%</>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className={"dot " + statusInfo.dot}/>
        <span style={{ fontSize: 11, color: statusInfo.color }}>{statusInfo.label}</span>
      </div>
      <I.Chevron size={11} className="chev"/>
    </div>
  );
}

Object.assign(window, { Dashboard });

function LivePipelineStrip({ pipeline, onClick }) {
  const phases = ["Guion", "Meta", "Voz", "Imágenes", "Música", "Vídeo", "Thumb", "Subs", "Upload", "Plan"];
  const current = pipeline.phase;
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        background: "var(--bg-list)",
        borderRadius: "var(--r-lg)",
        padding: "12px 14px",
        textAlign: "left",
        display: "flex", alignItems: "center", gap: 14,
        transition: "background 120ms",
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-elevated)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "var(--bg-list)"}
    >
      {/* Progress ring */}
      <div style={{ position: "relative", width: 28, height: 28, flexShrink: 0 }}>
        <svg width="28" height="28" viewBox="0 0 28 28" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2"/>
          <circle cx="14" cy="14" r="11" fill="none" stroke="var(--accent)" strokeWidth="2"
            strokeDasharray={`${(current/10)*69} 69`} strokeLinecap="round"
            style={{ transition: "stroke-dasharray 500ms var(--ease-spring)" }}
          />
        </svg>
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 600,
        }}>{current}</div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="dot dot-running pulse"/>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Generando · {phases[current-1]}</span>
        </div>
        <div className="caption" style={{ marginTop: 2 }}>{pipeline.message}</div>
      </div>

      <I.Chevron size={12} className="chev"/>
    </button>
  );
}

/* ── Retention curve — last published ──────────────────────────────── */
function RetentionCurve({ onClick }) {
  // Mock retention data — drops naturally with one bounce at 6:30 (engagement boost)
  const data = [100, 96, 92, 88, 84, 80, 76, 73, 70, 68, 66, 78, 75, 71, 68, 65, 62, 58, 55, 52, 48];
  const peak = 78; // index 11
  const w = 540, h = 80;
  const points = data.map((y, i) => [`${(i / (data.length - 1)) * w}`, h - (y / 100) * h]).join(" L ");
  return (
    <div style={{
      padding: "16px 18px",
      background: "var(--glass-card)",
      backdropFilter: "blur(60px) saturate(190%)",
      WebkitBackdropFilter: "blur(60px) saturate(190%)",
      borderRadius: "var(--r-lg)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 0.5px rgba(255,255,255,0.07), 0 6px 18px -4px rgba(0,0,0,0.30)",
      marginBottom: 22,
      cursor: "default",
      transition: "background 140ms",
    }}
      onClick={onClick}
    >
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10 }}>
        <span className="title" style={{ fontSize: 13 }}>Retención · último vídeo publicado</span>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 11.5 }}>
          Promedio: <strong style={{ color: "var(--accent-soft)" }}>72%</strong> · Pico: <strong style={{ color: "var(--accent-soft)" }}>78%</strong> en 6:32
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h + 8}`} width="100%" height={h + 8} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id="retGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(94,216,166,0.50)"/>
            <stop offset="100%" stopColor="rgba(46,177,137,0)"/>
          </linearGradient>
        </defs>
        {/* Gridlines */}
        {[0, 25, 50, 75].map(p => (
          <line key={p} x1="0" x2={w} y1={h - (p/100)*h} y2={h - (p/100)*h} stroke="rgba(255,255,255,0.05)"/>
        ))}
        {/* Fill */}
        <path d={`M 0 ${h - (data[0]/100)*h} L ${points} L ${w} ${h} L 0 ${h} Z`} fill="url(#retGrad)"/>
        {/* Line */}
        <path d={`M 0 ${h - (data[0]/100)*h} L ${points}`} fill="none" stroke="var(--accent-soft)" strokeWidth="1.5" style={{ filter: "drop-shadow(0 0 4px rgba(94,216,166,0.55))" }}/>
        {/* Peak marker */}
        <circle cx={(11 / (data.length - 1)) * w} cy={h - (peak/100)*h} r="3" fill="var(--accent-soft)" style={{ filter: "drop-shadow(0 0 6px rgba(94,216,166,0.85))" }}/>
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: "var(--text-tertiary)" }}>
        <span>0:00</span><span>3:21</span><span>6:42</span><span>10:03</span><span>13:24</span>
      </div>
    </div>
  );
}

/* ── Trending topics ────────────────────────────────────────────────── */
function TrendingTopics({ onPick }) {
  const trends = [
    { topic: "Las nueve dinastías celestiales", delta: "+340%", reason: "Búsquedas YouTube · esta semana", icon: "Sparkles", tint: "#2eb189" },
    { topic: "El Buda flotante de Leshan", delta: "+180%", reason: "Tendencia regional · CN/ES/MX", icon: "Brain", tint: "#5ed8a6" },
    { topic: "Demonios del río Nai He", delta: "+95%", reason: "Comentarios de tu canal", icon: "Wand", tint: "#d4b85a" },
  ];
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span className="title" style={{ fontSize: 13 }}>Tendencias en tu nicho</span>
        <span className="caption" style={{ marginLeft: 8 }}>· basado en tus últimos 12 vídeos</span>
        <button className="btn-ghost" style={{ marginLeft: "auto", fontSize: 11 }}>
          <I.Refresh size={10}/> Actualizar
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {trends.map((t, i) => {
          const Icon = I[t.icon];
          return (
          <button key={i} onClick={() => onPick(t.topic)} style={{
            padding: "12px 14px",
            textAlign: "left",
            background: "var(--glass-card)",
            backdropFilter: "blur(40px) saturate(190%)",
            WebkitBackdropFilter: "blur(40px) saturate(190%)",
            borderRadius: 10,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 0.5px rgba(255,255,255,0.07), 0 4px 12px -3px rgba(0,0,0,0.25)",
            transition: "all 200ms var(--ease-spring)",
          }}
            onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-2px)"}
            onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className="lg-tile md" style={{ "--tint": t.tint }}>
                <Icon size={11}/>
              </span>
              <span style={{
                fontSize: 10.5, color: "var(--accent-soft)",
                background: "rgba(94,216,166,0.15)",
                padding: "1px 6px",
                borderRadius: 999,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
              }}>{t.delta}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.3, textWrap: "pretty" }}>{t.topic}</div>
            <div className="caption" style={{ fontSize: 11, marginTop: 4 }}>{t.reason}</div>
          </button>
        );})}
      </div>
    </div>
  );
}
