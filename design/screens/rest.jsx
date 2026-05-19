/* eslint-disable */
// Library + Shorts + Settings + Scheduler + Install — native macOS patterns.

/* ─────────────── LIBRARY ─────────────── */
function Library({ onNavigate }) {
  const [filter, setFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [chips, setChips] = React.useState([]);
  const [contextMenu, setContextMenu] = React.useState(null);

  const videos = [
    { id: 1, title: "El Emperador de Jade y los Nueve Cielos", status: "published", duration: "13:24", size: "640 MB", views: "2.4K", date: "Hace 2 días" },
    { id: 2, title: "Norse mythology — Ragnarök and the fall of the gods", status: "published", duration: "12:08", size: "580 MB", views: "1.2K", date: "Hace 4 días" },
    { id: 3, title: "Black holes and the limits of physics", status: "ready", duration: "10:41", size: "510 MB", views: "—", date: "Hace 1 sem" },
    { id: 4, title: "La leyenda de los espadachines del Bosque Lunar", status: "ready", duration: "11:32", size: "548 MB", views: "—", date: "Hace 1 sem" },
    { id: 5, title: "Atlantis — the lost civilization", status: "published", duration: "14:02", size: "672 MB", views: "8.1K", date: "Hace 2 sem" },
    { id: 6, title: "La caída del Imperio Romano", status: "published", duration: "15:18", size: "722 MB", views: "12K", date: "Hace 3 sem" },
  ];

  const filtered = videos
    .filter(v => filter === "all" || v.status === filter)
    .filter(v => v.title.toLowerCase().includes(search.toLowerCase()));

  const availableChips = [
    { id: "long", label: "Long-form > 10 min" },
    { id: "viral", label: "Más de 1K vistas" },
    { id: "vertical", label: "Vertical 9:16" },
    { id: "week", label: "Última semana" },
  ];
  const toggleChip = (c) => setChips(arr => arr.includes(c) ? arr.filter(x => x !== c) : [...arr, c]);

  return (
    <div className="route-enter" style={{
      maxWidth: 1100, margin: "0 auto", padding: "28px 32px 56px",
    }}>
      <PageHeader
        title="Biblioteca"
        subtitle="Todos los vídeos producidos."
        action={
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn large"><I.Folder size={11}/> Abrir carpeta</button>
            <button className="btn-primary large" onClick={() => onNavigate("generator")}>
              <I.Plus size={11} strokeWidth={2.5}/> Nuevo
            </button>
          </div>
        }
      />

      {/* Filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div className="segmented">
          {[
            ["all", "Todos", videos.length],
            ["published", "Publicados", videos.filter(v=>v.status==="published").length],
            ["ready", "Listos", videos.filter(v=>v.status==="ready").length],
          ].map(([k, l, c]) => (
            <button key={k} className={"segmented-btn" + (filter === k ? " active" : "")} onClick={() => setFilter(k)}>
              {l} <span style={{ color: "var(--text-tertiary)" }}>{c}</span>
            </button>
          ))}
        </div>
        <div style={{ position: "relative", marginLeft: "auto" }}>
          <I.Search size={11} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-tertiary)" }}/>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar…"
            style={{ width: 200, paddingLeft: 24 }}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 22 }}>
        {availableChips.map(c => {
          const active = chips.includes(c.id);
          return (
            <button key={c.id} className={"chip" + (active ? " active" : "")} onClick={() => toggleChip(c.id)}>
              {c.label}
              {active && <I.X size={9} className="chip-close" style={{ marginLeft: 4 }}/>}
            </button>
          );
        })}
        {chips.length > 0 && (
          <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setChips([])}>
            Limpiar
          </button>
        )}
      </div>

      {filtered.length > 0 ? (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 14,
        }}>
          {filtered.map((v, i) => <VideoCard key={v.id} {...v} delay={i*40} onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, video: v }); }}/>)}
        </div>
      ) : (
        <EmptyState
          title="Sin resultados"
          subtitle="Prueba con otro filtro o crea uno nuevo."
          action={<button className="btn-primary" onClick={() => onNavigate("generator")}>Nuevo vídeo</button>}
        />
      )}

      {contextMenu && (
        <VideoContextMenu {...contextMenu} onClose={() => setContextMenu(null)}/>
      )}
    </div>
  );
}

function VideoCard({ title, status, duration, size, views, date, delay, onContextMenu }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      className="fade-up"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={onContextMenu}
      style={{ animationDelay: `${delay}ms`, cursor: "default" }}
    >
      {/* Thumb — clean, flat, no SVG decoration */}
      <div style={{
        aspectRatio: "16/9",
        borderRadius: 6,
        background: "#0a0a0e",
        boxShadow: "0 0 0 0.5px rgba(255,255,255,0.06)",
        position: "relative",
        overflow: "hidden",
        marginBottom: 8,
      }}>
        {/* Play overlay */}
        <div style={{
          position: "absolute", inset: 0,
          background: hover ? "rgba(255,255,255,0.05)" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 160ms",
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 999,
            background: "rgba(255,255,255,0.92)",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: hover ? 1 : 0,
            transform: hover ? "scale(1)" : "scale(0.9)",
            transition: "all 180ms var(--ease-spring)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}>
            <I.Play size={12} style={{ color: "#1a1a1f", marginLeft: 2 }}/>
          </div>
        </div>
        {/* Duration */}
        <div style={{
          position: "absolute", bottom: 6, right: 6,
          padding: "1px 5px", borderRadius: 3,
          background: "rgba(0,0,0,0.75)",
          fontSize: 10, fontFamily: "var(--font-mono)",
          color: "var(--text-primary)",
        }}>{duration}</div>
        {status === "published" && (
          <div style={{
            position: "absolute", top: 6, left: 6,
            padding: "1px 6px", borderRadius: 3,
            background: "rgba(108, 185, 146, 0.20)",
            backdropFilter: "blur(8px)",
            fontSize: 9.5, color: "var(--green)",
            fontWeight: 500,
          }}>
            ● Publicado
          </div>
        )}
      </div>
      <div style={{
        fontSize: 12.5, fontWeight: 500, lineHeight: 1.35,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
        textWrap: "pretty",
        minHeight: 34,
      }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, display: "flex", gap: 6 }}>
        <span>{date}</span>
        <span>·</span>
        <span className="mono">{size}</span>
        {views !== "—" && (
          <>
            <span style={{ marginLeft: "auto", color: "var(--text-secondary)" }}>
              <I.Eye size={9} style={{ marginRight: 3, verticalAlign: -1 }}/>{views}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function VideoContextMenu({ x, y, video, onClose }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const items = [
    { icon: "Play", label: "Reproducir" },
    { icon: "External", label: "Abrir en el sistema" },
    { icon: "Folder", label: "Mostrar carpeta" },
    null,
    { icon: "Sparkles", label: "Re-publicar" },
    { icon: "Scissors", label: "Generar Shorts desde este" },
    { icon: "Layout", label: "Exportar 9:16" },
    { icon: "Pencil", label: "Editar metadatos" },
    null,
    { icon: "Trash", label: "Eliminar", danger: true },
  ];
  return (
    <div ref={ref} style={{
      position: "fixed",
      left: Math.min(x, window.innerWidth - 240),
      top: Math.min(y, window.innerHeight - 320),
      width: 220,
      zIndex: 90,
      padding: 5,
      background: "rgba(40,40,46,0.55)",
      backdropFilter: "blur(60px) saturate(190%)",
      WebkitBackdropFilter: "blur(60px) saturate(190%)",
      borderRadius: 8,
      boxShadow: "var(--shadow-popover)",
      animation: "fade-up 160ms var(--ease-spring) both",
    }}>
      {items.map((it, i) => {
        if (it === null) return (<div key={i} style={{ height: 1, background: "var(--separator)", margin: "4px 6px" }}/>);
        const Icon = I[it.icon];
        return (
        <button key={i} onClick={onClose} style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8,
          padding: "5px 10px",
          borderRadius: 5,
          textAlign: "left",
          fontSize: 12.5,
          color: it.danger ? "var(--red)" : "var(--text-primary)",
          transition: "background 100ms",
        }}
          onMouseEnter={(e) => e.currentTarget.style.background = it.danger ? "rgba(200,82,94,0.18)" : "rgba(255,255,255,0.07)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          <Icon size={11}/>
          {it.label}
        </button>
      );})}
    </div>
  );
}

function EmptyState({ title, subtitle, action }) {
  return (
    <div style={{
      padding: "56px 24px",
      textAlign: "center",
      background: "var(--bg-list)",
      borderRadius: "var(--r-lg)",
    }}>
      <div className="title" style={{ marginBottom: 4 }}>{title}</div>
      <div className="caption" style={{ marginBottom: 16 }}>{subtitle}</div>
      {action}
    </div>
  );
}

/* ─────────────── SHORTS ─────────────── */
function Shorts() {
  const [file, setFile] = React.useState(null);
  const [drag, setDrag] = React.useState(false);
  const [n, setN] = React.useState(3);
  const [dur, setDur] = React.useState(45);
  const [style, setStyle] = React.useState("hormozi");
  const [burn, setBurn] = React.useState(true);

  const styles = [
    { id: "hormozi", label: "Hormozi",  desc: "Amarillo + outline · viral",  color: "#FBE15A" },
    { id: "mrbeast", label: "MrBeast",  desc: "Rojo highlight",              color: "#FF4747" },
    { id: "xianxia", label: "Xianxia",  desc: "Oro + jade",                  color: "#c9a84c" },
    { id: "minimal", label: "Minimal",  desc: "Blanco · sin distraer",       color: "#f0f0f0" },
    { id: "neon",    label: "Neon",     desc: "Cyan + magenta · gamer",      color: "#46e6ff" },
  ];

  return (
    <div className="route-enter" style={{ maxWidth: 980, margin: "0 auto", padding: "28px 32px 56px" }}>
      <PageHeader
        title="Smart Shorts"
        subtitle="Sube cualquier MP4 y la app extrae automáticamente los Shorts más virales."
      />

      <Group label="Vídeo de entrada">
        <div className="row" style={{ padding: 14 }}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0].name); }}
            onClick={() => setFile("entrevista-podcast-ep42.mp4")}
            style={{
              flex: 1,
              padding: "20px 16px",
              borderRadius: 6,
              background: drag ? "var(--accent-bg)" : "rgba(0,0,0,0.18)",
              border: "1px dashed " + (drag ? "var(--accent)" : "rgba(255,255,255,0.10)"),
              textAlign: "center",
              cursor: "default",
              transition: "all 140ms",
            }}
          >
            <I.Upload size={16} style={{ color: drag ? "var(--accent)" : "var(--text-secondary)", marginBottom: 6 }}/>
            {file ? (
              <>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{file}</div>
                <div className="caption" style={{ marginTop: 1 }}>1280×720 · 42:18 · 1.4 GB</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>Arrastra un vídeo aquí, o haz clic para elegir</div>
                <div className="caption" style={{ marginTop: 1 }}>MP4 · MOV · MKV · WebM · AVI</div>
              </>
            )}
          </div>
        </div>
      </Group>

      <Group label="Configuración">
        <Row title="Cantidad de Shorts" sub={`${n} clips por vídeo`} control={
          <div style={{ width: 160, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="range" min={1} max={10} value={n} onChange={(e) => setN(+e.target.value)} className="range"/>
            <span className="mono" style={{ width: 16, textAlign: "right" }}>{n}</span>
          </div>
        }/>
        <Row title="Duración por clip" sub={`${dur} segundos`} control={
          <div style={{ width: 160, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="range" min={15} max={90} step={5} value={dur} onChange={(e) => setDur(+e.target.value)} className="range"/>
            <span className="mono" style={{ width: 30, textAlign: "right" }}>{dur}s</span>
          </div>
        }/>
        <Row title="Quemar subtítulos" sub="ASS karaoke palabra a palabra" control={
          <button className={"toggle" + (burn ? " on" : "")} onClick={() => setBurn(!burn)}/>
        }/>
      </Group>

      <Group label="Estilo de subtítulos">
        {styles.map(s => (
          <Row
            key={s.id}
            title={s.label}
            sub={s.desc}
            value={
              <div style={{
                fontFamily: "Impact, sans-serif",
                fontSize: 11, fontWeight: 900,
                padding: "1px 6px",
                borderRadius: 3,
                color: s.id === "minimal" ? "#1a1a1a" : "#000",
                background: s.color,
              }}>AaBb</div>
            }
            control={
              <button
                onClick={() => setStyle(s.id)}
                className={"lg-radio" + (style === s.id ? " on" : "")}
              />
            }
            hoverable
            onClick={() => setStyle(s.id)}
          />
        ))}
      </Group>

      {/* Animated caption preview */}
      <CaptionPreview style={style} styleDef={styles.find(s => s.id === style)}/>

      <div style={{
        background: "var(--bg-list)",
        borderRadius: "var(--r-lg)",
        padding: "14px 16px",
        display: "flex", alignItems: "center", gap: 14,
      }}>
        <div style={{ flex: 1 }}>
          <div className="caption" style={{ marginBottom: 2 }}>Estimación</div>
          <div style={{ fontSize: 12.5 }}>~3-5 min · transcripción + scoring LLM + corte + reframe</div>
        </div>
        <button className="btn-primary large" disabled={!file}>
          Extraer {n} Shorts
        </button>
      </div>
    </div>
  );
}

/* ─────────────── SCHEDULER ─────────────── */
function Scheduler() {
  const items = [
    { id: 1, title: "El Emperador de Jade y los Nueve Cielos", date: "Hoy", time: "20:00" },
    { id: 2, title: "Norse mythology · Ragnarök", date: "Mañana", time: "14:00" },
    { id: 3, title: "Black holes — Shorts pack (3)", date: "Vie", time: "18:30" },
  ];
  return (
    <div className="route-enter page">
      <PageHeader
        title="Planificador"
        subtitle="Programa publicaciones a YouTube con cadencia automática."
        action={<button className="btn-primary large"><I.Plus size={11} strokeWidth={2.5}/> Programar</button>}
      />

      <Group label="Cuenta">
        <Row
          icon="Youtube" iconColor="#c8525e"
          title="@xianxia_mythos"
          sub="12K suscriptores · OAuth válido hasta noviembre"
          control={<button className="btn-ghost">Cambiar</button>}
        />
      </Group>

      <Group label="Próximas publicaciones">
        {items.map(it => (
          <Row
            key={it.id}
            title={it.title}
            sub={`${it.date} a las ${it.time} · en cola`}
            value={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span className="dot dot-idle"/>
                <span style={{ fontSize: 11, color: "var(--orange)" }}>En cola</span>
              </span>
            }
            chev
          />
        ))}
      </Group>

      <Group label="Cadencia automática">
        <Row
          icon="Clock" iconColor="#d4b85a"
          title="3 vídeos por semana"
          sub="L · X · V a las 18:00 — auto-Shorts el día siguiente"
          control={<button className="btn">Editar</button>}
        />
      </Group>
    </div>
  );
}

/* ─────────────── SETTINGS — System Settings layout ─────────────── */
function Settings() {
  const [section, setSection] = React.useState("general");
  const sections = [
    { id: "general",    label: "General",     icon: "Settings", tint: "#5d7575" }, // nefrita
    { id: "services",   label: "Servicios",   icon: "Activity", tint: "#2eb189" }, // jade imperial
    { id: "models",     label: "Modelos",     icon: "Bot",      tint: "#5ed8a6" }, // jade pálido
    { id: "hardware",   label: "Hardware",    icon: "Cpu",      tint: "#7a8a8a" }, // nefrita
    { id: "voices",     label: "Voces",       icon: "Mic",      tint: "#d4b85a" }, // oro (clonado = premium)
    { id: "components", label: "Componentes", icon: "Download", tint: "#a88a3c" }, // oro profundo
    { id: "music",      label: "Música",      icon: "Music",    tint: "#74c69d" }, // jade
    { id: "youtube",    label: "YouTube",     icon: "Youtube",  tint: "#c8525e" }, // bermellón (icónico)
    { id: "advanced",   label: "Avanzado",    icon: "Shield",   tint: "#4d5c5c" }, // nefrita
  ];

  return (
    <div className="route-enter" style={{
      maxWidth: 920, margin: "0 auto", padding: "28px 32px 56px",
    }}>
      <PageHeader title="Ajustes" subtitle="Servicios, modelos, hardware y conexiones."/>

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 28, alignItems: "flex-start" }}>
        <nav style={{ position: "sticky", top: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          {sections.map(s => {
            const Icon = I[s.icon];
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "5px 10px",
                  height: 34,
                  borderRadius: 999,
                  background: active ? "var(--sidebar-selection)" : "transparent",
                  boxShadow: active
                    ? "inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -0.5px 0 rgba(0,0,0,0.18), 0 0 0 0.5px rgba(94,216,166,0.45), 0 2px 6px rgba(0,0,0,0.22)"
                    : "none",
                  color: "var(--text-primary)",
                  textAlign: "left",
                  fontSize: 13,
                  fontWeight: active ? 500 : 400,
                  transition: "all 160ms var(--ease-spring)",
                }}
              >
                <span className="lg-tile md" style={{ "--tint": s.tint }}>
                  <Icon size={13}/>
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          {section === "general" && <GeneralSettings/>}
          {section === "services" && <ServicesSettings/>}
          {section === "models" && <ModelsSettings/>}
          {section === "hardware" && <HardwareSettings/>}
          {section === "voices" && <VoicesSettings/>}
          {section === "components" && <ComponentsSettings/>}
          {section === "music" && <MusicSettings/>}
          {section === "youtube" && <YouTubeSettings/>}
          {section === "advanced" && <AdvancedSettings/>}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const [autoUpdate, setAutoUpdate] = React.useState(true);
  const [analytics, setAnalytics] = React.useState(false);
  const [theme, setTheme] = React.useState("celestial");
  const [lang, setLang] = React.useState("es");
  return (
    <>
      <Group label="Aplicación">
        <Row
          title="Idioma de la aplicación"
          sub="Se aplica al reiniciar"
          control={
            <div className="segmented">
              {[["es", "ES"], ["en", "EN"], ["zh", "中文"]].map(([k, l]) => (
                <button key={k} className={"segmented-btn" + (lang === k ? " active" : "")} onClick={() => setLang(k)}>{l}</button>
              ))}
            </div>
          }
        />
        <Row
          title="Actualizaciones automáticas"
          sub="Descarga y aplica releases al iniciar"
          control={<button className={"toggle" + (autoUpdate ? " on" : "")} onClick={() => setAutoUpdate(!autoUpdate)}/>}
        />
        <Row
          title="Enviar telemetría anónima"
          sub="Sólo crash reports. Nunca el contenido generado."
          control={<button className={"toggle" + (analytics ? " on" : "")} onClick={() => setAnalytics(!analytics)}/>}
        />
        <Row
          title="Tema"
          control={
            <div className="segmented">
              {["celestial","jade","crimson"].map(t => (
                <button key={t} className={"segmented-btn" + (theme === t ? " active" : "")} onClick={() => setTheme(t)} style={{ textTransform: "capitalize" }}>{t}</button>
              ))}
            </div>
          }
        />
      </Group>

      <Group label="Almacenamiento">
        <Row title="Carpeta de proyectos" sub="C:\Users\swon\Xianxia Studio" control={<button className="btn"><I.Folder size={11}/> Cambiar</button>}/>
        <Row title="Limpiar caché de modelos" sub="Libera 4.2 GB de tensores temporales" control={<button className="btn">Limpiar</button>}/>
      </Group>
    </>
  );
}

function ServicesSettings() {
  const services = [
    { label: "llama.cpp", sub: "LLM runtime · puerto 8733 · b3247", state: "running" },
    { label: "Python sidecar (FastAPI)", sub: "TTS · Whisper · puerto 8731", state: "running" },
    { label: "Node sidecar (HyperFrames)", sub: "Renderizado · puerto 8732", state: "running" },
    { label: "ComfyUI", sub: "Z-Image · puerto 8188", state: "running" },
    { label: "Ollama", sub: "Alternativo opcional", state: "missing" },
  ];
  return (
    <Group label="Servicios locales" footer="Los servicios se inician automáticamente al abrir la app. Reinicia si algo falla.">
      {services.map(s => (
        <Row
          key={s.label}
          title={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span className={"dot " + (s.state === "running" ? "dot-running" : "dot-missing")}/>
            {s.label}
          </span>}
          sub={s.sub}
          value={
            s.state === "missing"
              ? <button className="btn">Instalar</button>
              : <span style={{ fontSize: 11, color: "var(--green)" }}>Activo</span>
          }
        />
      ))}
    </Group>
  );
}

function ModelsSettings() {
  return (
    <Group label="Modelo LLM activo">
      <Row title="Gemma 4 E4B abliterated" sub="unsloth/gemma-4-E4B-it-abliterated-GGUF · Q5_K_M" value={<span style={{ color: "var(--green)", fontSize: 11 }}>Cargado</span>}/>
      <Row title="Variante" sub="Abliterated (sin filtros) — recomendado para narrativa." control={<button className="btn">Cambiar</button>}/>
      <Row title="VRAM ocupada" sub="Margen disponible: 12.1 GB" value={<span className="mono">5.9 / 18.0 GB</span>}/>
    </Group>
  );
}

function HardwareSettings() {
  return (
    <Group label="Hardware detectado">
      <Row title="CPU" sub="Intel Core i9-13900K · 24 cores" value={<span className="mono">x86_64</span>}/>
      <Row title="GPU" sub="NVIDIA RTX 4080 · CUDA 12.4" value={<span className="mono">16 GB</span>}/>
      <Row title="RAM" sub="DDR5 6000 MHz" value={<span className="mono">32 GB</span>}/>
      <Row title="Tier recomendado" sub="Permite Gemma 4 E4B + Z-Image en paralelo" value={
        <span style={{
          padding: "1px 8px", borderRadius: 999,
          background: "var(--accent-bg)",
          color: "var(--accent-soft)",
          fontSize: 11, fontWeight: 500,
        }}>Ultra</span>
      }/>
    </Group>
  );
}

function VoicesSettings() {
  const clones = [
    { id: "1", name: "Mi voz", sub: "ES · muestra 5.2 s · usada en 12 vídeos" },
    { id: "2", name: "Narrador grave", sub: "EN · muestra 6.8 s · usada en 4 vídeos" },
  ];
  return (
    <Group label="Voces clonadas (Qwen3-TTS)" footer="Clona tu voz con sólo 5 segundos de audio claro.">
      {clones.map(c => (
        <Row key={c.id} title={c.name} sub={c.sub} control={
          <span style={{ display: "flex", gap: 4 }}>
            <button className="btn-ghost"><I.Play size={10}/></button>
            <button className="btn-ghost"><I.Trash size={10}/></button>
          </span>
        }/>
      ))}
      <Row title="Clonar nueva voz" sub="5s de audio claro bastan" control={<button className="btn" onClick={() => window.__openVoiceClone?.()}><I.Plus size={11}/> Clonar</button>} hoverable onClick={() => window.__openVoiceClone?.()}/>
    </Group>
  );
}

function ComponentsSettings() {
  const comps = [
    { name: "Qwen3-TTS Base (voice cloning)", size: "6.8 GB", installed: true },
    { name: "TRIBE v2 (auto-engagement)", size: "2.1 GB", installed: true },
    { name: "MusicGen (música generativa)", size: "3.4 GB", installed: false },
    { name: "DepthFlow (parallax 2.5D)", size: "1.2 GB", installed: false },
  ];
  return (
    <Group label="Componentes opcionales" footer="12.6 GB instalado · 4.6 GB disponibles para instalar.">
      {comps.map(c => (
        <Row key={c.name} title={c.name} sub={c.size} control={
          c.installed
            ? <span style={{ fontSize: 11, color: "var(--green)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <I.Check size={11}/> Instalado
              </span>
            : <button className="btn"><I.Download size={10}/> Instalar</button>
        }/>
      ))}
    </Group>
  );
}

function MusicSettings() {
  return (
    <Group label="Biblioteca de música">
      <Row title="Pistas locales" sub="84 archivos · 1.2 GB · cinematic / orchestral / ambient" control={<button className="btn-ghost"><I.Folder size={11}/></button>}/>
      <Row title="Backend generativo" sub="MusicGen — instala el componente opcional" value={<span className="caption">No instalado</span>}/>
    </Group>
  );
}

function YouTubeSettings() {
  return (
    <Group label="YouTube">
      <Row icon="Youtube" iconColor="#c8525e" title="Canal vinculado" sub="@xianxia_mythos · 12K suscriptores" control={<button className="btn-ghost">Cambiar</button>}/>
      <Row title="OAuth Credentials" sub="Google Cloud · client_id.json válido" control={<button className="btn-ghost">Ver</button>}/>
      <Row title="Publicar como 'No listado' por defecto" sub="Revisa antes de hacerlo público" control={<button className="toggle on"/>}/>
    </Group>
  );
}

function AdvancedSettings() {
  return (
    <Group label="Avanzado">
      <Row title="LLM con filtros oficiales" sub="Cambia a la variante con filtros de Google" control={<button className="toggle"/>}/>
      <Row title="Modo experimental" sub="Activa flags inestables" control={<button className="toggle"/>}/>
      <Row title="Reset completo" sub="Borra modelos, caché y preferencias. No reversible." control={<button className="btn btn-destructive">Reset…</button>}/>
    </Group>
  );
}

/* ─────────────── INSTALL ─────────────── */
function Install() {
  return (
    <div className="route-enter page">
      <PageHeader title="Instalador" subtitle="Detectamos tu hardware y elegimos los modelos óptimos."/>

      <Group label="Detección de hardware">
        <Row icon="Check" iconColor="#d4b85a" title="Tier Ultra detectado" sub="RTX 4080 · 16 GB VRAM · 32 GB RAM" value={<span style={{ color: "var(--green)", fontSize: 11 }}>Compatible</span>}/>
      </Group>

      <Group label="Modelos a instalar" footer="Total: ~14 GB · descarga reanudable.">
        {[
          { n: "Gemma 4 E4B (abliterated)", t: "LLM · narrativa", s: "5.4 GB" },
          { n: "Z-Image-Turbo", t: "Imágenes cinemáticas", s: "4.2 GB" },
          { n: "Qwen3-TTS", t: "Voces narrador", s: "2.1 GB" },
          { n: "faster-whisper-large-v3", t: "Subtítulos", s: "1.5 GB" },
          { n: "Pistas musicales base", t: "Biblioteca cinematográfica", s: "1.2 GB" },
        ].map((m, i) => (
          <Row key={i} title={m.n} sub={m.t} value={<span className="mono">{m.s}</span>} control={<button className="toggle on"/>}/>
        ))}
      </Group>

      <div style={{ marginTop: 16, textAlign: "right" }}>
        <button className="btn-primary large"><I.Download size={11}/> Instalar todo (14 GB)</button>
      </div>
    </div>
  );
}

Object.assign(window, { Library, Shorts, Scheduler, Settings, Install });

/* ── Animated caption preview ──────────────────────────────────────── */
function CaptionPreview({ style, styleDef }) {
  const words = ["ESTO", "ES", "UN", "HOOK", "QUE", "TE", "RETIENE"];
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % words.length), 380);
    return () => clearInterval(id);
  }, []);
  const renderCaption = () => {
    if (style === "hormozi") {
      return (
        <div style={{ fontFamily: "Impact, sans-serif", fontSize: 30, lineHeight: 1.1, textTransform: "uppercase", textAlign: "center", letterSpacing: 0.5 }}>
          {words.map((w, i) => (
            <span key={i} style={{
              display: "inline-block",
              padding: "0 4px",
              color: i === idx ? "#000" : "#fff",
              background: i === idx ? styleDef.color : "transparent",
              WebkitTextStroke: i === idx ? "0" : "1.5px #000",
              transition: "all 100ms",
              transform: i === idx ? "scale(1.08)" : "scale(1)",
              margin: "0 2px",
            }}>{w}</span>
          ))}
        </div>
      );
    }
    if (style === "mrbeast") {
      return (
        <div style={{ fontFamily: "Impact, sans-serif", fontSize: 30, lineHeight: 1.1, textTransform: "uppercase", textAlign: "center", color: "#fff", WebkitTextStroke: "2.5px #000" }}>
          {words.map((w, i) => (
            <span key={i} style={{
              display: "inline-block",
              margin: "0 3px",
              color: i === idx ? styleDef.color : "#fff",
              transition: "all 100ms",
              transform: i === idx ? "scale(1.12)" : "scale(1)",
              filter: i === idx ? "drop-shadow(0 0 6px " + styleDef.color + ")" : "none",
            }}>{w}</span>
          ))}
        </div>
      );
    }
    if (style === "xianxia") {
      return (
        <div style={{ fontFamily: "EB Garamond, Georgia, serif", fontSize: 28, lineHeight: 1.2, textAlign: "center", fontStyle: "italic" }}>
          {words.map((w, i) => (
            <span key={i} style={{
              display: "inline-block",
              margin: "0 4px",
              color: i === idx ? styleDef.color : "rgba(255,255,255,0.50)",
              textShadow: i === idx ? "0 0 10px " + styleDef.color : "none",
              transition: "all 220ms",
              opacity: i <= idx + 1 ? 1 : 0.4,
            }}>{w.toLowerCase()}</span>
          ))}
        </div>
      );
    }
    if (style === "minimal") {
      return (
        <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 24, fontWeight: 500, textAlign: "center", color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.8)", letterSpacing: -0.005 }}>
          {words.slice(0, idx + 1).join(" ")}
          <span style={{ opacity: 0.6 }}>{idx < words.length - 1 ? "|" : ""}</span>
        </div>
      );
    }
    // neon
    return (
      <div style={{ fontFamily: "Impact, sans-serif", fontSize: 30, lineHeight: 1.1, textTransform: "uppercase", textAlign: "center" }}>
        {words.map((w, i) => (
          <span key={i} style={{
            display: "inline-block",
            margin: "0 3px",
            color: i === idx ? "#46e6ff" : "#ff46c4",
            textShadow: i === idx ? "0 0 12px #46e6ff" : "0 0 6px #ff46c4",
            transition: "all 100ms",
            transform: i === idx ? "scale(1.10)" : "scale(1)",
          }}>{w}</span>
        ))}
      </div>
    );
  };

  return (
    <div style={{
      padding: 0,
      marginBottom: 18,
      borderRadius: 12,
      overflow: "hidden",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 0.5px rgba(255,255,255,0.07)",
    }}>
      <div className="eyebrow" style={{ padding: "8px 12px 6px", background: "rgba(255,255,255,0.04)", margin: 0 }}>
        Vista previa animada · {styleDef.label}
      </div>
      <div style={{
        aspectRatio: "16/9",
        background:
          "radial-gradient(at 30% 30%, rgba(46,177,137,0.25), transparent 40%)," +
          "radial-gradient(at 70% 70%, rgba(212,184,90,0.15), transparent 40%)," +
          "linear-gradient(135deg, #0d1f1a, #0a0e1a)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        padding: "0 24px 32px",
        position: "relative",
        maxHeight: 200,
      }}>
        {/* Mock waveform at top */}
        <div style={{ position: "absolute", top: 12, left: 12, display: "flex", gap: 1.5, height: 16 }}>
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} style={{
              width: 2,
              height: 3 + Math.abs(Math.sin((i + idx*2) * 0.6)) * 12,
              background: "rgba(255,255,255,0.45)",
              borderRadius: 1,
            }}/>
          ))}
        </div>
        {/* Mock duration */}
        <div className="mono" style={{ position: "absolute", top: 12, right: 12, fontSize: 10, color: "rgba(255,255,255,0.55)" }}>
          0:0{Math.floor(idx/2)} / 0:45
        </div>
        {renderCaption()}
      </div>
    </div>
  );
}

window.CaptionPreview = CaptionPreview;
