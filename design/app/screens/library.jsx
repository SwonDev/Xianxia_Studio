// Library — projects grid with rich empty state and filters

const Library = ({ onNav }) => {
  const [filter, setFilter] = React.useState("all");
  const [view, setView] = React.useState("grid");
  const [empty, setEmpty] = React.useState(false);
  const [query, setQuery] = React.useState("");

  let projects = MockData.projects;
  if (filter !== "all") projects = projects.filter((p) => p.status === filter);
  if (query) projects = projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));

  const counts = {
    all: MockData.projects.length,
    ready: MockData.projects.filter((p) => p.status === "ready").length,
    rendering: MockData.projects.filter((p) => p.status === "rendering").length,
    scheduled: MockData.projects.filter((p) => p.status === "scheduled").length,
    published: MockData.projects.filter((p) => p.status === "published").length,
    draft: MockData.projects.filter((p) => p.status === "draft").length,
  };

  return (
    <div className="screen-inner page-enter">

      <header style={{ marginBottom: 28, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24 }}>
        <div>
          <span className="eyebrow">Biblioteca</span>
          <h1 className="h-display" style={{ marginTop: 12 }}>
            Tu archivo cinematográfico.
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setEmpty((e) => !e)} className="btn btn-ghost" style={{ fontSize: 11.5, opacity: 0.6 }}>
            {empty ? "ver con contenido" : "ver vacío"}
          </button>
          <button className="btn btn-secondary">
            <Icons.Folder /> Abrir carpeta
          </button>
        </div>
      </header>

      {empty || (projects.length === 0 && filter === "all") ? (
        <EmptyState onCreate={() => onNav("generator")} />
      ) : (
        <>
          {/* Toolbar */}
          <section style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 14px",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            marginBottom: 20,
            position: "sticky", top: 8, zIndex: 4,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              flex: "0 0 280px",
              padding: "6px 10px",
              borderRadius: 7,
              background: "rgba(255,255,255,0.025)",
              border: "1px solid var(--border-subtle)",
            }}>
              <Icons.Search style={{ width: 13, height: 13, color: "var(--paper-400)" }} />
              <input
                placeholder="Buscar en biblioteca"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  background: "transparent", border: "none", outline: "none",
                  flex: 1, fontSize: 12.5, color: "var(--paper-100)",
                }}
              />
              <kbd className="kbd">⌘F</kbd>
            </div>

            <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 8, background: "rgba(255,255,255,0.025)", border: "1px solid var(--border-subtle)" }}>
              {[
                { v: "all", label: "Todos" },
                { v: "ready", label: "Listos" },
                { v: "rendering", label: "En curso" },
                { v: "scheduled", label: "Programados" },
                { v: "published", label: "Publicados" },
                { v: "draft", label: "Borradores" },
              ].map((f) => {
                const active = filter === f.v;
                return (
                  <button
                    key={f.v}
                    onClick={() => setFilter(f.v)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: active ? "rgba(255,255,255,0.07)" : "transparent",
                      color: active ? "var(--paper-50)" : "var(--paper-300)",
                      fontSize: 11.5,
                      fontWeight: 500,
                      boxShadow: active ? "0 1px 2px rgba(0,0,0,0.2), 0 0 0 0.5px rgba(255,255,255,0.04) inset" : "none",
                      display: "inline-flex", alignItems: "center", gap: 6,
                      transition: "all 140ms var(--ease-std)",
                    }}
                  >
                    {f.label}
                    <span style={{ fontSize: 10, color: "var(--paper-400)", fontFamily: "var(--font-mono)" }}>
                      {counts[f.v]}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ flex: 1 }} />

            <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 8, background: "rgba(255,255,255,0.025)", border: "1px solid var(--border-subtle)" }}>
              <button onClick={() => setView("grid")} className="topbar-icon-btn" style={{ background: view === "grid" ? "rgba(255,255,255,0.07)" : "transparent" }}>
                <Icons.Layers />
              </button>
              <button onClick={() => setView("list")} className="topbar-icon-btn" style={{ background: view === "list" ? "rgba(255,255,255,0.07)" : "transparent" }}>
                <Icons.Captions />
              </button>
            </div>
          </section>

          {view === "grid" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }} className="stagger">
              {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
            </div>
          ) : (
            <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
              {projects.map((p) => <ProjectRow key={p.id} project={p} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const EmptyState = ({ onCreate }) => (
  <section style={{
    padding: "72px 40px",
    border: "1px solid var(--border-subtle)",
    borderRadius: 16,
    background: "linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0.002))",
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: 48,
  }}>
    <div>
      <p className="pull-quote" style={{ marginBottom: 20 }}>
        Toda biblioteca empieza con un primer vídeo. ¿Cuál será el tuyo?
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
        <SuggestRow text="La historia del Emperador de Jade" />
        <SuggestRow text="Las nueve sectas del valle perdido" />
        <SuggestRow text="El cultivador que olvidó su nombre" />
      </div>
      <button className="btn btn-primary btn-lg" onClick={onCreate}>
        <Icons.Sparkles />
        Crear el primero
      </button>
    </div>
    <div style={{
      position: "relative",
      width: 260, height: 260,
      borderRadius: "50%",
      background: "radial-gradient(circle at 35% 35%, rgba(201,168,76,0.18), rgba(13,13,20,0) 60%), radial-gradient(circle at 70% 70%, rgba(82,183,136,0.10), rgba(13,13,20,0) 50%)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="rgba(232,232,240,0.25)" strokeWidth="0.6">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
        <path d="M9 12 L15 12 M12 9 L12 15" />
      </svg>
    </div>
  </section>
);

const SuggestRow = ({ text }) => (
  <button style={{
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--border-subtle)",
    background: "rgba(255,255,255,0.02)",
    textAlign: "left",
    fontSize: 13, color: "var(--paper-200)",
    width: "max-content", maxWidth: "100%",
    transition: "all 160ms var(--ease-std)",
  }}
    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-gold)"; e.currentTarget.style.color = "var(--gold-200)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; e.currentTarget.style.color = "var(--paper-200)"; }}
  >
    <Icons.Sparkles style={{ width: 12, height: 12, color: "var(--gold-400)" }} />
    “{text}”
    <Icons.ChevronRight style={{ width: 11, height: 11, opacity: 0.5 }} />
  </button>
);

const ProjectCard = ({ project }) => {
  const meta = STATUS_LABELS[project.status];
  return (
    <article
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 12,
        overflow: "hidden",
        background: "rgba(255,255,255,0.015)",
        cursor: "pointer",
        transition: "all 220ms var(--ease-std)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-gold)";
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 12px 24px rgba(0,0,0,0.3), 0 0 24px rgba(201,168,76,calc(0.1 * var(--glow-strength)))";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-subtle)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div style={{ position: "relative", aspectRatio: "16/9", borderBottom: "1px solid var(--border-subtle)" }}>
        <Thumbnail kind={project.thumb} size="lg" />
        <div style={{
          position: "absolute", inset: 0,
          background: `radial-gradient(120% 80% at 30% 30%, ${THUMB_PALETTE[project.thumb][0]}, ${THUMB_PALETTE[project.thumb][1]})`,
        }}>
          <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 70% 70%, rgba(255,255,255,0.10), transparent 50%), radial-gradient(circle at 30% 80%, rgba(0,0,0,0.4), transparent 60%)" }}/>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 56, color: "rgba(232,232,240,0.32)", fontStyle: "italic" }}>
            {GLYPHS[project.thumb]}
          </div>
        </div>
        <div style={{ position: "absolute", top: 10, left: 10 }}>
          <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
        </div>
        <div style={{ position: "absolute", bottom: 10, right: 10 }}>
          <Pill>
            <span className="mono">{project.duration}</span>
          </Pill>
        </div>

        {project.status === "rendering" && (
          <>
            <div style={{
              position: "absolute", inset: 0,
              background: "rgba(10,10,15,0.4)",
            }}/>
            <div style={{
              position: "absolute", left: 14, right: 14, bottom: 36,
              height: 4, borderRadius: 999,
              background: "rgba(255,255,255,0.1)",
              overflow: "hidden",
            }}>
              <div style={{
                height: "100%", width: `${project.progress * 100}%`,
                background: "linear-gradient(90deg, var(--gold-300), var(--gold-500))",
                boxShadow: "0 0 8px rgba(201,168,76,0.5)",
              }}/>
            </div>
            <div style={{
              position: "absolute", left: 14, right: 14, bottom: 12,
              fontSize: 11, color: "var(--gold-200)", display: "flex", justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
            }}>
              <span>{project.currentPhase}</span>
              <span>{Math.round(project.progress * 100)}%</span>
            </div>
          </>
        )}
      </div>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 16, color: "var(--paper-50)", lineHeight: 1.3, marginBottom: 6 }}>
          {project.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--paper-400)" }}>
          <span>{project.createdAt}</span>
          {project.status === "published" && project.views !== null && (
            <span style={{ color: "var(--jade-300)" }}>{project.views.toLocaleString("es-ES")} vistas</span>
          )}
          {project.status === "scheduled" && (
            <span style={{ color: "var(--gold-300)" }}>{project.scheduled}</span>
          )}
        </div>
      </div>
    </article>
  );
};

const ProjectRow = ({ project }) => {
  const meta = STATUS_LABELS[project.status];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto auto auto auto",
      gap: 16, alignItems: "center",
      padding: "12px 14px",
      borderBottom: "1px solid var(--border-subtle)",
      transition: "background 140ms",
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
    >
      <Thumbnail kind={project.thumb} size="sm" />
      <div>
        <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500 }}>{project.title}</div>
        <div style={{ fontSize: 11.5, color: "var(--paper-400)" }}>{project.createdAt}</div>
      </div>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--paper-300)" }}>{project.duration}</span>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--paper-300)", textTransform: "uppercase" }}>{project.lang}</span>
      <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
      <button className="topbar-icon-btn"><Icons.More /></button>
    </div>
  );
};

const THUMB_PALETTE = {
  lotus:  ["#5a3a78", "#c43c4b"],
  sword:  ["#1b4332", "#52b788"],
  monk:   ["#806829", "#e8c96d"],
  mount:  ["#1c1c26", "#3a3a48"],
  scroll: ["#2a1f0e", "#a88a3c"],
  moon:   ["#0f1a2e", "#74c69d"],
};
const GLYPHS = { lotus: "蓮", sword: "劍", monk: "僧", mount: "山", scroll: "卷", moon: "月" };

window.Library = Library;
window.STATUS_LABELS = STATUS_LABELS;
