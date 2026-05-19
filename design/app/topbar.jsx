// Topbar — title + crumb + consolidated status popover + global action

const SCREEN_TITLES = {
  dashboard: { title: "Dashboard",     crumb: "Resumen" },
  generator: { title: "Generador",     crumb: "Producir" },
  shorts:    { title: "Smart Shorts",  crumb: "Producir" },
  library:   { title: "Biblioteca",    crumb: "Gestionar" },
  scheduler: { title: "Planificador",  crumb: "Gestionar" },
  install:   { title: "Instalador",    crumb: "Sistema" },
  settings:  { title: "Ajustes",       crumb: "Sistema" },
};

const Topbar = ({ active, onNav, pipeline }) => {
  const info = SCREEN_TITLES[active] || { title: "", crumb: "" };
  const [statusOpen, setStatusOpen] = React.useState(false);

  // Aggregate status
  const services = MockData.services;
  const running = services.filter((s) => s.state === "running").length;
  const total = services.length;
  const allHealthy = services.every((s) => s.state === "running" || s.state === "idle");
  const pulse = pipeline?.running;

  return (
    <header className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span className="topbar-crumb">
          {info.crumb}
          <Icons.ChevronRight />
        </span>
        <span className="topbar-title">{info.title}</span>
      </div>

      <div className="topbar-spacer" />

      {/* Inline pipeline pulse if generating */}
      {pulse && (
        <button
          onClick={() => onNav("generator")}
          className="topbar-status"
          style={{ background: "rgba(201,168,76,0.06)", borderColor: "rgba(201,168,76,0.25)" }}
        >
          <span className="topbar-status-dot is-idle" />
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, alignItems: "flex-start" }}>
            <span style={{ fontSize: 10.5, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>
              Generando · {Math.round(pipeline.progress * 100)}%
            </span>
            <span style={{ fontSize: 11, color: "var(--gold-200)" }}>{pipeline.label}</span>
          </span>
        </button>
      )}

      {/* Global status popover */}
      <div style={{ position: "relative" }}>
        <button
          onClick={() => setStatusOpen((o) => !o)}
          className="topbar-status"
          style={{ paddingLeft: 10 }}
        >
          <span className={`topbar-status-dot${allHealthy ? "" : " is-error"}`} />
          <span className="topbar-status-label">
            {allHealthy ? "Estudio en línea" : "Atención requerida"}
          </span>
          <Icons.ChevronDown style={{ width: 10, height: 10, color: "var(--paper-400)" }} />
        </button>

        {statusOpen && (
          <StatusPopover
            services={services}
            hardware={MockData.hardware}
            onClose={() => setStatusOpen(false)}
            onOpenSettings={() => { setStatusOpen(false); onNav("settings"); }}
          />
        )}
      </div>

      <button className="topbar-icon-btn" title="Notificaciones">
        <Icons.Bell />
      </button>

      <button className="btn btn-primary" onClick={() => onNav("generator")}>
        <Icons.Plus />
        Nuevo vídeo
      </button>
    </header>
  );
};

const StatusPopover = ({ services, hardware, onClose, onOpenSettings }) => {
  React.useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest('[data-status-pop]')) onClose();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  return (
    <div
      data-status-pop
      style={{
        position: "absolute",
        top: "calc(100% + 8px)", right: 0,
        width: 320,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 12,
        boxShadow: "0 20px 50px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.04) inset",
        padding: 12,
        zIndex: 100,
        animation: "sheetIn 260ms var(--ease-mac)",
      }}
    >
      <div style={{ padding: "4px 8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
          Servicios locales
        </span>
        <span className="pill pill-jade">
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor" }}/>
          todo OK
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {services.map((s) => (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 8px", borderRadius: 7,
            transition: "background 120ms",
          }}
            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
            onMouseLeave={(e) => e.currentTarget.style.background = ""}
          >
            <StatusDot state={s.state} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--paper-100)", fontWeight: 500 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: "var(--paper-400)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.hint}
              </div>
            </div>
            <span style={{ fontSize: 10.5, color: s.state === "running" ? "var(--jade-400)" : "var(--paper-400)", fontFamily: "var(--font-mono)" }}>
              {s.state === "running" ? "● activo" : s.state === "idle" ? "○ inactivo" : "○ falta"}
            </span>
          </div>
        ))}
      </div>

      <hr className="divider" style={{ margin: "10px -4px" }} />

      <div style={{ padding: "0 6px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
          Hardware
        </span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11.5 }}>
          <div>
            <div style={{ color: "var(--paper-400)" }}>CPU</div>
            <div style={{ color: "var(--paper-100)" }}>{hardware.cpuShort}</div>
          </div>
          <div>
            <div style={{ color: "var(--paper-400)" }}>RAM</div>
            <div style={{ color: "var(--paper-100)" }}>{hardware.ramUsed} / {hardware.ramTotal} GB</div>
          </div>
          <div>
            <div style={{ color: "var(--paper-400)" }}>GPU</div>
            <div style={{ color: "var(--paper-100)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {hardware.gpu.split(" · ")[0]}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--paper-400)" }}>Almacenamiento</div>
            <div style={{ color: "var(--paper-100)" }}>{hardware.storage.split(" · ")[0]}</div>
          </div>
        </div>
      </div>

      <hr className="divider" style={{ margin: "10px -4px 8px" }} />

      <button
        onClick={onOpenSettings}
        className="btn btn-ghost"
        style={{ width: "100%", justifyContent: "space-between" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icons.Settings /> Ir a Ajustes
        </span>
        <Icons.ChevronRight />
      </button>
    </div>
  );
};

window.Topbar = Topbar;
