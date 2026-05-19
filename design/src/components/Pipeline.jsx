/* eslint-disable */
// Pipeline — horizontal timeline of 10 phases
const PIPELINE_PHASES = [
  { id: "script", label: "Guion", icon: "Type", model: "Gemma 4" },
  { id: "metadata", label: "Metadatos", icon: "Type", model: "Título y tags" },
  { id: "voice", label: "Voz", icon: "Mic", model: "Qwen3-TTS" },
  { id: "images", label: "Imágenes", icon: "Image", model: "Z-Image" },
  { id: "music", label: "Música", icon: "Music", model: "Local" },
  { id: "video", label: "Vídeo", icon: "Film", model: "HyperFrames" },
  { id: "engagement", label: "Engagement", icon: "Brain", model: "TRIBE v2" },
  { id: "captions", label: "Subtítulos", icon: "Captions", model: "faster-whisper" },
  { id: "thumbnail", label: "Thumbnail", icon: "Image", model: "Bilingüe" },
  { id: "upload", label: "Upload", icon: "Upload", model: "YouTube" },
];

function Pipeline({ progress, compact = false }) {
  // progress: 0–100 percent overall; map to per-node state
  const total = PIPELINE_PHASES.length;
  const exactStep = (progress / 100) * total;
  const currentIdx = Math.min(total - 1, Math.floor(exactStep));
  const currentFrac = exactStep - currentIdx;

  const nodeStates = PIPELINE_PHASES.map((_, i) => {
    if (progress >= 100) return "done";
    if (i < currentIdx) return "done";
    if (i === currentIdx && progress > 0) return "running";
    return "pending";
  });

  // Thread width = how far through track
  const threadPct = progress >= 100 ? 100 : Math.max(0, ((currentIdx + currentFrac) / (total - 1)) * 100);

  const Ico = window.Icon;

  return (
    <div className="pipeline">
      <div className="pipeline-track" style={{ position: "relative" }}>
        <div
          className="pipeline-thread"
          style={{
            width: `calc(${threadPct}% - ${threadPct === 0 ? 0 : 14}px)`,
            left: 14,
            opacity: progress > 0 ? 1 : 0,
          }}
        />
        {PIPELINE_PHASES.map((p, i) => {
          const state = nodeStates[i];
          const NodeIcon = Ico[p.icon];
          return (
            <div key={p.id} className={`pipeline-node pp-${state}`}>
              <div className="pp-circle">
                {state === "done" ? (
                  <Ico.Check size={14} />
                ) : state === "running" ? (
                  <NodeIcon size={13} />
                ) : (
                  <span>{String(i + 1).padStart(2, "0")}</span>
                )}
              </div>
              <div className="pp-label">{p.label}</div>
              {!compact && (
                <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 1 }}>
                  {p.model}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.Pipeline = Pipeline;
window.PIPELINE_PHASES = PIPELINE_PHASES;
