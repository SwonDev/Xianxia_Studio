/* eslint-disable */
// Shell — macOS-native: source-list sidebar + NSToolbar + system popover.
// NO Qi particles, NO shimmer, NO decorative flourishes.

const NAV_GROUPS = [
  { label: "Estudio", items: [
    { id: "dashboard", label: "Resumen", icon: "Home" },
    { id: "generator", label: "Generador", icon: "Sparkles" },
    { id: "shorts", label: "Smart Shorts", icon: "Scissors" },
  ]},
  { label: "Contenido", items: [
    { id: "library", label: "Biblioteca", icon: "Library" },
    { id: "scheduler", label: "Planificador", icon: "Calendar" },
  ]},
  { label: "Sistema", items: [
    { id: "install", label: "Instalador", icon: "Download" },
    { id: "settings", label: "Ajustes", icon: "Settings" },
  ]},
];

const ICON_TINTS = {
  // Estudio — jade (creación)
  dashboard: "#5ed8a6",   // jade pálido
  generator: "#2eb189",   // jade imperial
  shorts:    "#1f9e7a",   // teal-jade
  // Contenido — oro champaña (regalia)
  library:   "#d4b85a",   // oro champaña
  scheduler: "#c9a84c",   // oro base
  // Sistema — nefrita (utilidad)
  install:   "#7a8a8a",   // nefrita
  settings:  "#5d7575",   // nefrita oscura
};

function Sidebar({ active, onNavigate, rail, pipeline }) {
  return (
    <aside style={{
      width: rail ? "var(--sidebar-rail)" : "var(--sidebar-w)",
      flexShrink: 0,
      background: "var(--glass-sidebar)",
      backdropFilter: "blur(80px) saturate(200%)",
      WebkitBackdropFilter: "blur(80px) saturate(200%)",
      borderRight: "0.5px solid rgba(255,255,255,0.07)",
      boxShadow: "inset -0.5px 0 0 rgba(0,0,0,0.20)",
      display: "flex",
      flexDirection: "column",
      transition: "width 240ms var(--ease)",
      position: "relative",
    }}>
      {/* Traffic light area — Mac convention, gives drag zone */}
      <div style={{
        height: "var(--toolbar-h)",
        display: "flex",
        alignItems: "center",
        padding: rail ? "0" : "0 14px",
        gap: 8,
        justifyContent: rail ? "center" : "flex-start",
      }}>
        {!rail && (
          <>
            <span style={{ width: 12, height: 12, borderRadius: 999, background: "#ff5f57" }}/>
            <span style={{ width: 12, height: 12, borderRadius: 999, background: "#febc2e" }}/>
            <span style={{ width: 12, height: 12, borderRadius: 999, background: "#28c840" }}/>
          </>
        )}
      </div>

      {/* Sidebar list */}
      <nav style={{ flex: 1, padding: "4px 10px", overflowY: "auto" }}>
        {NAV_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            {!rail && (
              <div style={{
                padding: "6px 8px 4px",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-tertiary)",
                letterSpacing: 0,
              }}>{g.label}</div>
            )}
            {g.items.map((item) => {
              const Icon = I[item.icon];
              const isActive = active === item.id;
              const tint = ICON_TINTS[item.id] || "#7a7a85";
              return (
                <button
                  key={item.id}
                  onClick={() => onNavigate(item.id)}
                  title={rail ? item.label : undefined}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: rail ? "8px 0" : "5px 10px",
                    height: 34,
                    borderRadius: 999,
                    color: "var(--text-primary)",
                    background: isActive ? "var(--sidebar-selection)" : "transparent",
                    boxShadow: isActive
                      ? "inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -0.5px 0 rgba(0,0,0,0.18), 0 0 0 0.5px rgba(94,216,166,0.45), 0 2px 6px rgba(0,0,0,0.22)"
                      : "none",
                    transition: "all 160ms var(--ease-spring)",
                    justifyContent: rail ? "center" : "flex-start",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <span className="lg-tile md" style={{ "--tint": tint }}>
                    <Icon size={13}/>
                  </span>
                  {!rail && (
                    <span style={{
                      fontSize: 13,
                      fontWeight: isActive ? 500 : 400,
                      letterSpacing: 0,
                      color: isActive ? "var(--text-primary)" : "var(--text-primary)",
                    }}>{item.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer widget — disk & activity */}
      <SidebarWidget rail={rail} pipeline={pipeline}/>
    </aside>
  );
}

function SidebarWidget({ rail, pipeline }) {
  const diskPct = 38; // demo
  return (
    <div style={{
      padding: rail ? "8px 8px 10px" : "10px 12px 12px",
      borderTop: "0.5px solid rgba(255,255,255,0.06)",
    }}>
      {pipeline?.running ? (
        <div style={{
          padding: rail ? "6px 0" : "8px 10px",
          background: "rgba(46,177,137,0.08)",
          borderRadius: 8,
          boxShadow: "inset 0 0.5px 0 rgba(255,255,255,0.08), 0 0 0 0.5px rgba(94,216,166,0.20)",
          display: "flex", alignItems: "center", gap: rail ? 0 : 8,
          justifyContent: rail ? "center" : "flex-start",
          marginBottom: rail ? 0 : 8,
        }}>
          <div style={{ position: "relative", width: 18, height: 18, flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="2"/>
              <circle cx="9" cy="9" r="7" fill="none" stroke="var(--accent-soft)" strokeWidth="2"
                strokeDasharray={`${(pipeline.phase/10) * 44} 44`} strokeLinecap="round"
                style={{ transition: "stroke-dasharray 600ms var(--ease-spring)", filter: "drop-shadow(0 0 3px rgba(94,216,166,0.85))" }}
              />
            </svg>
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, fontWeight: 700, color: "var(--accent-soft)",
            }}>{pipeline.phase}</div>
          </div>
          {!rail && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 500 }}>Generando</div>
              <div className="caption" style={{ fontSize: 10, marginTop: 0 }}>fase {pipeline.phase}/10 · {Math.round(pipeline.subProgress)}%</div>
            </div>
          )}
        </div>
      ) : null}

      {!rail && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>Disco</span>
            <span className="mono" style={{ fontSize: 10, color: "var(--text-secondary)" }}>412 GB libre</span>
          </div>
          <div style={{ height: 3, background: "rgba(0,0,0,0.30)", borderRadius: 999, overflow: "hidden", boxShadow: "inset 0 0.5px 0 rgba(0,0,0,0.20)" }}>
            <div style={{
              width: `${diskPct}%`, height: "100%",
              background: "linear-gradient(90deg, var(--accent-deep), var(--accent))",
              borderRadius: 999,
            }}/>
          </div>
        </div>
      )}
    </div>
  );
}

function Topbar({ active, systemRunning, onSystemClick, onCmdK, breadcrumb }) {
  return (
    <header style={{
      height: "var(--toolbar-h)",
      flexShrink: 0,
      background: "var(--glass-toolbar)",
      backdropFilter: "blur(80px) saturate(200%)",
      WebkitBackdropFilter: "blur(80px) saturate(200%)",
      borderBottom: "0.5px solid rgba(255,255,255,0.07)",
      boxShadow: "inset 0 -0.5px 0 rgba(0,0,0,0.14)",
      display: "flex",
      alignItems: "center",
      padding: "0 18px",
      gap: 14,
      position: "relative",
      zIndex: 20,
    }}>
      {/* Title */}
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.005em" }}>
        {breadcrumb}
      </div>

      <div style={{ flex: 1 }} />

      {/* Cmd-K — bigger glass pill */}
      <button
        onClick={onCmdK}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 12px 0 12px",
          height: 28,
          borderRadius: 999,
          background: "rgba(0,0,0,0.26)",
          color: "var(--text-tertiary)",
          fontSize: 12,
          minWidth: 220,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 0.5px rgba(255,255,255,0.10)",
        }}
      >
        <I.Search size={12}/>
        <span>Buscar</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <span className="kbd">⌘</span><span className="kbd">K</span>
        </span>
      </button>

      {/* System pill — strong glass capsule */}
      <button
        onClick={onSystemClick}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          padding: "0 12px",
          height: 28,
          borderRadius: 999,
          background: "rgba(255,255,255,0.12)",
          backdropFilter: "blur(30px) saturate(200%)",
          WebkitBackdropFilter: "blur(30px) saturate(200%)",
          transition: "background 120ms",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.26), inset 0 -0.5px 0 rgba(0,0,0,0.18), 0 0 0 0.5px rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.22)",
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.18)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.12)"}
      >
        <span className={"dot " + (systemRunning ? "dot-running pulse" : "dot-idle")}/>
        <span style={{ fontSize: 12, fontWeight: 500 }}>
          {systemRunning ? "Generando" : "Listo"}
        </span>
        <I.ChevronDown size={10} style={{ color: "var(--text-tertiary)" }}/>
      </button>
    </header>
  );
}

/* ── System Popover ────────────────────────────────────────────── */
function SystemPopover({ open, onClose, services, hardware, pulse }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    if (open) document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open) return null;
  const ramPct = (hardware.ramUsed / hardware.ramTotal) * 100;

  return (
    <div ref={ref} style={{
      position: "absolute",
      top: "calc(var(--toolbar-h) + 6px)",
      right: 16,
      width: 320,
      background: "var(--bg-popover)",
      backdropFilter: "blur(60px) saturate(190%)",
      WebkitBackdropFilter: "blur(60px) saturate(190%)",
      borderRadius: 14,
      boxShadow: "var(--shadow-popover)",
      zIndex: 50,
      overflow: "hidden",
      animation: "fade-up 220ms var(--ease-spring) both",
    }}>
      {/* Header */}
      <div style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={"dot " + (pulse ? "dot-running pulse" : "dot-idle")}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {pulse ? "Generando vídeo" : "Estudio listo"}
            </div>
            <div className="caption" style={{ marginTop: 1 }}>
              {pulse ? "Fase 6 de 10 · imágenes" : "Sin tareas en curso"}
            </div>
          </div>
        </div>
      </div>

      <div className="hr"/>

      {/* Services */}
      <div style={{ padding: "8px 6px" }}>
        {services.map((s) => (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "5px 10px",
            borderRadius: 5,
          }}>
            <span className={"dot " + (s.state === "running" ? "dot-running" : "dot-missing")}/>
            <span style={{ flex: 1, fontSize: 12.5 }}>{s.label}</span>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              {s.state === "running" ? "Activo" : "—"}
            </span>
          </div>
        ))}
      </div>

      <div className="hr"/>

      {/* Hardware */}
      <div style={{ padding: "10px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
          <span className="muted">CPU</span>
          <span className="mono">{hardware.cpu}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
          <span className="muted">GPU</span>
          <span className="mono">{hardware.gpu}</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <span className="muted">RAM</span>
            <span className="mono">{hardware.ramUsed.toFixed(1)} / {hardware.ramTotal} GB</span>
          </div>
          <div style={{ height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{
              width: `${ramPct}%`, height: "100%",
              background: ramPct > 80 ? "var(--red)" : "var(--accent)",
              transition: "width 500ms var(--ease)",
            }}/>
          </div>
        </div>
      </div>

      <div className="hr"/>

      <div style={{ padding: "6px 8px", display: "flex", gap: 2 }}>
        <button className="btn-ghost" style={{ flex: 1, justifyContent: "center" }}>
          Reiniciar servicios
        </button>
        <button className="btn-ghost" style={{ flex: 1, justifyContent: "center" }}>
          Abrir Ajustes
        </button>
      </div>
    </div>
  );
}

/* ── Page header — simple, no italic accent ─────────────────────── */
function PageHeader({ title, subtitle, action }) {
  return (
    <header style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 24,
      marginBottom: 24,
    }}>
      <div style={{ maxWidth: 560 }}>
        <h1 className="title-l" style={{ margin: 0 }}>{title}</h1>
        {subtitle && (
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.45 }}>
            {subtitle}
          </p>
        )}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </header>
  );
}

/* ── Inset grouped list primitives ──────────────────────────────── */
function Group({ label, children, footer }) {
  return (
    <div style={{ marginBottom: 22 }}>
      {label && <div className="group-label">{label}</div>}
      <div className="group">{children}</div>
      {footer && <div className="group-label" style={{ marginTop: 6, color: "var(--text-tertiary)" }}>{footer}</div>}
    </div>
  );
}

function Row({ icon, iconColor, title, sub, value, control, onClick, chev, hoverable }) {
  const Icon = icon ? I[icon] : null;
  return (
    <div
      className={"row" + (icon ? " with-icon" : "") + (hoverable || onClick ? " row-hoverable" : "")}
      onClick={onClick}
    >
      {Icon && (
        <span className="lg-tile md row-icon" style={{ "--tint": iconColor || "#a88a3c" }}>
          <Icon size={14}/>
        </span>
      )}
      <div className="row-label">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {value && <span className="row-value">{value}</span>}
      {control}
      {chev && <I.Chevron size={12} className="chev"/>}
    </div>
  );
}

Object.assign(window, { Sidebar, Topbar, SystemPopover, PageHeader, NAV_GROUPS, Group, Row });
