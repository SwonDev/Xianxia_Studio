/* eslint-disable */
// Dashboard — minimal, typographic, with live system rhythm
function Dashboard({ generating, progress, onNavigate, services }) {
  const Ico = window.Icon;
  const Pipeline = window.Pipeline;
  const Sparkline = window.Sparkline;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "Buenas noches";
    if (h < 13) return "Buenos días";
    if (h < 20) return "Buenas tardes";
    return "Buenas noches";
  })();

  const stats = [
    { label: "Proyectos", value: 12, sub: "3 generándose" },
    { label: "Esta semana", value: 47, unit: "min", sub: "+12 vs anterior" },
    { label: "Publicados", value: 8, sub: "en YouTube" },
    { label: "Engagement", value: 78, unit: "%", sub: "TRIBE score" },
  ];

  const activity = [
    { id: 1, kind: "done", title: "Generación completada", quoted: "El ascenso del Inmortal del Trueno", time: "hace 12 min" },
    { id: 2, kind: "upload", title: "Vídeo subido a YouTube", quoted: "The Cultivation of Lü Dongbin", time: "hace 1 h" },
    { id: 3, kind: "shorts", title: "3 Shorts extraídos de", quoted: "podcast-ep-14.mp4", time: "hace 3 h" },
    { id: 4, kind: "error", title: "Fase Música falló · reintentando", quoted: "The fall of the Demon Empress", time: "hace 5 h" },
    { id: 5, kind: "done", title: "Generación completada", quoted: "Origin of the Eight Immortals", time: "ayer · 22:14" },
  ];

  const actIcon = {
    done: { icon: "Check", tone: "is-jade" },
    upload: { icon: "YouTube", tone: "is-gold" },
    shorts: { icon: "Scissors", tone: "is-gold" },
    error: { icon: "X", tone: "is-crimson" },
  };

  return (
    <div className="page" data-screen-label="Dashboard">
      {/* Hero — typographic, not boxed */}
      <div style={{ marginBottom: 44 }}>
        <div className="eyebrow">{greeting} · bienvenido al estudio</div>
        <h1 className="page-title" style={{ fontSize: 44 }}>
          El cultivo del contenido
          <br />
          <em>comienza aquí.</em>
        </h1>
        <p className="page-sub" style={{ marginTop: 18 }}>
          {generating ? (
            <>
              Tu pipeline está en marcha — fase{" "}
              <span className="gold">{Math.floor(progress / 10) + 1}</span> de 10, alrededor de{" "}
              <span className="gold tabular">~{Math.max(1, 14 - Math.floor(progress / 7))} min</span> restantes.
            </>
          ) : (
            <>
              Procesamiento IA enteramente local. Sin claves API, sin cuotas, sin que tus ideas pasen por servidores ajenos.
            </>
          )}
        </p>

        <div className="row gap-3" style={{ marginTop: 22 }}>
          <button className="btn btn-primary btn-lg" onClick={() => onNavigate("generator")}>
            <Ico.Sparkles size={16} />
            Generar nuevo vídeo
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => onNavigate("shorts")}>
            <Ico.Scissors size={15} />
            Extraer Shorts
          </button>
          <button className="btn btn-ghost btn-lg">
            <Ico.Folder size={15} />
            Abrir biblioteca
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 0,
          padding: "8px 0",
          borderTop: "1px solid var(--stroke-faint)",
          borderBottom: "1px solid var(--stroke-faint)",
        }}
      >
        {stats.map((s, i) => (
          <div
            key={s.label}
            className="stat"
            style={{
              padding: "20px 24px",
              borderLeft: i > 0 ? "1px solid var(--stroke-faint)" : "none",
            }}
          >
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">
              <CountUp to={s.value} />
              {s.unit && <span className="stat-unit"> {s.unit}</span>}
            </span>
            <span className="stat-sub">{s.sub}</span>
          </div>
        ))}
      </div>

      {/* Two columns: live activity + system */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
          gap: 48,
          marginTop: 44,
        }}
      >
        {/* Activity */}
        <div>
          <div className="section-row">
            <div>
              <div className="section-eyebrow">Actividad reciente</div>
            </div>
            <button className="btn btn-ghost btn-sm">
              Ver todo <Ico.ChevronRight size={12} />
            </button>
          </div>

          <div className="activity-list">
            {activity.map((a) => {
              const meta = actIcon[a.kind];
              const ActIco = Ico[meta.icon];
              return (
                <div className="activity-item" key={a.id}>
                  <span className={`activity-icon ${meta.tone}`}>
                    <ActIco size={13} />
                  </span>
                  <span className="activity-title">
                    {a.title} <span className="activity-quoted">«{a.quoted}»</span>
                  </span>
                  <span className="activity-meta">{a.time}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* System */}
        <div>
          <div className="section-row">
            <div className="section-eyebrow">Estado del sistema</div>
            <span className="kbd-row">
              <span
                className={`dot ${generating ? "dot-gold" : "dot-jade"}`}
              />
              {generating ? "Trabajando" : "Inactivo"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
            <MiniStat label="CPU" value="34" unit="%" data={[12, 18, 22, 28, 35, 30, 34]} tint="gold" />
            <MiniStat label="VRAM" value="5.2" unit="/8 GB" data={[2.1, 3.4, 4.0, 4.8, 5.0, 5.2, 5.2]} tint="jade" />
          </div>

          <div className="surface-flat" style={{ padding: "4px 16px" }}>
            {services.map((s) => (
              <div className="service-row" key={s.id} style={{ padding: "10px 0" }}>
                <div className="service-left">
                  <span className={`dot ${s.status === "running" ? "dot-jade" : "dot-muted"}`} />
                  <span className="service-name">{s.name}</span>
                  <span className="service-meta">:{s.port}</span>
                </div>
                <span className={`service-status ${s.status === "running" ? "is-on" : "is-off"}`}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Live pipeline strip when generating */}
      {generating && (
        <div style={{ marginTop: 48 }}>
          <div className="section-row">
            <div className="section-eyebrow">Pipeline en marcha</div>
            <span className="muted" style={{ fontSize: 12 }}>
              «El ascenso del Inmortal del Trueno» · 14 min · EN
            </span>
          </div>
          <div className="surface" style={{ padding: "8px 14px" }}>
            <Pipeline progress={progress} compact />
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, unit, data, tint }) {
  const Sparkline = window.Sparkline;
  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--bg-surface)",
        border: "1px solid var(--stroke-subtle)",
        borderRadius: 12,
      }}
    >
      <div className="stat-label">{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--paper-50)", letterSpacing: "-0.02em", marginTop: 2 }}>
        {value}
        <span className="stat-unit">{unit}</span>
      </div>
      <Sparkline data={data} tint={tint} width={140} height={24} />
    </div>
  );
}

function CountUp({ to, duration = 1000 }) {
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    let start;
    let raf;
    const step = (ts) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setN(to * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  const display = Number.isInteger(to) ? Math.round(n) : n.toFixed(1);
  return <span className="tabular">{display}</span>;
}

window.Dashboard = Dashboard;
window.CountUp = CountUp;
