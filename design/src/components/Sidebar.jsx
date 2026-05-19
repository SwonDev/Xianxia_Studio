/* eslint-disable */
// Sidebar — source-list with animated active indicator
const { useState, useEffect, useRef, useLayoutEffect } = React;

function Sidebar({ route, onNavigate, generating }) {
  const groups = [
    {
      label: "Resumen",
      items: [
        { id: "dashboard", icon: "Dashboard", primary: "Dashboard", sub: "Estado general" },
      ],
    },
    {
      label: "Producir",
      items: [
        { id: "generator", icon: "Sparkles", primary: "Generador", sub: "Vídeo desde un tema" },
        { id: "shorts", icon: "Scissors", primary: "Smart Shorts", sub: "Extraer Shorts de MP4" },
      ],
    },
    {
      label: "Gestionar",
      items: [
        { id: "library", icon: "Library", primary: "Biblioteca", sub: "Vídeos producidos" },
        { id: "scheduler", icon: "Calendar", primary: "Planificador", sub: "Programación YouTube" },
      ],
    },
    {
      label: "Sistema",
      items: [
        { id: "installer", icon: "Download", primary: "Instalador", sub: "Modelos y runtime" },
        { id: "settings", icon: "Settings", primary: "Ajustes", sub: "Configuración" },
      ],
    },
  ];

  const navRef = useRef(null);
  const [indicator, setIndicator] = useState({ top: 0, opacity: 0 });

  useLayoutEffect(() => {
    if (!navRef.current) return;
    const el = navRef.current.querySelector(`[data-nav-id="${route}"]`);
    if (!el) {
      setIndicator((s) => ({ ...s, opacity: 0 }));
      return;
    }
    const navRect = navRef.current.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setIndicator({ top: elRect.top - navRect.top, opacity: 1 });
  }, [route]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo" aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 19c5-3 7-8 8-15M20 19c-5-3-7-8-8-15M4 19h16"
              stroke="#0a0a0f"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="brand-text">
          <span className="brand-name">Xianxia Studio</span>
          <span className="brand-version">v0.1.41 · local</span>
        </div>
      </div>

      <nav className="nav" ref={navRef}>
        <div
          className="nav-indicator"
          style={{
            transform: `translateY(${indicator.top}px)`,
            opacity: indicator.opacity,
          }}
        />
        {groups.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-label">{g.label}</div>
            <div className="nav-list">
              {g.items.map((it) => {
                const Ico = window.Icon[it.icon];
                const isActive = route === it.id;
                const showPulse = it.id === "generator" && generating;
                return (
                  <button
                    key={it.id}
                    data-nav-id={it.id}
                    className="nav-item"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onNavigate(it.id)}
                  >
                    <span className="nav-icon"><Ico size={17} /></span>
                    <span className="nav-text">
                      <span className="nav-text-primary">{it.primary}</span>
                      <span className="nav-text-sub">{it.sub}</span>
                    </span>
                    {showPulse && <span className="nav-pulse" aria-label="generando" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="sidebar-foot-row">
          <span className="dot dot-jade" />
          <span>Procesamiento 100% local</span>
        </div>
        <div className="sidebar-foot-row">
          <span className="kbd">?</span>
          <span>para ver atajos</span>
        </div>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
