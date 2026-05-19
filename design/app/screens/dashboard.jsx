// Dashboard — overview with strong hierarchy, no nested boxes

const Dashboard = ({ onNav, pipeline }) => {
  const projects = MockData.projects;
  const ready = projects.filter((p) => p.status === "ready").length;
  const published = projects.filter((p) => p.status === "published").length;
  const scheduled = projects.filter((p) => p.status === "scheduled").length;
  const rendering = projects.filter((p) => p.status === "rendering").length;

  const lastWeek = [
    { day: "L", v: 12 }, { day: "M", v: 18 }, { day: "X", v: 9 },
    { day: "J", v: 24 }, { day: "V", v: 21 }, { day: "S", v: 31 }, { day: "D", v: 14 },
  ];

  return (
    <div className="screen-inner page-enter">

      {/* HERO — Mac-style big title, breathing room */}
      <header style={{ marginBottom: 56 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span className="eyebrow">Estudio</span>
          <span style={{ height: 1, width: 24, background: "rgba(201,168,76,0.4)" }} />
          <span style={{ fontSize: 11.5, color: "var(--paper-400)" }}>Viernes, 17 de mayo · 14:08</span>
        </div>
        <h1 className="h-display" style={{ marginBottom: 14 }}>
          Bienvenido de vuelta, Swon.{" "}
          <span className="em">Hoy es buen día para crear.</span>
        </h1>
        <p className="lede">
          Tu estudio está listo. {rendering > 0 ? `Hay ${rendering} vídeo renderizándose en segundo plano.` : "Sin trabajos en cola."}
          {" "}Cuando quieras empezar uno nuevo, basta con un tema.
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
          <button className="btn btn-primary btn-lg" onClick={() => onNav("generator")}>
            <Icons.Sparkles />
            Generar vídeo
            <span className="kbd" style={{ marginLeft: 6, fontSize: 10, background: "rgba(0,0,0,0.15)", borderColor: "rgba(0,0,0,0.18)", color: "rgba(10,10,15,0.65)" }}>⌘N</span>
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => onNav("shorts")}>
            <Icons.Scissors />
            Extraer Shorts
          </button>
          <button className="btn btn-ghost btn-lg" onClick={() => onNav("library")}>
            Abrir biblioteca
            <Icons.ChevronRight />
          </button>
        </div>
      </header>

      {/* KPI Strip — flat, no boxes-in-boxes */}
      <section className="stagger" style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 0,
        marginBottom: 56,
        borderTop: "1px solid var(--border-subtle)",
        borderBottom: "1px solid var(--border-subtle)",
      }}>
        <KPI label="Listos" value={ready} hint="por publicar" tone="gold" icon="Layers" />
        <KPI label="En cola" value={scheduled} hint="programados" tone="jade" icon="Calendar" />
        <KPI label="Publicados" value={published} hint="este mes" tone="neutral" icon="YouTube" />
        <KPI label="Tiempo ahorrado" value="42" suffix="h" hint="vs producción manual" tone="neutral" icon="Clock" last />
      </section>

      {/* Two-column body */}
      <section style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 32,
        marginBottom: 56,
      }}>
        {/* Activity */}
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h2 className="h-section-label">Actividad reciente</h2>
            <button className="btn btn-ghost" style={{ height: 24, padding: "0 8px", fontSize: 11.5 }} onClick={() => onNav("library")}>
              ver todo <Icons.ChevronRight />
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {projects.slice(0, 4).map((p) => (
              <ActivityRow key={p.id} project={p} onClick={() => onNav("library")} />
            ))}
          </div>
        </div>

        {/* Right column: This week + Next up */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div>
            <h2 className="h-section-label" style={{ marginBottom: 16 }}>Esta semana</h2>
            <div style={{
              display: "flex", alignItems: "flex-end", gap: 8,
              height: 88, padding: "0 0 8px",
            }}>
              {lastWeek.map((d, i) => (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{
                    width: "100%",
                    height: `${(d.v / 31) * 64}px`,
                    background: i === 5
                      ? "linear-gradient(180deg, var(--gold-400), rgba(201,168,76,0.2))"
                      : "linear-gradient(180deg, rgba(201,168,76,0.55), rgba(201,168,76,0.12))",
                    borderRadius: 3,
                    boxShadow: i === 5 ? "0 0 12px rgba(201,168,76,0.4)" : "none",
                    transition: "height 700ms var(--ease-mac)",
                  }}/>
                  <span style={{ fontSize: 10, color: i === 5 ? "var(--gold-300)" : "var(--paper-400)", fontWeight: i === 5 ? 600 : 400, fontFamily: "var(--font-mono)" }}>{d.day}</span>
                </div>
              ))}
            </div>
            <div style={{
              display: "flex", alignItems: "baseline", gap: 8,
              borderTop: "1px solid var(--border-subtle)", paddingTop: 12,
            }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--paper-50)", fontWeight: 500 }}>129</span>
              <span style={{ fontSize: 12, color: "var(--paper-400)" }}>minutos generados</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--jade-400)" }}>+38% vs sem. ant.</span>
            </div>
          </div>

          <div>
            <h2 className="h-section-label" style={{ marginBottom: 16 }}>Próxima publicación</h2>
            <NextUp item={MockData.scheduledQueue[0]} onClick={() => onNav("scheduler")} />
          </div>
        </div>
      </section>

      {/* Tip / pull-quote */}
      <section style={{
        borderLeft: "2px solid rgba(201,168,76,0.4)",
        paddingLeft: 24,
        paddingTop: 8, paddingBottom: 8,
      }}>
        <p className="pull-quote" style={{ marginBottom: 6 }}>
          Si no sabes por dónde empezar, prueba a generar desde un mito clásico chino. Devuelve guion en 90 s.
        </p>
        <p style={{ fontSize: 12, color: "var(--paper-400)", margin: 0, paddingLeft: 4 }}>
          — Atajos de teclado: pulsa <span className="kbd">?</span> en cualquier momento
        </p>
      </section>

    </div>
  );
};

const KPI = ({ label, value, suffix, hint, tone, icon, last }) => {
  const Icon = Icons[icon];
  return (
    <div style={{
      padding: "20px 24px",
      borderRight: last ? "none" : "1px solid var(--border-subtle)",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
          {label}
        </span>
        <Icon style={{ width: 14, height: 14, color: tone === "gold" ? "var(--gold-400)" : tone === "jade" ? "var(--jade-400)" : "var(--paper-400)", opacity: 0.7 }} />
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{
          fontFamily: "var(--font-display)",
          fontSize: 40, fontWeight: 500, lineHeight: 1,
          color: tone === "gold" ? "var(--gold-300)" : "var(--paper-50)",
          letterSpacing: "-0.02em",
        }}>
          <CountUp to={typeof value === "number" ? value : parseInt(value)} />
        </span>
        {suffix && <span style={{ fontSize: 16, color: "var(--paper-400)", marginLeft: 2 }}>{suffix}</span>}
      </div>
      <span style={{ fontSize: 11.5, color: "var(--paper-400)" }}>{hint}</span>
    </div>
  );
};

const STATUS_LABELS = {
  draft:      { label: "Borrador",    tone: "neutral", icon: "Edit" },
  rendering:  { label: "Renderizando",tone: "gold",    icon: "Sparkles" },
  ready:      { label: "Listo",       tone: "jade",    icon: "Check" },
  scheduled:  { label: "Programado",  tone: "gold",    icon: "Clock" },
  published:  { label: "Publicado",   tone: "jade",    icon: "YouTube" },
  failed:     { label: "Falló",       tone: "crimson", icon: "X" },
};

const ActivityRow = ({ project, onClick }) => {
  const meta = STATUS_LABELS[project.status];
  return (
    <button
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto auto",
        gap: 16, alignItems: "center",
        padding: "12px 14px",
        borderRadius: 10,
        textAlign: "left",
        transition: "background 140ms var(--ease-std)",
        background: "transparent",
        border: "1px solid transparent",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; e.currentTarget.style.borderColor = "var(--border-subtle)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
    >
      <Thumbnail kind={project.thumb} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {project.title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--paper-400)", marginTop: 2 }}>
          {project.createdAt}
          {project.status === "rendering" && (
            <> · <span style={{ color: "var(--gold-300)" }}>{project.currentPhase}</span></>
          )}
          {project.status === "published" && project.views !== null && (
            <> · <span style={{ color: "var(--paper-200)" }}>{project.views.toLocaleString("es-ES")} vistas</span></>
          )}
          {project.status === "scheduled" && (
            <> · <span style={{ color: "var(--paper-200)" }}>{project.scheduled}</span></>
          )}
        </div>
      </div>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--paper-400)" }}>{project.duration}</span>
      <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
      <Icons.ChevronRight style={{ width: 14, height: 14, color: "var(--paper-400)", opacity: 0.6 }} />
    </button>
  );
};

const NextUp = ({ item, onClick }) => {
  if (!item) return null;
  return (
    <button onClick={onClick} style={{
      width: "100%",
      display: "flex", flexDirection: "column",
      padding: 18,
      borderRadius: 12,
      background: "linear-gradient(135deg, rgba(201,168,76,0.06), rgba(82,183,136,0.04))",
      border: "1px solid rgba(201,168,76,0.18)",
      textAlign: "left",
      transition: "border-color 200ms var(--ease-std), transform 200ms var(--ease-spring)",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(201,168,76,0.18)"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Icons.Clock style={{ width: 12, height: 12, color: "var(--gold-400)" }} />
        <span style={{ fontSize: 10.5, color: "var(--gold-300)", textTransform: "uppercase", letterSpacing: "0.16em", fontWeight: 600 }}>
          {item.when}
        </span>
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--paper-50)", marginBottom: 8, lineHeight: 1.25 }}>
        {item.title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--paper-400)" }}>
        <Icons.YouTube style={{ width: 14, height: 14, color: "var(--paper-300)" }}/>
        <span>{item.channel}</span>
        <span style={{ marginLeft: "auto" }} className="kbd">en 1 día</span>
      </div>
    </button>
  );
};

window.Dashboard = Dashboard;
