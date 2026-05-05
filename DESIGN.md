---
name: Xianxia Studio
description: Sistema de diseño "Celestial Dark" — estética xianxia cinematográfica con negros profundos, oro y jade
version: 1.0.0
colors:
  primitive:
    obsidian-950: "#0a0a0f"
    obsidian-900: "#13131a"
    obsidian-800: "#1c1c26"
    obsidian-700: "#2a2a35"
    gold-300: "#e8c96d"
    gold-400: "#d4b85a"
    gold-500: "#c9a84c"
    gold-600: "#a88a3c"
    jade-300: "#74c69d"
    jade-400: "#52b788"
    jade-500: "#40916c"
    jade-600: "#2d6a4f"
    jade-700: "#1b4332"
    crimson-500: "#9d2933"
    crimson-400: "#c43c4b"
    paper-50: "#f5f5f0"
    paper-100: "#e8e8f0"
    paper-200: "#cfcfdc"
    paper-300: "#9a9aa8"
    paper-400: "#6b6b78"
  semantic:
    bg-base: "#0a0a0f"
    bg-surface: "#13131a"
    bg-elevated: "#1c1c26"
    bg-overlay: "rgba(10,10,15,0.85)"
    border-subtle: "#2a2a35"
    border-default: "#3a3a48"
    text-primary: "#e8e8f0"
    text-secondary: "#9a9aa8"
    text-muted: "#6b6b78"
    text-inverse: "#0a0a0f"
    accent-primary: "#c9a84c"
    accent-primary-hover: "#e8c96d"
    accent-primary-active: "#a88a3c"
    accent-secondary: "#52b788"
    accent-secondary-hover: "#74c69d"
    success: "#52b788"
    warning: "#e8c96d"
    danger: "#c43c4b"
    info: "#74c69d"
    focus-ring: "#c9a84c"
typography:
  fonts:
    display: '"EB Garamond", "Noto Serif SC", Georgia, serif'
    body: '"Plus Jakarta Sans", "Noto Sans SC", system-ui, sans-serif'
    mono: '"JetBrains Mono", "Fira Code", monospace'
  scale:
    xs: 0.75rem      # 12 — captions, labels
    sm: 0.875rem     # 14 — secondary body
    base: 1rem       # 16 — body
    lg: 1.125rem     # 18 — emphasis body
    xl: 1.25rem      # 20 — small headings
    "2xl": 1.5rem    # 24 — section headings
    "3xl": 1.875rem  # 30 — page titles
    "4xl": 2.5rem    # 40 — hero
    "5xl": 3.5rem    # 56 — display
  weight:
    regular: 400
    medium: 500
    semibold: 600
    bold: 700
  line-height:
    tight: 1.15
    snug: 1.35
    normal: 1.55
    relaxed: 1.7
spacing:
  base: 4px
  scale: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128]
rounded:
  none: 0
  sm: 4px
  md: 8px
  lg: 12px
  xl: 20px
  "2xl": 28px
  full: 9999px
elevation:
  none: none
  sm: "0 1px 2px rgba(0,0,0,0.4)"
  md: "0 4px 12px rgba(0,0,0,0.45), 0 0 1px rgba(201,168,76,0.08)"
  lg: "0 12px 28px rgba(0,0,0,0.55), 0 0 1px rgba(201,168,76,0.12)"
  glow-gold: "0 0 24px rgba(201,168,76,0.35)"
  glow-jade: "0 0 24px rgba(82,183,136,0.35)"
motion:
  easing:
    standard: "cubic-bezier(0.4, 0, 0.2, 1)"
    cinematic: "cubic-bezier(0.16, 1, 0.3, 1)"
    bounce: "cubic-bezier(0.34, 1.56, 0.64, 1)"
  duration:
    instant: 80ms
    fast: 150ms
    base: 240ms
    slow: 400ms
    cinematic: 720ms
components:
  button:
    primary: "bg-gold-500 text-obsidian-950 hover:bg-gold-300 active:bg-gold-600 rounded-md px-4 py-2 font-medium transition-all duration-fast shadow-glow-gold"
    secondary: "bg-obsidian-800 text-paper-100 border border-border-default hover:border-gold-500 rounded-md px-4 py-2"
    ghost: "text-paper-200 hover:text-gold-300 hover:bg-obsidian-800 rounded-md px-3 py-2"
    danger: "bg-crimson-500 text-paper-50 hover:bg-crimson-400 rounded-md px-4 py-2"
  card:
    default: "bg-bg-surface border border-border-subtle rounded-lg p-6 shadow-md"
    elevated: "bg-bg-elevated border border-border-default rounded-xl p-8 shadow-lg"
    interactive: "bg-bg-surface border border-border-subtle hover:border-gold-500 hover:shadow-glow-gold transition-all duration-base rounded-lg p-6 cursor-pointer"
  input:
    default: "bg-obsidian-800 border border-border-default text-paper-100 rounded-md px-3 py-2 focus:border-gold-500 focus:ring-2 focus:ring-gold-500/20"
  badge:
    status-draft: "bg-obsidian-700 text-paper-300"
    status-generating: "bg-gold-500/20 text-gold-300 border border-gold-500/40"
    status-ready: "bg-jade-500/20 text-jade-300 border border-jade-500/40"
    status-published: "bg-jade-600 text-paper-50"
    status-failed: "bg-crimson-500/20 text-crimson-400 border border-crimson-500/40"
---

# Xianxia Studio — Design System

## Overview

Xianxia Studio adopts a **Celestial Dark** aesthetic inspired by Chinese xianxia/wuxia cinema: deep obsidian backgrounds layered with golden accents and jade highlights. The system favors elegance over brightness, restraint over decoration. Every surface should feel like a temple at dusk — composed, precise, with rare flashes of light that draw the eye to action.

The palette is intentionally restrained: a base of three near-black neutrals carries the structure, while gold and jade act as semantic accents. Crimson appears only for destructive actions and critical errors. Paper-toned text replaces stark white to reduce eye strain over long production sessions.

## Colors

### Background and surfaces
- `bg-base` (#0a0a0f) — outermost canvas, sidebars, modals scrim
- `bg-surface` (#13131a) — primary content panels, cards
- `bg-elevated` (#1c1c26) — popovers, dialogs, hovered surfaces
- `border-subtle` (#2a2a35) — dividers, default card borders
- `border-default` (#3a3a48) — inputs, interactive borders

### Accent system
- **Gold** is the primary brand color. Use `gold-500` (#c9a84c) for primary CTAs, active states, focus rings, and the Qi particles in motion. `gold-300` (#e8c96d) is the hover state — a brighter, more luminous gold that suggests heightened spiritual energy.
- **Jade** is the secondary accent, reserved for success states, secondary CTAs, progress indicators, and "ready" badges. `jade-400` (#52b788) is the working tone; `jade-600` (#2d6a4f) is for deep accents like progress bars and inactive jade tones.
- **Crimson** is the danger signal. Used sparingly for destructive actions, critical errors, and the "failed" status badge. Never decorative.

### Text
- `text-primary` (#e8e8f0) — paper-toned, never pure white. Body and headings.
- `text-secondary` (#9a9aa8) — meta info, captions, secondary labels.
- `text-muted` (#6b6b78) — disabled states, placeholder hints.

### Contrast (WCAG AA verified)
- `text-primary` on `bg-base`: 14.8:1 ✅ AAA
- `text-primary` on `bg-surface`: 13.1:1 ✅ AAA
- `text-secondary` on `bg-base`: 6.2:1 ✅ AA
- `gold-500` on `bg-base`: 8.9:1 ✅ AAA
- `gold-300` on `bg-base`: 12.4:1 ✅ AAA
- `jade-400` on `bg-base`: 7.4:1 ✅ AAA
- `obsidian-950` on `gold-500`: 8.9:1 ✅ AAA (text on primary buttons)

## Typography

**EB Garamond** carries display work — page titles, section headings, decorative quotes. Its calligraphic ductus echoes traditional Chinese seal script when paired with `Noto Serif SC` as fallback for Chinese characters.

**Plus Jakarta Sans** handles all body, UI labels, buttons, and form elements. Modern, geometric, but with enough warmth to feel handcrafted. Pair with `Noto Sans SC` for CJK glyphs.

**JetBrains Mono** appears only in code views, log viewers, and technical diagnostics.

### Hierarchy rules
- Display (5xl-4xl, EB Garamond) — hero/landing only
- Page title (3xl, EB Garamond medium)
- Section heading (2xl-xl, Plus Jakarta semibold)
- Card heading (lg, Plus Jakarta semibold)
- Body (base, Plus Jakarta regular)
- Caption (sm, Plus Jakarta regular, text-secondary)
- Microcopy (xs, Plus Jakarta medium uppercase tracking-wider)

## Layout

8-point grid throughout. Major containers max-width 1280px on desktop, never edge-to-edge except for the immersive Generator wizard which uses the full viewport.

Sidebar: 240px collapsible to 64px. Topbar: 56px. Content padding: 32px desktop, 16px mobile.

## Elevation & Depth

Xianxia Studio uses **two complementary elevation systems**:

1. **Traditional shadow elevation** for spatial hierarchy (md, lg) — soft, near-black with a faint gold inner highlight.
2. **Glow elevation** (`glow-gold`, `glow-jade`) for stateful emphasis — never structural. A primary button glows softly; a hovered card glows briefly. Glow conveys "this is alive, charged with Qi."

Never combine glow and heavy shadow on the same element.

## Shapes

- Buttons, badges, inputs: `rounded-md` (8px) — confident but not playful
- Cards: `rounded-lg` (12px)
- Hero panels and dialogs: `rounded-xl` (20px)
- Avatars, pills, tags: `rounded-full`
- Sharp corners only inside data tables and code blocks

## Components

### Buttons
- **Primary**: gold background, obsidian text. Always carries `glow-gold`. Reserved for the most important action per screen (Generate, Publish, Save).
- **Secondary**: obsidian surface with default border, subtle hover via gold border ramp.
- **Ghost**: text-only with hover background. For nav, secondary actions in tables.
- **Danger**: crimson, used only for destructive operations.

### Cards
Three variants: `default` (static info), `elevated` (key panels in Generator), `interactive` (clickable items in Library).

### Status badges
Color-coded by project status. Use semantic tokens, never raw hex.

### Inputs
Always paired with a label above. Focus state: gold border + 2px ring at 20% opacity. Errors: crimson border + helper text below.

### Qi particle background
Canvas overlay rendered behind main content. Density: 30 particles desktop, 12 mobile. Particles drift upward at 8-15px/s, opacity 0.15-0.35, size 1-3px, gold tint. Never animated when `prefers-reduced-motion: reduce`.

## Motion

- **Standard transitions** (150-240ms) for hover, focus, color changes — `easing-standard`.
- **Cinematic transitions** (400-720ms) for page transitions, modal entry, wizard step changes — `easing-cinematic` (slow start, gentle finish).
- **Bounce** reserved for success confirmations — never on routine interactions.

All motion respects `prefers-reduced-motion: reduce` — fade only, no transforms.

## Do's and Don'ts

### Do
- Use gold sparingly. One primary CTA per screen.
- Pair gold with jade for compound states (e.g. progress bar: gold fill on jade track).
- Let surfaces breathe. Generous padding (24-32px) inside cards.
- Render Qi particles low-opacity, low-density. They are atmosphere, not focus.
- Use EB Garamond for decorative pull-quotes in onboarding/empty states.

### Don't
- Don't use pure black (#000) anywhere. Always `obsidian-950`.
- Don't use pure white (#fff) text. Always `paper-100`.
- Don't put gold on jade or jade on gold for text — terrible contrast.
- Don't add drop shadows AND glow on the same element.
- Don't animate the Qi particles when reduced motion is set.
- Don't use crimson decoratively. It signals danger.
- Don't render Chinese text in EB Garamond — switch to Noto Serif SC.
