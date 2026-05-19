/* eslint-disable */
// App — router shell, command palette, fake pipeline driver, tweaks wiring.

const SCREEN_LABELS = {
  dashboard: "Dashboard",
  generator: "Generador",
  shorts: "Smart Shorts",
  library: "Biblioteca",
  scheduler: "Planificador",
  install: "Instalador",
  settings: "Ajustes",
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "sidebarMode": "full",
  "ambientPipeline": "running"
}/*EDITMODE-END*/;

function App() {
  const [active, setActive] = React.useState("dashboard");
  const [systemOpen, setSystemOpen] = React.useState(false);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [voiceCloneOpen, setVoiceCloneOpen] = React.useState(false);
  const [abCompareOpen, setAbCompareOpen] = React.useState(false);
  const [onboardingOpen, setOnboardingOpen] = React.useState(false);

  const [t, setT] = useTweaks(TWEAK_DEFAULTS);
  const rail = t.sidebarMode === "rail";

  // Fake pipeline driver — slowly walks through the 10 phases
  const [pipeline, setPipeline] = React.useState({
    running: t.ambientPipeline === "running",
    phase: 4,
    subProgress: 35,
    elapsed: 142,
    tokens: 1240,
    tps: 38,
    imageCount: 2,
    message: "Componiendo el arco emocional del segundo acto…",
  });

  React.useEffect(() => {
    setPipeline(p => ({ ...p, running: t.ambientPipeline === "running" }));
  }, [t.ambientPipeline]);

  React.useEffect(() => {
    if (!pipeline.running) return;
    const id = setInterval(() => {
      setPipeline(p => {
        let sp = p.subProgress + 2 + Math.random() * 3;
        let ph = p.phase;
        let ic = p.imageCount;
        let msg = p.message;
        if (sp >= 100) {
          sp = 0;
          ph = ph + 1;
          if (ph > 10) ph = 1;
          msg = phaseMessages[ph - 1];
          ic = 0;
        }
        if (ph === 4) ic = Math.min(4, Math.floor(sp / 25));
        const tokens = p.tokens + Math.floor(Math.random() * 18);
        const tps = 32 + Math.floor(Math.random() * 14);
        return { ...p, subProgress: sp, phase: ph, imageCount: ic, message: msg, elapsed: p.elapsed + 1, tokens, tps };
      });
    }, 1100);
    return () => clearInterval(id);
  }, [pipeline.running]);

  // Cmd-K + shortcuts overlay + nav shortcuts
  React.useEffect(() => {
    function onKey(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "k") { e.preventDefault(); setCmdOpen(o => !o); return; }
      if (meta && e.key === "n") { e.preventDefault(); setActive("generator"); return; }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) { e.preventDefault(); setShortcutsOpen(o => !o); return; }
      if (e.key === "Escape") { setCmdOpen(false); setSystemOpen(false); setShortcutsOpen(false); setVoiceCloneOpen(false); setAbCompareOpen(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Globals so other components can trigger modals
  React.useEffect(() => {
    window.__openVoiceClone = () => setVoiceCloneOpen(true);
    window.__openAbCompare = () => setAbCompareOpen(true);
    window.__openOnboarding = () => setOnboardingOpen(true);
    window.__previewScene = () => {
      window.__toastPush?.({
        kind: "info",
        title: "Generando vista previa de 30s",
        body: "Te avisamos cuando esté lista — puedes seguir trabajando.",
      });
    };
  }, []);

  const screenProps = { onNavigate: setActive, pipeline, density: t.density,
    onStart: () => setPipeline(p => ({ ...p, running: true, phase: 1, subProgress: 0, elapsed: 0, imageCount: 0, tokens: 0 })),
    onStop: () => setPipeline(p => ({ ...p, running: false })),
  };

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      background: "var(--bg-base)",
      overflow: "hidden",
      position: "relative",
    }}>
      <Sidebar active={active} onNavigate={setActive} rail={rail} pipeline={pipeline} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative", zIndex: 1 }}>
        <Topbar
          active={active}
          breadcrumb={SCREEN_LABELS[active]}
          systemRunning={pipeline.running}
          onSystemClick={() => setSystemOpen(o => !o)}
          onCmdK={() => setCmdOpen(true)}
        />

        <SystemPopover
          open={systemOpen}
          onClose={() => setSystemOpen(false)}
          pulse={pipeline.running}
          services={SERVICES_DEMO}
          hardware={HW_DEMO}
        />

        <main style={{ flex: 1, overflowY: "auto", position: "relative" }} key={active}>
          {active === "dashboard" && <Dashboard {...screenProps} />}
          {active === "generator" && <Generator {...screenProps} />}
          {active === "shorts" && <Shorts {...screenProps} />}
          {active === "library" && <Library {...screenProps} />}
          {active === "scheduler" && <Scheduler {...screenProps} />}
          {active === "settings" && <Settings {...screenProps} />}
          {active === "install" && <Install {...screenProps} />}
        </main>
      </div>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} onNavigate={setActive} openShortcuts={() => setShortcutsOpen(true)} openVoiceClone={() => setVoiceCloneOpen(true)} openAbCompare={() => setAbCompareOpen(true)} openOnboarding={() => setOnboardingOpen(true)}/>

      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)}/>
      <VoiceCloneWizard open={voiceCloneOpen} onClose={() => setVoiceCloneOpen(false)}/>
      <ABCompare open={abCompareOpen} onClose={() => setAbCompareOpen(false)} kind="title"/>
      <Onboarding open={onboardingOpen} onComplete={() => setOnboardingOpen(false)}/>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Diseño">
          <TweakRadio
            label="Barra lateral"
            value={t.sidebarMode}
            options={[{ value: "full", label: "Completa" }, { value: "rail", label: "Solo iconos" }]}
            onChange={(v) => setT("sidebarMode", v)}
          />
        </TweakSection>
        <TweakSection label="Estado">
          <TweakRadio
            label="Pipeline"
            value={t.ambientPipeline}
            options={[{ value: "running", label: "Generando" }, { value: "idle", label: "En reposo" }]}
            onChange={(v) => setT("ambientPipeline", v)}
          />
        </TweakSection>
        <TweakSection label="Overlays">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: "0 4px" }}>
            <button className="btn" onClick={() => setOnboardingOpen(true)} style={{ fontSize: 11 }}>Onboarding</button>
            <button className="btn" onClick={() => setVoiceCloneOpen(true)} style={{ fontSize: 11 }}>Clonar voz</button>
            <button className="btn" onClick={() => setAbCompareOpen(true)} style={{ fontSize: 11 }}>A/B compare</button>
            <button className="btn" onClick={() => setShortcutsOpen(true)} style={{ fontSize: 11 }}>Atajos ⇧?</button>
          </div>
        </TweakSection>
        <TweakSection label="Pantalla">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: "0 4px" }}>
            {Object.entries(SCREEN_LABELS).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setActive(k)}
                style={{
                  padding: "6px 8px", fontSize: 11,
                  borderRadius: 5,
                  background: active === k ? "rgba(46,177,137,0.18)" : "rgba(255,255,255,0.04)",
                  color: active === k ? "var(--accent-soft)" : "var(--text-secondary)",
                  border: "1px solid " + (active === k ? "rgba(94,216,166,0.35)" : "transparent"),
                  textAlign: "center",
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

// Adapter for tweaks_panel — the starter component exports TweakRadio etc via window
const TweakKind = {};

const phaseMessages = [
  "Generando guión con Gemma 4 abliterated…",
  "Optimizando metadatos para SEO de YouTube…",
  "Sintetizando narración con Qwen3-TTS…",
  "Generando imágenes cinematográficas con Z-Image-Turbo…",
  "Componiendo banda sonora desde la biblioteca…",
  "Renderizando vídeo con HyperFrames · parallax 2.5D…",
  "Generando thumbnail bilingüe…",
  "Transcribiendo y quemando subtítulos…",
  "Subiendo a YouTube…",
  "Programando publicación y extrayendo Shorts…",
];

const SERVICES_DEMO = [
  { id: "llamacpp", label: "llama.cpp", state: "running", hint: "LLM · Gemma 4 E4B Q5" },
  { id: "python", label: "Python sidecar", state: "running", hint: "TTS · Whisper · Engagement" },
  { id: "node", label: "Node sidecar", state: "running", hint: "HyperFrames · GSAP renderer" },
  { id: "comfyui", label: "ComfyUI", state: "running", hint: "Z-Image-Turbo" },
];
const HW_DEMO = {
  cpu: "i9-13900K · 24c",
  gpu: "RTX 4080 · 16 GB",
  ramUsed: 11.3, ramTotal: 32,
  disk: "412",
};

/* ── Command palette ────────────────────────────────────────────── */
function CommandPalette({ open, onClose, onNavigate, openShortcuts, openVoiceClone, openAbCompare, openOnboarding }) {
  const [q, setQ] = React.useState("");
  const inputRef = React.useRef(null);
  React.useEffect(() => {
    if (open) { setQ(""); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  if (!open) return null;
  const items = [
    { id: "generator", icon: "Sparkles", label: "Nuevo vídeo", sub: "Empezar generación desde un tema", action: () => onNavigate("generator") },
    { id: "shorts", icon: "Scissors", label: "Smart Shorts", sub: "Extraer clips de un MP4 existente", action: () => onNavigate("shorts") },
    { id: "library", icon: "Library", label: "Abrir biblioteca", sub: "Ver vídeos producidos", action: () => onNavigate("library") },
    { id: "scheduler", icon: "Calendar", label: "Planificador", sub: "Cola de YouTube", action: () => onNavigate("scheduler") },
    { id: "settings", icon: "Settings", label: "Ajustes", sub: "Servicios, modelos, hardware", action: () => onNavigate("settings") },
    { id: "voice", icon: "Mic", label: "Clonar mi voz", sub: "Asistente · 5 segundos de audio", action: () => openVoiceClone?.() },
    { id: "ab", icon: "Layout", label: "Comparar variantes (A/B)", sub: "Thumbnails y títulos lado a lado", action: () => openAbCompare?.() },
    { id: "shortcuts", icon: "CommandKey", label: "Atajos de teclado", sub: "Ver toda la lista", action: () => openShortcuts?.() },
    { id: "onboarding", icon: "Help", label: "Volver a ver el onboarding", sub: "Tour de bienvenida", action: () => openOnboarding?.() },
  ];
  const filtered = items.filter(i => (i.label + " " + i.sub).toLowerCase().includes(q.toLowerCase()));

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "rgba(10, 10, 15, 0.55)",
      backdropFilter: "blur(8px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      paddingTop: "12vh",
      animation: "fade-up 200ms var(--ease-cinematic) both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 560,
        background: "rgba(40, 40, 46, 0.55)",
        backdropFilter: "blur(60px) saturate(190%)",
        WebkitBackdropFilter: "blur(60px) saturate(190%)",
        borderRadius: 16,
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <I.Search size={16} style={{ color: "var(--text-muted)" }}/>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar comando, proyecto, ajuste…"
            style={{
              flex: 1, background: "transparent", border: 0, outline: 0,
              fontSize: 16, fontFamily: "var(--font-display)", letterSpacing: "-0.005em",
              color: "var(--text-primary)",
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto", padding: "6px" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Sin resultados para "{q}"
            </div>
          )}
          {filtered.map((it) => {
            const Icon = I[it.icon];
            return (
              <button
                key={it.id}
                onClick={() => { it.action(); onClose(); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 8,
                  textAlign: "left",
                  transition: "background 100ms",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid var(--hairline)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--gold-400)",
                }}>
                  <Icon size={14}/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{it.sub}</div>
                </div>
                <I.Chevron size={11} style={{ color: "var(--text-faint)" }}/>
              </button>
            );
          })}
        </div>
        <div style={{
          padding: "8px 14px", borderTop: "1px solid var(--hairline)",
          display: "flex", alignItems: "center", gap: 14,
          fontSize: 11, color: "var(--text-muted)",
        }}>
          <span><span className="kbd" style={{ marginRight: 4 }}>↑</span><span className="kbd" style={{ marginRight: 4 }}>↓</span> navegar</span>
          <span><span className="kbd" style={{ marginRight: 4 }}>↵</span> abrir</span>
          <span style={{ marginLeft: "auto" }}>Xianxia Studio</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { App, CommandPalette });
