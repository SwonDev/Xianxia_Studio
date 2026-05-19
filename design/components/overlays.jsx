/* eslint-disable */
// Global overlays: Toast, Shortcuts (⇧?), Glossary tooltip, A/B compare.

/* ─── TOAST SYSTEM ──────────────────────────────────────────── */
const ToastContext = React.createContext({ push: () => {} });

function ToastHost({ children }) {
  const [toasts, setToasts] = React.useState([]);
  const push = React.useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((arr) => [...arr, { id, ...t }]);
    setTimeout(() => setToasts((arr) => arr.filter(x => x.id !== id)), t.duration ?? 5500);
  }, []);
  React.useEffect(() => { window.__toastPush = push; }, [push]);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}>
        {toasts.map((t) => <Toast key={t.id} {...t} onClose={() => setToasts(a => a.filter(x => x.id !== t.id))}/>)}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ kind = "success", title, body, action, onClose }) {
  const tint = kind === "success" ? "#2eb189" : kind === "error" ? "#c8525e" : kind === "warning" ? "#d4b85a" : "#7a8a8a";
  const Icon = kind === "success" ? I.Check : kind === "error" ? I.X : kind === "warning" ? I.Warning : I.Info;
  return (
    <div style={{
      width: 340,
      padding: "12px 14px",
      background: "rgba(40,40,46,0.55)",
      backdropFilter: "blur(60px) saturate(190%)",
      WebkitBackdropFilter: "blur(60px) saturate(190%)",
      borderRadius: 12,
      boxShadow: "0 24px 60px -12px rgba(0,0,0,0.75), 0 0 0 0.5px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.22)",
      display: "flex", alignItems: "flex-start", gap: 12,
      pointerEvents: "auto",
      animation: "toast-in 320ms var(--ease-spring) both",
    }}>
      <span className="lg-tile sm" style={{ "--tint": tint, width: 22, height: 22 }}>
        <Icon size={11}/>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        {body && <div className="caption" style={{ marginTop: 2, fontSize: 11.5 }}>{body}</div>}
      </div>
      {action && <button className="btn-ghost" style={{ marginTop: -2 }} onClick={() => { action.onClick(); onClose(); }}>{action.label}</button>}
      <button className="btn-ghost" style={{ marginTop: -2, padding: "0 4px", height: 20 }} onClick={onClose}>
        <I.X size={10}/>
      </button>
    </div>
  );
}

function useToast() { return React.useContext(ToastContext); }

/* ─── SHORTCUTS OVERLAY (Shift + ?) ─────────────────────────── */
function ShortcutsOverlay({ open, onClose }) {
  if (!open) return null;
  const groups = [
    { label: "Navegación", items: [
      ["⌘1", "Resumen"], ["⌘2", "Generador"], ["⌘3", "Shorts"],
      ["⌘4", "Biblioteca"], ["⌘5", "Planificador"], ["⌘,", "Ajustes"],
    ]},
    { label: "Acciones", items: [
      ["⌘N", "Nuevo vídeo"], ["⌘S", "Smart Shorts"], ["⌘P", "Programar"],
      ["⌘K", "Paleta de comandos"], ["⌘.", "Cancelar generación"],
      ["⇧⌘V", "Clonar voz"],
    ]},
    { label: "Vista", items: [
      ["⌘B", "Mostrar/ocultar sidebar"], ["⌘+", "Aumentar densidad"],
      ["⌘-", "Reducir densidad"], ["?", "Esta pantalla"],
    ]},
  ];
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 130,
      background: "rgba(6,18,14,0.55)",
      backdropFilter: "blur(10px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "fade-up 240ms var(--ease-spring) both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 640,
        padding: 24,
        background: "rgba(40,40,46,0.55)",
        backdropFilter: "blur(60px) saturate(190%)",
        WebkitBackdropFilter: "blur(60px) saturate(190%)",
        borderRadius: 16,
        boxShadow: "var(--shadow-popover)",
      }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
          <h2 className="title-l" style={{ margin: 0 }}>Atajos de teclado</h2>
          <button className="btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            <I.X size={12}/>
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {groups.map((g) => (
            <div key={g.label}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>{g.label}</div>
              {g.items.map(([keys, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", padding: "5px 0", fontSize: 12 }}>
                  <span style={{ flex: 1, color: "var(--text-secondary)" }}>{label}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--accent-soft)" }}>{keys}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── GLOSSARY TOOLTIP ──────────────────────────────────────── */
const GLOSSARY = {
  "Whisper": "Modelo open-source de OpenAI que transcribe audio a texto con timestamps por palabra. Versión large-v3 multilingüe.",
  "TRIBE v2": "Modelo fMRI de Meta que predice valles de atención en vídeos a partir de la señal neural. Se usa para detectar segmentos aburridos.",
  "Z-Image-Turbo": "Modelo generador de imágenes optimizado para escenas cinemáticas. Variante Turbo: 4 pasos de difusión.",
  "Qwen3-TTS": "TTS multilingüe de Alibaba con clonado de voz a partir de 5 segundos de audio.",
  "HyperFrames": "Motor de renderizado HTML/CSS/GSAP con parallax 2.5D y partículas atmosféricas.",
  "Gemma 4": "LLM de Google de 4-8B parámetros. Variante abliterated (sin filtros) recomendada para narrativa.",
  "Abliterated": "Técnica que neutraliza las direcciones de rechazo del modelo, eliminando el self-censoring sin perder capacidad.",
  "GGUF": "Formato cuantizado para correr LLMs en CPU/GPU consumer. Q5_K_M = compresión con mínima pérdida.",
  "MusicGen": "Generador de música basado en transformer, de Meta.",
  "DepthFlow": "Pipeline que añade efecto parallax 2.5D a imágenes 2D estáticas.",
  "ASS": "Formato de subtítulos con animación palabra a palabra.",
};

function Glossary({ term, children }) {
  const [open, setOpen] = React.useState(false);
  const def = GLOSSARY[term];
  if (!def) return <>{children}</>;
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{
          borderBottom: "1px dotted var(--accent-soft)",
          cursor: "help",
        }}
      >{children}</span>
      {open && (
        <span style={{
          position: "absolute",
          bottom: "calc(100% + 6px)",
          left: 0,
          width: 280,
          padding: "10px 12px",
          background: "rgba(40,40,46,0.92)",
          backdropFilter: "blur(40px) saturate(190%)",
          WebkitBackdropFilter: "blur(40px) saturate(190%)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.10), inset 0 0.5px 0 rgba(255,255,255,0.15)",
          fontSize: 12, lineHeight: 1.45,
          color: "var(--text-primary)",
          zIndex: 60,
          fontWeight: 400,
          letterSpacing: 0,
          textTransform: "none",
          animation: "fade-up 180ms var(--ease-spring) both",
        }}>
          <div className="eyebrow" style={{ marginBottom: 4, color: "var(--accent-soft)" }}>{term}</div>
          {def}
        </span>
      )}
    </span>
  );
}

/* ─── A/B COMPARE ─────────────────────────────────────────────── */
function ABCompare({ open, onClose, kind = "thumbnail" }) {
  const [chosen, setChosen] = React.useState(0);
  if (!open) return null;
  const items = kind === "thumbnail"
    ? [
        { title: "Cinemático", hue: 200, label: "Picos de jade + luna" },
        { title: "Heroico",    hue: 25,  label: "Espadachín en bruma" },
        { title: "Místico",    hue: 280, label: "Talismán flotante" },
      ]
    : [
        { title: "Directo", text: "La leyenda del Emperador de Jade · explicada en 12 minutos" },
        { title: "Hook fuerte", text: "Por qué este emperador chino aterrorizó a los dioses durante 4000 años" },
        { title: "Misterio", text: "El secreto del Emperador de Jade que la dinastía Han enterró" },
      ];

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 110,
      background: "rgba(6,18,14,0.55)",
      backdropFilter: "blur(10px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "fade-up 240ms var(--ease-spring) both",
      padding: 32,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 880, maxWidth: "100%",
        padding: 24,
        background: "rgba(40,40,46,0.55)",
        backdropFilter: "blur(60px) saturate(190%)",
        WebkitBackdropFilter: "blur(60px) saturate(190%)",
        borderRadius: 18,
        boxShadow: "var(--shadow-popover)",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 18 }}>
          <h2 className="title-l" style={{ margin: 0 }}>Compara variantes</h2>
          <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>{kind === "thumbnail" ? "Thumbnail" : "Título"}</span>
          <button className="btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose}><I.X size={12}/></button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {items.map((it, i) => {
            const active = chosen === i;
            return (
              <button
                key={i}
                onClick={() => setChosen(i)}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  background: active ? "rgba(46,177,137,0.10)" : "rgba(255,255,255,0.04)",
                  boxShadow: active
                    ? "0 0 0 1.5px rgba(94,216,166,0.55), inset 0 1px 0 rgba(255,255,255,0.10)"
                    : "0 0 0 0.5px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)",
                  transition: "all 220ms var(--ease-spring)",
                  textAlign: "left",
                }}
              >
                {kind === "thumbnail" ? (
                  <div style={{
                    aspectRatio: "16/9",
                    borderRadius: 8,
                    background: `linear-gradient(135deg, hsl(${it.hue},38%,22%), hsl(${it.hue+20},28%,10%))`,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                    marginBottom: 10,
                    position: "relative",
                    overflow: "hidden",
                  }}>
                    <div style={{
                      position: "absolute", inset: 0,
                      backgroundImage: `radial-gradient(at 70% 30%, hsl(${it.hue}, 50%, 55%, 0.25), transparent 55%), radial-gradient(at 30% 80%, hsl(${it.hue+40}, 40%, 30%, 0.30), transparent 60%)`,
                    }}/>
                  </div>
                ) : (
                  <div style={{
                    minHeight: 80,
                    fontFamily: "var(--font-display)",
                    fontSize: 17, lineHeight: 1.25,
                    fontWeight: 500,
                    color: "var(--text-primary)",
                    padding: "10px 4px",
                  }}>{it.text}</div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div className="lg-radio" style={{ width: 14, height: 14 }} aria-pressed={active}>
                    {active && <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: "radial-gradient(ellipse at 30% 26%, rgba(255,255,255,0.95), rgba(255,255,255,0) 38%), radial-gradient(circle at 60% 70%, rgba(94, 216, 166, 0.85), rgba(46, 177, 137, 0) 65%), linear-gradient(165deg, #f3fff8 0%, #94c5ab 60%, #2eb189 100%)", boxShadow: "0 0 12px -2px rgba(94, 216, 166, 0.75)" }}/>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{it.title}</div>
                    {it.label && <div className="caption" style={{ fontSize: 10.5 }}>{it.label}</div>}
                  </div>
                  <span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
                    <I.Eye size={10} style={{ marginRight: 3, verticalAlign: -1 }}/>
                    {[58, 73, 64][i]}%
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div style={{
          marginTop: 20,
          padding: "12px 16px",
          background: "rgba(0,0,0,0.20)",
          borderRadius: 10,
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <I.Brain size={16} style={{ color: "var(--accent-soft)" }}/>
          <div style={{ flex: 1, fontSize: 12 }}>
            <strong style={{ color: "var(--accent-soft)" }}>Predicción del modelo:</strong> la variante <strong>"Hook fuerte"</strong> tiene 73% probabilidad de ganar el CTR-test basado en tu nicho.
          </div>
          <button className="btn-primary" onClick={onClose}>Usar variante {chosen + 1}</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ToastHost, useToast, ShortcutsOverlay, Glossary, ABCompare });
