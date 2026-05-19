/* eslint-disable */
// First-run onboarding wizard.

function Onboarding({ open, onComplete }) {
  const [step, setStep] = React.useState(0);
  if (!open) return null;

  const steps = [
    {
      title: "Bienvenido al Studio",
      subtitle: "Vamos a preparar tu equipo para producir vídeos cinematográficos completamente locales. Sin nube, sin claves, sin cuotas.",
      content: <WelcomePane/>,
      cta: "Continuar",
    },
    {
      title: "Hardware detectado",
      subtitle: "Hemos elegido los modelos óptimos para tu equipo. Puedes cambiarlos desde Ajustes en cualquier momento.",
      content: <HardwarePane/>,
      cta: "Descargar modelos",
    },
    {
      title: "Tu primer vídeo en 3 minutos",
      subtitle: "Empieza con un preset rápido (30 segundos) para probar todo el pipeline. Después podrás generar contenido largo.",
      content: <FirstVideoPane/>,
      cta: "Empezar",
    },
  ];

  const s = steps[step];
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(6,18,14,0.78)",
      backdropFilter: "blur(20px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 32,
    }}>
      <div style={{
        width: 720, maxWidth: "100%",
        background: "rgba(40,40,46,0.55)",
        backdropFilter: "blur(60px) saturate(190%)",
        WebkitBackdropFilter: "blur(60px) saturate(190%)",
        borderRadius: 20,
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
        animation: "fade-up 320ms var(--ease-spring) both",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 28px 0",
          display: "flex", alignItems: "center",
        }}>
          <I.Logo size={28}/>
          <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 600 }}>Xianxia Studio</span>
          <span className="muted" style={{ marginLeft: "auto", fontSize: 11.5 }}>
            Paso {step + 1} de {steps.length}
          </span>
        </div>

        {/* Progress dots */}
        <div style={{ padding: "12px 28px 0", display: "flex", gap: 5 }}>
          {steps.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 999,
              background: i <= step ? "var(--accent)" : "rgba(255,255,255,0.08)",
              transition: "all 360ms var(--ease-spring)",
              boxShadow: i === step ? "0 0 8px rgba(94,216,166,0.55)" : "none",
            }}/>
          ))}
        </div>

        {/* Content */}
        <div key={step} style={{
          padding: "28px 28px 20px",
          minHeight: 320,
          animation: "fade-up 280ms var(--ease-spring) both",
        }}>
          <h1 className="display" style={{
            margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: "-0.015em",
          }}>{s.title}</h1>
          <p className="muted" style={{ margin: "6px 0 24px", maxWidth: 560, lineHeight: 1.45, fontSize: 13.5 }}>
            {s.subtitle}
          </p>
          {s.content}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 24px",
          background: "rgba(0,0,0,0.18)",
          display: "flex", alignItems: "center", gap: 10,
          borderTop: "0.5px solid rgba(255,255,255,0.06)",
        }}>
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Atrás
            </button>
          )}
          <button className="btn-ghost" onClick={onComplete} style={{ marginLeft: step > 0 ? 0 : "auto", marginRight: "auto" }}>
            Saltar
          </button>
          <button
            className="btn-primary large"
            onClick={() => step < steps.length - 1 ? setStep(step + 1) : onComplete()}
          >
            {s.cta}
            <I.Chevron size={11} style={{ marginLeft: 2 }}/>
          </button>
        </div>
      </div>
    </div>
  );
}

function WelcomePane() {
  const features = [
    { icon: "Film", tint: "#5ed8a6", title: "Long-form & Shorts", sub: "30s, 5min o 30min en 16:9 o 9:16" },
    { icon: "Mic", tint: "#d4b85a", title: "Voces y clonado", sub: "9 voces multilenguaje + clona la tuya con 5s" },
    { icon: "Brain", tint: "#2eb189", title: "Engagement neural", sub: "TRIBE v2 detecta y corrige valles aburridos" },
    { icon: "Upload", tint: "#7a8a8a", title: "Subida automática", sub: "YouTube programado · sin tocar el navegador" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {features.map((f) => {
        const Icon = I[f.icon];
        return (
        <div key={f.title} style={{
          padding: "12px 14px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 10,
          display: "flex", alignItems: "center", gap: 12,
          boxShadow: "inset 0 0.5px 0 rgba(255,255,255,0.08), 0 0 0 0.5px rgba(255,255,255,0.06)",
        }}>
          <span className="lg-tile lg" style={{ "--tint": f.tint }}>
            <Icon size={15}/>
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</div>
            <div className="caption">{f.sub}</div>
          </div>
        </div>
      );})}
    </div>
  );
}

function HardwarePane() {
  return (
    <>
      <div style={{
        padding: "14px 18px",
        background: "rgba(46,177,137,0.08)",
        borderRadius: 10,
        boxShadow: "0 0 0 0.5px rgba(94,216,166,0.30), inset 0 1px 0 rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", gap: 14,
        marginBottom: 16,
      }}>
        <span className="lg-tile xl" style={{ "--tint": "#2eb189" }}>
          <I.Check size={20}/>
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Tier <span style={{ color: "var(--accent-soft)" }}>Ultra</span> detectado</div>
          <div className="caption" style={{ marginTop: 2 }}>RTX 4080 · 16 GB VRAM · 32 GB RAM — puedes correr Gemma 4 E4B y Z-Image-Turbo en paralelo</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {[
          ["Gemma 4 E4B (abliterated)", "LLM · narrativa", "5.4 GB"],
          ["Z-Image-Turbo", "Imágenes cinemáticas", "4.2 GB"],
          ["Qwen3-TTS", "Voces narrador", "2.1 GB"],
          ["faster-whisper large-v3", "Subtítulos", "1.5 GB"],
          ["Pistas musicales base", "Biblioteca cinematográfica", "1.2 GB"],
        ].map(([n, t, s], i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1fr 140px 60px",
            alignItems: "center", gap: 12,
            padding: "8px 12px",
            background: "rgba(255,255,255,0.03)",
            borderRadius: 6,
          }}>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{n}</span>
            <span className="caption">{t}</span>
            <span className="mono" style={{ textAlign: "right" }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-tertiary)", textAlign: "right" }}>
        Total: <strong style={{ color: "var(--accent-soft)" }}>~14 GB</strong> · descarga reanudable
      </div>
    </>
  );
}

function FirstVideoPane() {
  const presets = [
    { id: "demo", icon: "Sparkles", tint: "#2eb189", title: "Demo de 30s", sub: "Pipeline completo en 2-3 min · ideal para probar", duration: "30s", time: "~2 min" },
    { id: "short", icon: "Scissors", tint: "#d4b85a", title: "Short cinematográfico", sub: "Vertical 9:16 · 45s · captions virales", duration: "45s", time: "~4 min" },
    { id: "long", icon: "Film", tint: "#5ed8a6", title: "Long-form completo", sub: "12 min · monetizable · todas las fases", duration: "12 min", time: "~22 min" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {presets.map((p, i) => {
        const Icon = I[p.icon];
        return (
        <button key={p.id} style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "14px 16px",
          background: i === 0 ? "rgba(46,177,137,0.10)" : "rgba(255,255,255,0.04)",
          borderRadius: 10,
          boxShadow: i === 0
            ? "0 0 0 1px rgba(94,216,166,0.40), inset 0 1px 0 rgba(255,255,255,0.10)"
            : "0 0 0 0.5px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.05)",
          textAlign: "left",
          transition: "background 140ms",
        }}>
          <span className="lg-tile lg" style={{ "--tint": p.tint }}>
            <Icon size={15}/>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.title}{i === 0 && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--accent-soft)", padding: "1px 6px", borderRadius: 4, background: "rgba(94,216,166,0.18)" }}>RECOMENDADO</span>}</div>
            <div className="caption" style={{ marginTop: 2 }}>{p.sub}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 12 }}>{p.duration}</div>
            <div className="caption" style={{ fontSize: 10.5 }}>{p.time}</div>
          </div>
        </button>
      );})}
    </div>
  );
}

Object.assign(window, { Onboarding });
