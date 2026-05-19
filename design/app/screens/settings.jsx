// Settings — clean three-section layout with left sub-nav

const SETTINGS_SECTIONS = [
  { id: "general",   label: "General",        icon: "Sliders" },
  { id: "model",     label: "Modelo LLM",     icon: "Brain" },
  { id: "voice",     label: "Voces",          icon: "Mic" },
  { id: "imagery",   label: "Imágenes",       icon: "Image" },
  { id: "publish",   label: "Publicación",    icon: "YouTube" },
  { id: "hardware",  label: "Hardware",       icon: "Cpu" },
  { id: "advanced",  label: "Avanzado",       icon: "Settings" },
  { id: "about",     label: "Acerca de",      icon: "Shield" },
];

const Settings = () => {
  const [section, setSection] = React.useState("model");

  return (
    <div className="page-enter" style={{ display: "grid", gridTemplateColumns: "220px 1fr", height: "100%" }}>
      {/* sub-nav */}
      <aside style={{
        borderRight: "1px solid var(--border-subtle)",
        padding: "32px 16px",
        background: "rgba(0,0,0,0.15)",
      }}>
        <div className="eyebrow" style={{ marginBottom: 14, paddingLeft: 8 }}>Ajustes</div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {SETTINGS_SECTIONS.map((s) => {
            const Icon = Icons[s.icon];
            const active = section === s.id;
            return (
              <button key={s.id}
                onClick={() => setSection(s.id)}
                className={`nav-item${active ? " is-active" : ""}`}
                style={{ marginLeft: active ? 0 : 0 }}
              >
                <Icon className="nav-item-icon" />
                <span className="nav-item-label">{s.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="screen" style={{ overflowY: "auto" }}>
        <div className="screen-inner" style={{ maxWidth: 760, padding: "40px 48px 80px" }}>
          {section === "model" && <ModelSettings />}
          {section === "general" && <GeneralSettings />}
          {section === "voice" && <VoiceSettings />}
          {section === "hardware" && <HardwareSettings />}
          {section === "publish" && <PublishSettings />}
          {section === "imagery" && <PlaceholderSection title="Imágenes" />}
          {section === "advanced" && <PlaceholderSection title="Avanzado" />}
          {section === "about" && <AboutSettings />}
        </div>
      </div>
    </div>
  );
};

const SectionHead = ({ eyebrow, title, lede }) => (
  <header style={{ marginBottom: 32 }}>
    <span className="eyebrow">{eyebrow}</span>
    <h1 className="h-display" style={{ fontSize: 32, marginTop: 10, marginBottom: 10 }}>{title}</h1>
    {lede && <p className="lede">{lede}</p>}
  </header>
);

const Row = ({ label, hint, children }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "1fr auto",
    gap: 24, alignItems: "center",
    padding: "16px 0",
    borderBottom: "1px solid var(--border-subtle)",
  }}>
    <div>
      <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500 }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--paper-400)", marginTop: 3, lineHeight: 1.45 }}>{hint}</div>}
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{children}</div>
  </div>
);

const ModelSettings = () => {
  return (
    <>
      <SectionHead
        eyebrow="LLM"
        title="Modelo de lenguaje"
        lede="El cerebro del estudio. Genera guion, estructura y diálogo. Recomendamos un modelo de al menos 7B parámetros con tu RAM disponible."
      />

      {/* Active model card */}
      <section style={{
        padding: 20,
        borderRadius: 14,
        background: "linear-gradient(180deg, rgba(201,168,76,0.08), rgba(201,168,76,0.02))",
        border: "1px solid rgba(201,168,76,0.25)",
        marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 10,
            background: "linear-gradient(135deg, var(--gold-300), var(--gold-600))",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--obsidian-950)",
          }}>
            <Icons.Brain style={{ width: 20, height: 20 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--gold-300)", textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 600 }}>
              Activo
            </div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--paper-50)" }}>Qwen 2.5 · 14B Instruct</div>
            <div style={{ fontSize: 12, color: "var(--paper-300)" }}>Q4_K_M · 8.4 GB en RAM · ~ 42 tokens/s</div>
          </div>
          <Pill tone="jade" icon="Activity">Cargado</Pill>
        </div>
      </section>

      <h2 className="h-section-label" style={{ marginBottom: 8 }}>Disponibles</h2>
      <div>
        {[
          { name: "Qwen 2.5 7B Instruct", size: "4.7 GB", speed: "rápido", tag: "ligero", installed: true },
          { name: "Llama 3.1 8B", size: "4.9 GB", speed: "medio", tag: "equilibrado", installed: true },
          { name: "Mistral Nemo 12B", size: "7.2 GB", speed: "preciso", tag: "narrativa", installed: false },
          { name: "Qwen 2.5 32B", size: "19 GB", speed: "lento", tag: "máxima calidad", installed: false },
        ].map((m, i) => (
          <ModelRow key={i} model={m} />
        ))}
      </div>
    </>
  );
};

const ModelRow = ({ model }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "1fr auto auto auto",
    gap: 16, alignItems: "center",
    padding: "12px 4px",
    borderBottom: "1px solid var(--border-subtle)",
  }}>
    <div>
      <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500 }}>{model.name}</div>
      <div style={{ fontSize: 11.5, color: "var(--paper-400)" }}>
        {model.size} · {model.speed} · {model.tag}
      </div>
    </div>
    {model.installed ? (
      <Pill tone="jade" icon="Check">Instalado</Pill>
    ) : (
      <Pill>~ 5 min</Pill>
    )}
    <button className="btn btn-ghost" style={{ height: 28, fontSize: 12 }}>
      {model.installed ? <><Icons.Activity />Activar</> : <><Icons.Download />Descargar</>}
    </button>
    <button className="topbar-icon-btn"><Icons.More /></button>
  </div>
);

const GeneralSettings = () => {
  const [autoStart, setAutoStart] = React.useState(true);
  const [particles, setParticles] = React.useState(true);
  const [notify, setNotify] = React.useState(true);
  const [tray, setTray] = React.useState(false);
  return (
    <>
      <SectionHead eyebrow="General" title="Preferencias" lede="Comportamiento básico de Xianxia Studio." />
      <Row label="Iniciar al arrancar el sistema" hint="Xianxia Studio se abrirá automáticamente con tu sesión.">
        <Toggle checked={autoStart} onChange={setAutoStart}/>
      </Row>
      <Row label="Minimizar a la bandeja" hint="Mantiene el estudio listo en segundo plano.">
        <Toggle checked={tray} onChange={setTray}/>
      </Row>
      <Row label="Notificar al terminar un render" hint="Push de sistema operativo + sonido suave.">
        <Toggle checked={notify} onChange={setNotify}/>
      </Row>
      <Row label="Partículas Qi" hint="Atmósfera dorada en el fondo. Cero impacto en rendimiento.">
        <Toggle checked={particles} onChange={setParticles}/>
      </Row>
      <Row label="Idioma de la interfaz" hint="Cambia el idioma de la propia app (no de los vídeos).">
        <button className="btn btn-secondary" style={{ fontSize: 12 }}>
          <Icons.Globe /> Español <Icons.ChevronDown style={{ width: 11, height: 11 }}/>
        </button>
      </Row>
      <Row label="Tema" hint="Celestial Dark es el tema canónico del estudio.">
        <div style={{ display: "flex", gap: 6, padding: 3, borderRadius: 8, background: "rgba(255,255,255,0.025)", border: "1px solid var(--border-subtle)" }}>
          <button style={{ padding: "4px 10px", borderRadius: 5, fontSize: 11, color: "var(--paper-50)", background: "rgba(255,255,255,0.07)" }}>
            <Icons.Moon style={{ width: 11, height: 11, marginRight: 4, verticalAlign: "-1px" }}/>Oscuro
          </button>
          <button style={{ padding: "4px 10px", borderRadius: 5, fontSize: 11, color: "var(--paper-400)" }}>
            <Icons.Sun style={{ width: 11, height: 11, marginRight: 4, verticalAlign: "-1px" }}/>Auto
          </button>
        </div>
      </Row>
    </>
  );
};

const VoiceSettings = () => (
  <>
    <SectionHead eyebrow="Voces" title="Voces y clonación" lede="9 voces nativas multilenguaje. Clona la tuya con 5 segundos de audio." />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
      {[
        { name: "Celeste", lang: "ES", style: "Solemne", color: "#c9a84c" },
        { name: "Wei",     lang: "ES", style: "Cálido",  color: "#74c69d" },
        { name: "Lin",     lang: "EN", style: "Misterio", color: "#9d2933" },
        { name: "Hao",     lang: "ZH", style: "Maestro", color: "#52b788" },
      ].map((v, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: 14,
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 999,
            background: `linear-gradient(135deg, ${v.color}, ${v.color}aa)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 600, color: "var(--obsidian-950)",
          }}>{v.name[0]}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, color: "var(--paper-100)", fontWeight: 500 }}>{v.name}</div>
            <div style={{ fontSize: 11, color: "var(--paper-400)" }}>{v.style} · {v.lang}</div>
          </div>
          <button className="topbar-icon-btn"><Icons.Play /></button>
        </div>
      ))}
    </div>

    <h2 className="h-section-label" style={{ marginBottom: 12 }}>Tu voz</h2>
    <section style={{
      padding: 20,
      borderRadius: 12,
      background: "linear-gradient(180deg, rgba(82,183,136,0.06), rgba(82,183,136,0.01))",
      border: "1px dashed rgba(82,183,136,0.3)",
      display: "flex", alignItems: "center", gap: 16,
    }}>
      <Icons.Mic style={{ width: 28, height: 28, color: "var(--jade-400)" }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: "var(--paper-50)", fontWeight: 500 }}>Clona tu voz en 5 segundos</div>
        <div style={{ fontSize: 12, color: "var(--paper-300)" }}>Graba o sube un audio limpio para crear tu voz personal.</div>
      </div>
      <button className="btn btn-secondary"><Icons.Plus /> Comenzar</button>
    </section>
  </>
);

const HardwareSettings = () => {
  const hw = MockData.hardware;
  return (
    <>
      <SectionHead eyebrow="Hardware" title="Tu máquina" lede="Resumen del entorno donde se ejecuta el estudio. Todo el procesamiento ocurre aquí, en local." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        <HwTile icon="Cpu" label="CPU" value={hw.cpu} usage={hw.cpuUsage}/>
        <HwTile icon="Memory" label="Memoria" value={`${hw.ramUsed} / ${hw.ramTotal} GB`} usage={hw.ramUsage}/>
        <HwTile icon="Bolt" label="GPU" value={hw.gpu} usage={62}/>
        <HwTile icon="Folder" label="Almacenamiento" value={hw.storage} usage={40}/>
      </div>

      <Row label="Usar GPU para inferencia" hint="Aceleración CUDA en SDXL e imágenes. Liberará la CPU.">
        <Toggle checked={true} onChange={() => {}}/>
      </Row>
      <Row label="Workers en paralelo" hint="Más workers = más velocidad pero mayor uso de RAM.">
        <div className="topbar-segment" style={{ position: "static" }}>
          {["1", "2", "4", "8"].map((n) => (
            <button key={n} className={`topbar-segment-btn${n === "4" ? " is-active" : ""}`} style={{ padding: "3px 12px" }}>
              {n}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Límite de RAM para LLM" hint="Reservaremos como máximo este porcentaje para el modelo.">
        <span className="mono" style={{ fontSize: 12, color: "var(--paper-200)" }}>60%</span>
        <input type="range" defaultValue="60" style={{ width: 140 }}/>
      </Row>
    </>
  );
};

const HwTile = ({ icon, label, value, usage }) => {
  const Icon = Icons[icon];
  return (
    <div style={{ padding: 16, border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Icon style={{ width: 14, height: 14, color: "var(--paper-400)" }} />
        <span style={{ fontSize: 11, color: "var(--paper-400)", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--paper-100)", marginBottom: 10, lineHeight: 1.3 }}>{value}</div>
      <div style={{ height: 4, borderRadius: 999, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${usage}%`, background: usage > 80 ? "var(--gold-400)" : "var(--jade-400)", borderRadius: 999 }}/>
      </div>
    </div>
  );
};

const PublishSettings = () => (
  <>
    <SectionHead eyebrow="Publicación" title="Canales conectados" lede="Sube directamente con metadata, subtítulos multi-idioma y miniatura." />
    <Row label={
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Icons.YouTube style={{ width: 16, height: 16, color: "var(--crimson-400)" }} /> YouTube · Crónicas de Jade
      </span>
    } hint="Conectado el 18 abr · 12 vídeos publicados">
      <Pill tone="jade" icon="Check">Activo</Pill>
      <button className="btn btn-ghost" style={{ fontSize: 12 }}>Desconectar</button>
    </Row>
    <Row label="Instagram Reels" hint="No conectado">
      <button className="btn btn-secondary"><Icons.Plus />Conectar</button>
    </Row>
    <Row label="TikTok" hint="No conectado">
      <button className="btn btn-secondary"><Icons.Plus />Conectar</button>
    </Row>
  </>
);

const AboutSettings = () => (
  <>
    <SectionHead eyebrow="Acerca de" title="Xianxia Studio" />
    <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 32 }}>
      <div style={{
        width: 80, height: 80, borderRadius: 18,
        background: "linear-gradient(135deg, var(--gold-300), var(--gold-600))",
        boxShadow: "0 0 32px rgba(201,168,76,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--obsidian-950)",
      }}>
        <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M3 18 9 9l4 5 3-3 5 7Z"/><circle cx="17" cy="6" r="2"/></svg>
      </div>
      <div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--paper-50)" }}>Xianxia Studio</div>
        <div style={{ fontSize: 13, color: "var(--paper-300)" }}>Versión 0.2.4 · build 7841</div>
        <div style={{ fontSize: 12, color: "var(--paper-400)", marginTop: 4 }}>Apache 2.0 · 100% offline · sin telemetría</div>
      </div>
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <button className="btn btn-secondary"><Icons.Refresh />Buscar actualizaciones</button>
      <button className="btn btn-ghost">Sitio web</button>
      <button className="btn btn-ghost">Notas de versión</button>
    </div>
  </>
);

const PlaceholderSection = ({ title }) => (
  <>
    <SectionHead eyebrow={title} title={title} lede="Esta sección se desarrollará después." />
    <div style={{ padding: 40, border: "1px dashed var(--border-default)", borderRadius: 12, textAlign: "center", color: "var(--paper-400)" }}>
      Por definir
    </div>
  </>
);

window.Settings = Settings;
