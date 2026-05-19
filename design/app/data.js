// Mock data for the prototype
window.MockData = {
  user: {
    initials: "S",
    name: "Swon",
  },
  hardware: {
    cpu: "AMD Ryzen 7 5800X · 8 cores",
    cpuShort: "8 cores",
    cpuUsage: 23,
    ramUsed: 12.4,
    ramTotal: 32,
    ramUsage: 39,
    gpu: "NVIDIA RTX 4060 · 8 GB VRAM",
    storage: "1.2 TB free · 2 TB",
    os: "Windows 11 · x64",
  },
  services: [
    { id: "llamacpp", label: "llama.cpp", state: "running", hint: "Qwen 2.5 14B activo · 8.4 GB en RAM" },
    { id: "python",  label: "Python",    state: "running", hint: "Sidecar 3.11.7 · 4 workers" },
    { id: "node",    label: "Node",      state: "running", hint: "Sidecar 20.11 LTS" },
    { id: "comfyui", label: "ComfyUI",   state: "running", hint: "Listo · SDXL Turbo cargado" },
    { id: "ollama",  label: "Ollama",    state: "idle",    hint: "Opcional · no iniciado" },
  ],
  // Recent projects
  projects: [
    { id: "p-001", title: "El Inmortal del Pico de Loto", status: "ready",   thumb: "lotus",  duration: "12:34", lang: "es", views: null, scheduled: null, createdAt: "Hoy, 14:02" },
    { id: "p-002", title: "Las nueve espadas de Ling Shan", status: "rendering", thumb: "sword",  duration: "08:21", lang: "es", views: null, scheduled: null, createdAt: "Hoy, 13:18", progress: 0.74, currentPhase: "Composición HyperFrames" },
    { id: "p-003", title: "El maestro que esperó mil años", status: "published",  thumb: "monk",   duration: "18:05", lang: "en", views: 4823, scheduled: null, createdAt: "Ayer, 22:41" },
    { id: "p-004", title: "Demonios bajo el Monte Kunlun", status: "scheduled",  thumb: "mount",  duration: "11:12", lang: "es", views: null, scheduled: "Mañana, 18:00", createdAt: "Ayer, 19:30" },
    { id: "p-005", title: "Crónica de los siete reinos rotos", status: "draft", thumb: "scroll", duration: "—",     lang: "es", views: null, scheduled: null, createdAt: "Hace 2 días" },
    { id: "p-006", title: "El cultivo del silencio", status: "ready", thumb: "moon", duration: "06:48", lang: "es", views: null, scheduled: null, createdAt: "Hace 3 días" },
  ],
  // Pipeline phases (10)
  pipelinePhases: [
    { id: "research", label: "Investigación", desc: "Recopilando referencias del tema", icon: "Search" },
    { id: "outline",  label: "Estructura",    desc: "Generando arco narrativo y beats", icon: "Layers" },
    { id: "script",   label: "Guión",         desc: "Redacción con voz cinematográfica", icon: "Edit" },
    { id: "voice",    label: "Narración",     desc: "Síntesis de voz natural", icon: "Mic" },
    { id: "imagery",  label: "Imágenes",      desc: "Cinemáticas con SDXL local", icon: "Image" },
    { id: "music",    label: "Banda sonora",  desc: "Pista atmosférica generada", icon: "Music" },
    { id: "edit",     label: "Edición",       desc: "Parallax, transiciones y partículas", icon: "Film" },
    { id: "subs",     label: "Subtítulos",    desc: "Karaoke palabra a palabra", icon: "Captions" },
    { id: "engage",   label: "Engagement",    desc: "TRIBE v2 detecta y corrige valles", icon: "Brain" },
    { id: "export",   label: "Exportación",   desc: "Master + 9 presets de plataforma", icon: "Bolt" },
  ],
  scheduledQueue: [
    { id: "s1", title: "Demonios bajo el Monte Kunlun", channel: "Crónicas de Jade", when: "Mañana · 18:00", platform: "YouTube", color: "#e8c96d" },
    { id: "s2", title: "El cultivo del silencio",       channel: "Crónicas de Jade", when: "Mié · 18:00",    platform: "YouTube", color: "#74c69d" },
    { id: "s3", title: "Cinco picos, una mente",        channel: "Crónicas de Jade", when: "Vie · 18:00",    platform: "YouTube", color: "#c9a84c" },
  ],
};
