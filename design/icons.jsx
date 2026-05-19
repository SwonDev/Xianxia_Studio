/* eslint-disable */
// Phosphor icons — loaded via CDN. Wrapper keeps the old <I.Name/> API working.

function Ph({ name, size = 16, weight = "regular", color, style = {}, className = "", ...rest }) {
  const cls = weight === "regular" ? "ph" : `ph-${weight}`;
  return (
    <i
      className={`${cls} ph-${name} ${className}`}
      style={{ fontSize: size, color, lineHeight: 1, display: "inline-flex", ...style }}
      {...rest}
    />
  );
}

// Map of the names used across the app → Phosphor icon slugs
const PH_MAP = {
  Home:        "house",
  Sparkles:    "sparkle",
  Scissors:    "scissors",
  Library:     "books",
  Calendar:    "calendar-dots",
  Settings:    "gear-six",
  Download:    "download-simple",
  Search:      "magnifying-glass",
  Bell:        "bell",
  Chevron:     "caret-right",
  ChevronDown: "caret-down",
  Plus:        "plus",
  Check:       "check",
  X:           "x",
  Activity:    "waveform",
  Cpu:         "cpu",
  HardDrive:   "hard-drives",
  Type:        "text-t",
  Volume:      "speaker-high",
  Image:       "image",
  Music:       "music-notes",
  Film:        "film-strip",
  Layout:      "layout",
  Captions:    "closed-captioning",
  Upload:      "upload-simple",
  Clock:       "clock",
  Play:        "play",
  Pause:       "pause",
  Pencil:      "pencil-simple",
  Trash:       "trash",
  Folder:      "folder",
  Bot:         "robot",
  Youtube:     "youtube-logo",
  Shield:      "shield",
  Bolt:        "lightning",
  Info:        "info",
  Warning:     "warning",
  Eye:         "eye",
  Filter:      "funnel",
  Globe:       "globe",
  Mic:         "microphone",
  Wand:        "magic-wand",
  Help:        "question",
  Brain:       "brain",
  Refresh:     "arrows-clockwise",
  External:    "arrow-square-out",
};

const I = Object.fromEntries(
  Object.entries(PH_MAP).map(([k, v]) => [
    k,
    (props) => <Ph name={v} {...props}/>,
  ])
);

// Phosphor sets a viewBox; ignore stroke-width / strokeLinecap props
I.Logo = ({ size = 28 }) => (
  <span className="lg-tile" style={{
    "--tint": "#2eb189",
    width: size, height: size,
    borderRadius: size > 26 ? 8 : 7,
  }}>
    <Ph name="yin-yang" size={size * 0.62} weight="fill"/>
  </span>
);

Object.assign(window, { I, Ph });
