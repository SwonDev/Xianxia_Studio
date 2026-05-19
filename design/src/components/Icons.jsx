/* eslint-disable */
// Icons — lightweight inline SVG library
const Ico = ({ d, children, size = 18, strokeWidth = 1.6, ...rest }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

const Icon = {
  Dashboard: (p) => (
    <Ico {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Ico>
  ),
  Spark: (p) => (
    <Ico {...p}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2" />
      <circle cx="12" cy="12" r="3" />
    </Ico>
  ),
  Scissors: (p) => (
    <Ico {...p}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12L20 20M14.8 14.8L20 9.2M8.12 15.88L11 13" />
    </Ico>
  ),
  Library: (p) => (
    <Ico {...p}>
      <path d="M4 5v15M9 5v15M14 5v15M19 5v15" />
    </Ico>
  ),
  Calendar: (p) => (
    <Ico {...p}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </Ico>
  ),
  Download: (p) => (
    <Ico {...p}>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </Ico>
  ),
  Settings: (p) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Ico>
  ),
  Search: (p) => <Ico {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Ico>,
  Help: (p) => <Ico {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 1-1 1.7v.5" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></Ico>,
  Bell: (p) => <Ico {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9zM10 21h4" /></Ico>,
  Chevron: (p) => <Ico {...p}><path d="M9 6l6 6-6 6" /></Ico>,
  ChevronDown: (p) => <Ico {...p}><path d="M6 9l6 6 6-6" /></Ico>,
  Check: (p) => <Ico {...p}><path d="M5 12.5l4.5 4.5L19 7" /></Ico>,
  Plus: (p) => <Ico {...p}><path d="M12 5v14M5 12h14" /></Ico>,
  Folder: (p) => <Ico {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Ico>,
  Film: (p) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 8h18M3 16h18M8 3v18M16 3v18" /></Ico>,
  Mic: (p) => <Ico {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Ico>,
  Image: (p) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5-9 9" /></Ico>,
  Music: (p) => <Ico {...p}><path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></Ico>,
  Type: (p) => <Ico {...p}><path d="M4 7V5h16v2M9 5v14M15 5v14" /></Ico>,
  Captions: (p) => <Ico {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 13c0-1 1-2 2-2 .8 0 1.4.4 1.6 1M14 13c0-1 1-2 2-2 .8 0 1.4.4 1.6 1" /></Ico>,
  Upload: (p) => <Ico {...p}><path d="M12 15V3M7 8l5-5 5 5M5 21h14" /></Ico>,
  Brain: (p) => <Ico {...p}><path d="M12 4c-2 0-3 1.5-3 3 0 .5.1 1 .3 1.4C8.5 9 8 10 8 11c-2 .5-3 2-3 4 0 2 1.5 3.5 3.5 3.5 1 0 1.8-.4 2.5-1 .5 1 1.5 1.5 2.5 1.5s2-.5 2.5-1.5c.7.6 1.5 1 2.5 1 2 0 3.5-1.5 3.5-3.5 0-2-1-3.5-3-4 0-1-.5-2-1.3-2.6.2-.4.3-.9.3-1.4 0-1.5-1-3-3-3-1 0-2 .5-2.5 1.3C14 4.5 13 4 12 4z" /></Ico>,
  Activity: (p) => <Ico {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></Ico>,
  Power: (p) => <Ico {...p}><path d="M12 3v9" /><path d="M18.36 6.64a9 9 0 1 1-12.72 0" /></Ico>,
  Refresh: (p) => <Ico {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></Ico>,
  Cpu: (p) => <Ico {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></Ico>,
  Hardware: (p) => <Ico {...p}><rect x="3" y="3" width="18" height="6" rx="1.5" /><rect x="3" y="13" width="18" height="6" rx="1.5" /><circle cx="7" cy="6" r="0.7" fill="currentColor" /><circle cx="7" cy="16" r="0.7" fill="currentColor" /></Ico>,
  Database: (p) => <Ico {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" /></Ico>,
  Shield: (p) => <Ico {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></Ico>,
  Sparkles: (p) => (
    <Ico {...p}>
      <path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
      <path d="M9 12l3-3 3 3-3 3z" />
    </Ico>
  ),
  Play: (p) => <Ico {...p}><path d="M6 4v16l13-8z" fill="currentColor" stroke="none" /></Ico>,
  Globe: (p) => <Ico {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Ico>,
  Layers: (p) => <Ico {...p}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5M3 18l9 5 9-5" /></Ico>,
  Box: (p) => <Ico {...p}><path d="M3 7l9 5 9-5M12 12v10M3 7v10l9 5 9-5V7L12 2z" /></Ico>,
  ChevronRight: (p) => <Ico {...p}><path d="M9 6l6 6-6 6" /></Ico>,
  X: (p) => <Ico {...p}><path d="M18 6L6 18M6 6l12 12" /></Ico>,
  Eye: (p) => <Ico {...p}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></Ico>,
  Volume: (p) => <Ico {...p}><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></Ico>,
  YouTube: (p) => <Ico {...p}><rect x="2" y="6" width="20" height="12" rx="3" /><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" /></Ico>,
};

window.Icon = Icon;
