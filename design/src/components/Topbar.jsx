/* eslint-disable */
// Topbar — minimal crumb + consolidated status pill with popover
const { useState: useStateTB, useEffect: useEffectTB, useRef: useRefTB } = React;

function Topbar({ crumbs, generating, services, progress }) {
  const [statusOpen, setStatusOpen] = useStateTB(false);
  const popRef = useRefTB(null);
  const Ico = window.Icon;

  useEffectTB(() => {
    if (!statusOpen) return;
    const onClick = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) {
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [statusOpen]);

  const runningCount = services.filter((s) => s.status === "running").length;
  const totalCount = services.length;
  const allUp = runningCount === totalCount;

  return (
    <header className="topbar">
      <div className="topbar-left">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <span className="crumb-sep">
                <Ico.ChevronRight size={12} />
              </span>
            )}
            <span className={i === crumbs.length - 1 ? "crumb-current" : ""}>{c}</span>
          </React.Fragment>
        ))}
      </div>

      <div className="topbar-right">
        <button className="icon-btn" title="Buscar (⌘K)">
          <Ico.Search size={16} />
        </button>
        <button className="icon-btn" title="Notificaciones">
          <Ico.Bell size={16} />
        </button>
        <button className="icon-btn" title="Ayuda">
          <Ico.Help size={16} />
        </button>

        <div style={{ width: 8 }} />

        <div style={{ position: "relative" }} ref={popRef}>
          <button
            className={`status-pill ${generating ? "is-active" : ""}`}
            onClick={() => setStatusOpen((v) => !v)}
            aria-expanded={statusOpen}
          >
            {generating ? (
              <>
                <span style={{ position: "relative", width: 14, height: 14 }}>
                  <ProgressRing value={progress} size={14} />
                </span>
                <span>Generando · fase {Math.min(10, Math.floor(progress / 10) + 1)}/10</span>
                <span className="tabular muted" style={{ fontSize: 11 }}>
                  {Math.round(progress)}%
                </span>
              </>
            ) : (
              <>
                <span className={`dot ${allUp ? "dot-jade" : "dot-muted"}`} />
                <span>{allUp ? "Inactivo" : `${runningCount}/${totalCount} servicios`}</span>
                <Ico.ChevronDown size={12} style={{ opacity: 0.5 }} />
              </>
            )}
          </button>

          {statusOpen && (
            <div className="popover">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>Estado del sistema</div>
                <div className="muted" style={{ fontSize: 11 }}>RTX 4060 · 8 GB</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <div className="stat" style={{ padding: 0 }}>
                  <span className="stat-label">CPU</span>
                  <span style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--paper-50)" }}>
                    34<span className="stat-unit">%</span>
                  </span>
                  <Sparkline data={[12, 18, 22, 28, 35, 30, 34]} />
                </div>
                <div className="stat" style={{ padding: 0 }}>
                  <span className="stat-label">VRAM</span>
                  <span style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--paper-50)" }}>
                    5.2<span className="stat-unit">/8 GB</span>
                  </span>
                  <Sparkline data={[2.1, 3.4, 4.0, 4.8, 5.0, 5.2, 5.2]} tint="jade" />
                </div>
              </div>

              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 6 }}>
                Servicios
              </div>
              <div>
                {services.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 4px",
                      fontSize: 12.5,
                      borderBottom: "1px solid var(--stroke-faint)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        className={`dot ${s.status === "running" ? "dot-jade" : "dot-muted"}`}
                      />
                      <span style={{ color: "var(--text-primary)" }}>{s.name}</span>
                      <span className="muted" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
                        :{s.port}
                      </span>
                    </div>
                    <span className={`service-status ${s.status === "running" ? "is-on" : "is-off"}`}>
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--stroke-faint)" }}>
                <button className="btn btn-ghost btn-sm" style={{ width: "100%" }}>
                  Abrir ajustes del sistema
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function ProgressRing({ value, size = 16, stroke = 2 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--gold-400)"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.5s cubic-bezier(0.16,1,0.3,1)" }}
      />
    </svg>
  );
}

function Sparkline({ data, width = 130, height = 28, tint = "gold" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data) || 1;
  const min = Math.min(...data);
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / (max - min || 1)) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(" ");
  const color = tint === "jade" ? "#52b788" : "#c9a84c";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 4 }}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <polyline
        points={`0,${height} ${pts} ${width},${height}`}
        fill={color}
        opacity="0.08"
        stroke="none"
      />
    </svg>
  );
}

window.Topbar = Topbar;
window.ProgressRing = ProgressRing;
window.Sparkline = Sparkline;
