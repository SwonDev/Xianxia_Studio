// Sidebar — Mac-style source list with system widget at the bottom

const NAV = [
  {
    label: "Resumen",
    items: [
      { id: "dashboard", label: "Dashboard", icon: "Home", shortcut: "1" },
    ],
  },
  {
    label: "Producir",
    items: [
      { id: "generator", label: "Generador",    icon: "Sparkles", shortcut: "2" },
      { id: "shorts",    label: "Smart Shorts", icon: "Scissors", shortcut: "3" },
    ],
  },
  {
    label: "Gestionar",
    items: [
      { id: "library",   label: "Biblioteca",   icon: "Library",  shortcut: "4" },
      { id: "scheduler", label: "Planificador", icon: "Calendar", shortcut: "5" },
    ],
  },
  {
    label: "Sistema",
    items: [
      { id: "install",  label: "Instalador", icon: "Download", shortcut: "6" },
      { id: "settings", label: "Ajustes",    icon: "Settings", shortcut: "," },
    ],
  },
];

const Sidebar = ({ active, onNav, rail }) => {
  const { hardware } = MockData;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <BrandGlyph />
        </div>
        <div className="brand-text">
          <span className="brand-name">Xianxia Studio</span>
          <span className="brand-version mono">v0.2.4</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((it) => {
              const Icon = Icons[it.icon];
              const isActive = active === it.id;
              return (
                <button
                  key={it.id}
                  className={`nav-item${isActive ? " is-active" : ""}`}
                  onClick={() => onNav(it.id)}
                  title={it.label}
                >
                  <Icon className="nav-item-icon" />
                  <span className="nav-item-label">{it.label}</span>
                  <span className="nav-shortcut">
                    <kbd>⌘{it.shortcut}</kbd>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sys-widget">
        <SystemWidget rail={rail} />
      </div>
    </aside>
  );
};

const BrandGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {/* abstract mountain + sun mark */}
    <path d="M3 18 9 9l4 5 3-3 5 7Z" fill="currentColor" stroke="none" opacity="0.9" />
    <circle cx="17" cy="6" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const SystemWidget = ({ rail }) => {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 2400);
    return () => clearInterval(i);
  }, []);

  // Subtle live wobble around real value
  const cpu = Math.max(8, Math.min(95, MockData.hardware.cpuUsage + ((tick * 7) % 19) - 9));
  const ram = Math.max(20, Math.min(95, MockData.hardware.ramUsage + ((tick * 11) % 11) - 5));

  if (rail) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        <RingMini value={cpu} label="CPU" />
        <RingMini value={ram} label="RAM" />
      </div>
    );
  }

  return (
    <div className="sys-widget-content" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10.5, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
          Sistema
        </span>
        <span className="pill pill-jade" style={{ padding: "0px 7px", fontSize: 10 }}>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: "currentColor", boxShadow: "0 0 4px currentColor" }} />
          local
        </span>
      </div>

      <div className="sys-widget-row">
        <Icons.Cpu style={{ width: 12, height: 12, color: "var(--paper-400)" }} />
        <div className="sys-widget-bar">
          <div className={`sys-widget-bar-fill${cpu > 80 ? " is-warn" : ""}`} style={{ width: `${cpu}%` }}/>
        </div>
        <span className="sys-widget-val">{cpu}%</span>
      </div>
      <div className="sys-widget-row">
        <Icons.Memory style={{ width: 12, height: 12, color: "var(--paper-400)" }} />
        <div className="sys-widget-bar">
          <div className={`sys-widget-bar-fill${ram > 80 ? " is-warn" : ""}`} style={{ width: `${ram}%` }}/>
        </div>
        <span className="sys-widget-val">{(MockData.hardware.ramTotal * ram / 100).toFixed(1)}G</span>
      </div>
    </div>
  );
};

const RingMini = ({ value, label }) => {
  const r = 11;
  const c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  return (
    <div title={`${label} ${value}%`} style={{ position: "relative", width: 28, height: 28 }}>
      <svg viewBox="0 0 28 28" width="28" height="28">
        <circle cx="14" cy="14" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="2" fill="none" />
        <circle cx="14" cy="14" r={r} stroke="var(--gold-400)" strokeWidth="2" fill="none"
                strokeDasharray={c} strokeDashoffset={off}
                strokeLinecap="round"
                transform="rotate(-90 14 14)"
                style={{ transition: "stroke-dashoffset 600ms var(--ease-mac)" }} />
      </svg>
      <span style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 8, color: "var(--paper-300)", fontWeight: 600, letterSpacing: "0.04em",
      }}>{label}</span>
    </div>
  );
};

window.Sidebar = Sidebar;
