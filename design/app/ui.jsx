// Common UI primitives

const Button = ({ variant = "primary", size, icon, children, onClick, ...rest }) => {
  const Icon = icon ? Icons[icon] : null;
  return (
    <button
      className={`btn btn-${variant}${size === "lg" ? " btn-lg" : ""}`}
      onClick={onClick}
      {...rest}
    >
      {Icon && <Icon />}
      {children}
    </button>
  );
};

const Pill = ({ tone = "neutral", icon, dot, children }) => {
  const cls = `pill${tone !== "neutral" ? ` pill-${tone}` : ""}${dot ? " pill-dot" : ""}`;
  const Icon = icon ? Icons[icon] : null;
  return (
    <span className={cls}>
      {Icon && <Icon />}
      {children}
    </span>
  );
};

const Card = ({ elevated, interactive, padding, children, onClick, style }) => (
  <div
    className={`card${elevated ? " card-elevated" : ""}${interactive ? " card-interactive" : ""}`}
    onClick={onClick}
    style={{ padding: padding ?? undefined, ...style }}
  >
    {children}
  </div>
);

// SegmentedControl — animated indicator slides to active tab
const Segmented = ({ value, onChange, items }) => {
  const ref = React.useRef(null);
  const [indicator, setIndicator] = React.useState({ x: 0, w: 0 });

  React.useEffect(() => {
    if (!ref.current) return;
    const btn = ref.current.querySelector(`[data-seg="${value}"]`);
    if (btn) {
      const containerRect = ref.current.getBoundingClientRect();
      const rect = btn.getBoundingClientRect();
      setIndicator({
        x: rect.left - containerRect.left,
        w: rect.width,
      });
    }
  }, [value, items]);

  return (
    <div ref={ref} className="topbar-segment">
      <div
        className="topbar-segment-indicator"
        style={{ transform: `translateX(${indicator.x - 3}px)`, width: `${indicator.w}px` }}
      />
      {items.map((it) => {
        const Icon = it.icon ? Icons[it.icon] : null;
        return (
          <button
            key={it.value}
            data-seg={it.value}
            className={`topbar-segment-btn${value === it.value ? " is-active" : ""}`}
            onClick={() => onChange(it.value)}
          >
            {Icon && <Icon />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
};

// Thumb placeholder — abstract gradient + glyph
const Thumbnail = ({ kind, size = "md" }) => {
  const palettes = {
    lotus:  ["#5a3a78", "#c43c4b"],
    sword:  ["#1b4332", "#52b788"],
    monk:   ["#806829", "#e8c96d"],
    mount:  ["#1c1c26", "#3a3a48"],
    scroll: ["#2a1f0e", "#a88a3c"],
    moon:   ["#0f1a2e", "#74c69d"],
    default:["#1c1c26", "#3a3a48"],
  };
  const [c1, c2] = palettes[kind] || palettes.default;
  const dim = size === "sm" ? 40 : size === "lg" ? 220 : 72;
  return (
    <div
      style={{
        width: dim, height: dim * (9/16),
        borderRadius: size === "lg" ? 10 : 6,
        background: `radial-gradient(120% 80% at 30% 20%, ${c1}, ${c2})`,
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: "0 0 0 0.5px rgba(255,255,255,0.06) inset",
      }}
    >
      <div style={{
        position: "absolute", inset: 0,
        background:
          "radial-gradient(circle at 70% 70%, rgba(255,255,255,0.10), transparent 50%)," +
          "radial-gradient(circle at 30% 80%, rgba(0,0,0,0.4), transparent 60%)",
      }}/>
      <div style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-display)",
        fontSize: size === "lg" ? 36 : 14,
        color: "rgba(232, 232, 240, 0.42)",
        fontStyle: "italic",
        letterSpacing: "0.04em",
      }}>
        {kind === "lotus" && "蓮"}
        {kind === "sword" && "劍"}
        {kind === "monk" && "僧"}
        {kind === "mount" && "山"}
        {kind === "scroll" && "卷"}
        {kind === "moon" && "月"}
      </div>
    </div>
  );
};

// Animated number that counts up
const useCountUp = (target, duration = 900) => {
  const [val, setVal] = React.useState(0);
  React.useEffect(() => {
    let raf, start;
    const step = (ts) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
};

const CountUp = ({ to, suffix }) => {
  const v = useCountUp(to);
  return <span>{v.toLocaleString("es-ES")}{suffix}</span>;
};

// Toggle
const Toggle = ({ checked, onChange }) => (
  <button
    onClick={() => onChange(!checked)}
    style={{
      width: 34, height: 20, padding: 0,
      borderRadius: 999,
      background: checked
        ? "linear-gradient(180deg, var(--gold-400), var(--gold-600))"
        : "rgba(255,255,255,0.08)",
      position: "relative",
      transition: "background 200ms var(--ease-std)",
      boxShadow: checked ? "0 0 12px rgba(201,168,76,calc(0.4 * var(--glow-strength)))" : "0 0 0 0.5px rgba(255,255,255,0.06) inset",
    }}
  >
    <span style={{
      position: "absolute",
      top: 2, left: checked ? 16 : 2,
      width: 16, height: 16,
      borderRadius: 999,
      background: checked ? "var(--obsidian-950)" : "var(--paper-200)",
      transition: "left 200ms var(--ease-spring)",
      boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
    }}/>
  </button>
);

// Status dot
const StatusDot = ({ state = "running" }) => {
  const map = {
    running: "var(--jade-400)",
    idle: "var(--gold-400)",
    missing: "var(--paper-400)",
    error: "var(--crimson-400)",
  };
  const color = map[state] || map.running;
  return (
    <span style={{
      width: 7, height: 7, borderRadius: 999,
      background: color,
      boxShadow: state === "running"
        ? `0 0 0 2.5px ${color}26, 0 0 6px ${color}99`
        : `0 0 0 2.5px ${color}1f`,
      display: "inline-block",
      flexShrink: 0,
    }}/>
  );
};

Object.assign(window, { Button, Pill, Card, Segmented, Thumbnail, CountUp, useCountUp, Toggle, StatusDot });
