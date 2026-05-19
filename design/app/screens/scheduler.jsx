// Scheduler — calendar of upcoming publications

const Scheduler = () => {
  const days = ["L", "M", "X", "J", "V", "S", "D"];
  // Mock month grid — 35 cells
  const today = 17;
  const month = Array.from({ length: 35 }, (_, i) => {
    const d = i - 3; // start from -3 to fake offset
    return { day: d > 0 && d <= 31 ? d : null, isToday: d === today };
  });

  const events = {
    18: [{ title: "Demonios bajo el Monte Kunlun", time: "18:00", color: "#e8c96d", platform: "YT" }],
    20: [{ title: "El cultivo del silencio",        time: "18:00", color: "#74c69d", platform: "YT" }],
    22: [{ title: "Cinco picos, una mente",         time: "18:00", color: "#c9a84c", platform: "YT" }],
    25: [{ title: "Crónica de los reinos rotos",    time: "12:00", color: "#52b788", platform: "YT" },
         { title: "Short: la espada flotante",      time: "20:00", color: "#9d2933", platform: "TT" }],
    27: [{ title: "El maestro de las nubes",        time: "18:00", color: "#c43c4b", platform: "YT" }],
  };

  return (
    <div className="screen-inner page-enter">
      <header style={{ marginBottom: 28, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <span className="eyebrow">Planificador</span>
          <h1 className="h-display" style={{ marginTop: 12 }}>Mayo de 2026.</h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="topbar-icon-btn"><Icons.ChevronLeft /></button>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--paper-100)", minWidth: 120, textAlign: "center" }}>
            17 – 31 mayo
          </span>
          <button className="topbar-icon-btn"><Icons.ChevronRight /></button>
          <div style={{ width: 12 }}/>
          <button className="btn btn-secondary"><Icons.Calendar />Hoy</button>
          <button className="btn btn-primary"><Icons.Plus />Programar</button>
        </div>
      </header>

      {/* Calendar grid */}
      <section style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 14,
        overflow: "hidden",
        background: "rgba(255,255,255,0.012)",
      }}>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
          borderBottom: "1px solid var(--border-subtle)",
        }}>
          {days.map((d) => (
            <div key={d} style={{
              padding: "10px 12px",
              fontSize: 10.5, color: "var(--paper-400)",
              textTransform: "uppercase", letterSpacing: "0.18em", fontWeight: 600,
            }}>{d}</div>
          ))}
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gridAutoRows: "112px",
        }}>
          {month.map((c, i) => {
            const e = c.day ? events[c.day] : null;
            return (
              <div key={i} style={{
                borderRight: (i + 1) % 7 === 0 ? "none" : "1px solid var(--border-subtle)",
                borderBottom: "1px solid var(--border-subtle)",
                padding: 8,
                opacity: c.day ? 1 : 0.3,
                background: c.isToday ? "rgba(201,168,76,0.04)" : "transparent",
                position: "relative",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <span style={{
                  fontSize: 11, fontFamily: "var(--font-mono)",
                  color: c.isToday ? "var(--gold-300)" : "var(--paper-400)",
                  fontWeight: c.isToday ? 600 : 400,
                }}>
                  {c.day || ""}
                  {c.isToday && (
                    <span style={{
                      marginLeft: 6, padding: "1px 6px",
                      background: "var(--gold-400)", color: "var(--obsidian-950)",
                      borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
                    }}>HOY</span>
                  )}
                </span>
                {e && e.map((ev, j) => (
                  <div key={j} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 6px",
                    borderRadius: 5,
                    background: `${ev.color}1a`,
                    borderLeft: `2px solid ${ev.color}`,
                    fontSize: 10.5, color: "var(--paper-100)",
                    lineHeight: 1.25,
                    cursor: "pointer",
                    transition: "background 120ms",
                  }}
                    onMouseEnter={(t) => t.currentTarget.style.background = `${ev.color}33`}
                    onMouseLeave={(t) => t.currentTarget.style.background = `${ev.color}1a`}
                  >
                    <span style={{
                      fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--paper-300)",
                      flexShrink: 0,
                    }}>{ev.time}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.title}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <div>
          <h2 className="h-section-label" style={{ marginBottom: 14 }}>Próximas 7</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {[
              { d: 18, t: "Mañana · 18:00", title: "Demonios bajo el Monte Kunlun", ch: "Crónicas de Jade", tone: "gold" },
              { d: 20, t: "Mié · 18:00", title: "El cultivo del silencio", ch: "Crónicas de Jade", tone: "jade" },
              { d: 22, t: "Vie · 18:00", title: "Cinco picos, una mente", ch: "Crónicas de Jade", tone: "gold" },
            ].map((r, i) => (
              <button key={i} style={{
                display: "grid", gridTemplateColumns: "44px 1fr auto",
                gap: 14, alignItems: "center",
                padding: "12px 12px",
                borderRadius: 10,
                background: "transparent",
                textAlign: "left",
                transition: "background 140ms",
              }}
                onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.025)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 8,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  background: r.tone === "gold" ? "rgba(201,168,76,0.08)" : "rgba(82,183,136,0.08)",
                  border: `1px solid ${r.tone === "gold" ? "rgba(201,168,76,0.25)" : "rgba(82,183,136,0.25)"}`,
                }}>
                  <span style={{ fontSize: 9, color: r.tone === "gold" ? "var(--gold-300)" : "var(--jade-300)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
                    MAY
                  </span>
                  <span style={{ fontSize: 17, color: "var(--paper-50)", fontWeight: 600, fontFamily: "var(--font-display)", lineHeight: 1 }}>
                    {r.d}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500 }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--paper-400)", display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                    <Icons.YouTube style={{ width: 11, height: 11 }}/>
                    {r.ch} · {r.t}
                  </div>
                </div>
                <Icons.ChevronRight style={{ width: 14, height: 14, color: "var(--paper-400)" }} />
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="h-section-label" style={{ marginBottom: 14 }}>Cadencia del canal</h2>
          <div style={{
            padding: 18,
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            display: "flex", flexDirection: "column", gap: 14,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 12.5, color: "var(--paper-300)" }}>Vídeos esta semana</span>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--paper-50)" }}>3 / 5</span>
            </div>
            <div style={{ height: 4, borderRadius: 999, background: "rgba(255,255,255,0.05)" }}>
              <div style={{ height: "100%", width: "60%", background: "linear-gradient(90deg, var(--gold-400), var(--jade-400))", borderRadius: 999 }}/>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--paper-400)", lineHeight: 1.5 }}>
              Mantén una publicación cada 48 h para maximizar el alcance del algoritmo. Tienes
              <span style={{ color: "var(--gold-200)" }}> 2 huecos </span>
              esta semana.
            </div>
            <button className="btn btn-secondary" style={{ width: "100%" }}>
              <Icons.Sparkles /> Sugerir cuándo publicar
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

window.Scheduler = Scheduler;
