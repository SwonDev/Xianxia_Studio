// Mac-style line icons — 1.6px stroke, 24px viewBox
const Icon = ({ d, children, style }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style}>
    {children || <path d={d} />}
  </svg>
);

const Icons = {
  Home: () => <Icon><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" /></Icon>,
  Sparkles: () => <Icon><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2" /><circle cx="12" cy="12" r="3" /></Icon>,
  Scissors: () => <Icon><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8 8.5 20 17M8 15.5 20 7" /></Icon>,
  Library: () => <Icon><rect x="4" y="4" width="3.5" height="16" rx="1" /><rect x="9.5" y="4" width="3.5" height="16" rx="1" /><path d="M16 5.5l4 1.2-3 14.5-4-1.1Z" /></Icon>,
  Calendar: () => <Icon><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2" /></Icon>,
  Settings: () => <Icon><circle cx="12" cy="12" r="2.8" /><path d="M19.4 14.4a1.5 1.5 0 0 0 .3 1.6l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.5 1.5 0 0 0-1.6-.3 1.5 1.5 0 0 0-.9 1.4V20a1.7 1.7 0 1 1-3.4 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.6.3l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.5 1.5 0 0 0 .3-1.6 1.5 1.5 0 0 0-1.4-.9H4a1.7 1.7 0 1 1 0-3.4h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.6l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.5 1.5 0 0 0 1.6.3h.1a1.5 1.5 0 0 0 .9-1.4V4a1.7 1.7 0 1 1 3.4 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.6-.3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.5 1.5 0 0 0-.3 1.6v.1a1.5 1.5 0 0 0 1.4.9H20a1.7 1.7 0 1 1 0 3.4h-.1a1.5 1.5 0 0 0-1.4.9Z" /></Icon>,
  Download: () => <Icon><path d="M12 4v12M7 12l5 5 5-5M4 20h16" /></Icon>,
  Play: () => <Icon><path d="M7 4.5v15l13-7.5Z" /></Icon>,
  Pause: () => <Icon><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Icon>,
  Plus: () => <Icon><path d="M12 5v14M5 12h14" /></Icon>,
  Search: () => <Icon><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.5-3.5" /></Icon>,
  ChevronRight: () => <Icon><path d="m9 6 6 6-6 6" /></Icon>,
  ChevronDown: () => <Icon><path d="m6 9 6 6 6-6" /></Icon>,
  ChevronLeft: () => <Icon><path d="m15 6-6 6 6 6" /></Icon>,
  Check: () => <Icon><path d="m5 12 5 5L20 7" /></Icon>,
  X: () => <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>,
  Bell: () => <Icon><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" /></Icon>,
  Cpu: () => <Icon><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 1.5v3.5M15 1.5v3.5M9 19v3.5M15 19v3.5M1.5 9H5M1.5 15H5M19 9h3.5M19 15h3.5" /></Icon>,
  Memory: () => <Icon><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 11v2M11 11v2M15 11v2M19 11v2" /></Icon>,
  Folder: () => <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>,
  Upload: () => <Icon><path d="M12 20V8M7 12l5-5 5 5M4 4h16" /></Icon>,
  Mic: () => <Icon><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>,
  Image: () => <Icon><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 4" /></Icon>,
  Music: () => <Icon><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></Icon>,
  Captions: () => <Icon><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M7 11.5h3M7 14.5h3M13 11.5h4M13 14.5h4" /></Icon>,
  Film: () => <Icon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 15h18M8 4v16M16 4v16" /></Icon>,
  Bolt: () => <Icon><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></Icon>,
  Trash: () => <Icon><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /></Icon>,
  More: () => <Icon><circle cx="12" cy="6" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="18" r="1.2" /></Icon>,
  Eye: () => <Icon><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>,
  Edit: () => <Icon><path d="M14 4 4 14v6h6L20 10ZM12.5 5.5l6 6" /></Icon>,
  Refresh: () => <Icon><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 4v4h-4M21 12a9 9 0 0 1-15.5 6.3L3 16M3 20v-4h4" /></Icon>,
  Brain: () => <Icon><path d="M9 5a3 3 0 0 0-3 3v.5a3 3 0 0 0-2 2.8c0 1.1.6 2 1.5 2.5-.3.4-.5 1-.5 1.7a3 3 0 0 0 4 2.8V19a3 3 0 0 0 6 0V8a3 3 0 0 0-3-3 3 3 0 0 0-3 0Z" /><path d="M15 5a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 2.8c0 1.1-.6 2-1.5 2.5.3.4.5 1 .5 1.7a3 3 0 0 1-4 2.8" /></Icon>,
  Sliders: () => <Icon><path d="M4 7h7M16 7h4M4 17h4M13 17h7" /><circle cx="13" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>,
  Globe: () => <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>,
  Wifi: () => <Icon><path d="M2 8.5a14 14 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></Icon>,
  Shield: () => <Icon><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" /></Icon>,
  Activity: () => <Icon><path d="M3 12h4l3-7 4 14 3-7h4" /></Icon>,
  Layers: () => <Icon><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 13 9 5 9-5M3 18l9 5 9-5" /></Icon>,
  Clock: () => <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>,
  Sun: () => <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></Icon>,
  Moon: () => <Icon><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" /></Icon>,
  YouTube: () => <Icon><rect x="2.5" y="5.5" width="19" height="13" rx="3" /><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" /></Icon>,
  Wand: () => <Icon><path d="m3 21 12-12M14 6l4 4M16 4l1 1M17 5l-1-1M18 4l1 1M21 3v0M19 2l1 1M20 1l1 1" /></Icon>,
};

window.Icons = Icons;
