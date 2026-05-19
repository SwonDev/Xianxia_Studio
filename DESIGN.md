---
name: Xianxia Studio
description: Sistema de diseño "Liquid Glass" — estética macOS / iOS 26 nativa, dark, vidrio translúcido. Acento Oro champaña sobre lienzo grafito azulado (sin verde). Base /design + ajustes de paleta v0.3.1.
version: 2.1.0
supersedes: 2.0.0 (acento Jade Imperial verde + lienzo verdoso — el usuario lo descartó; reemplazado por Oro champaña sobre grafito azulado, status azul, en v0.3.1)
colors:
  primitive:
    bg-base: "#15151c"       # grafito azulado (gama del modal de búsqueda)
    bg-window: "#1a1a22"
    accent: "#d4b85a"        # Oro champaña — PRIMARIO (sin jade)
    accent-soft: "#e8c96d"
    accent-deep: "#a88a3c"
    gold: "#d4b85a"
    gold-soft: "#e8c96d"
    gold-deep: "#a88a3c"
    nephrite: "#7a8a8a"      # Nefrita gris — utilitario técnico
    nephrite-soft: "#a8b5b5"
    nephrite-deep: "#4d5c5c"
    status-ok: "#7fa8d8"     # azul sereno = running/ok (NO verde — contrasta con el oro)
    red: "#c8525e"
  semantic:
    text-primary: "rgba(255,255,255,0.95)"
    text-secondary: "rgba(255,255,255,0.60)"
    text-tertiary: "rgba(255,255,255,0.40)"
    text-quaternary: "rgba(255,255,255,0.22)"
    glass-sidebar: "rgba(26,26,32,0.36)"
    glass-toolbar: "rgba(28,28,34,0.36)"
    glass-card: "rgba(255,255,255,0.055)"
    glass-card-strong: "rgba(255,255,255,0.10)"
    bg-input: "rgba(0,0,0,0.26)"
    bg-popover: "rgba(22,22,28,0.985)"   # overlays casi opacos (WebView2: backdrop-filter no opacifica sobre <main> scrolleable)
    hairline: "rgba(255,255,255,0.07)"
    separator: "rgba(255,255,255,0.06)"
    accent-bg: "rgba(212,184,90,0.20)"
    gold-bg: "rgba(212,184,90,0.18)"
typography:
  display: '"EB Garamond", Georgia, serif'
  ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif'
  mono: '"SF Mono", "JetBrains Mono", "Menlo", monospace'
  base-size: "13px"
  scale:
    title-l: "22px / 600 / -0.015em"
    title: "15px / 600 / -0.01em"
    section-header: "18px / 600 / -0.01em"
    body: "13px"
    caption: "11px"
    mono: "11px"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  pill: "999px"
spacing:
  base: "4px"
  sidebar-w: "232px"
  sidebar-rail: "64px"
  toolbar-h: "56px"
  page-pad: "28px 32px 56px"
  page-max: "900px"
effects:
  ease: "cubic-bezier(0.4, 0, 0.2, 1)"
  ease-spring: "cubic-bezier(0.16, 1, 0.3, 1)"
  backdrop: "blur(60px) saturate(190%)"
  shadow-glass: "inset rims + 0 0 0 0.5px rgba(255,255,255,.10) + 0 4px 14px rgba(0,0,0,.22)"
  shadow-popover: "0 32px 80px -16px rgba(0,0,0,.78) + inset rims"
components:
  - btn-primary
  - btn
  - btn-ghost
  - btn-destructive
  - segmented
  - toggle
  - range
  - input
  - group / row
  - lg-tile
  - chip
  - kbd
  - dot
icons: "Phosphor Icons (@phosphor-icons/react) — regular/fill/duotone"
---

## Overview

Rediseño nativo macOS / iOS 26 "Liquid Glass" para Xianxia Studio. Lienzo
oscuro profundo (`#06120e`) con washes radiales jade + oro fijos; toda la UI
flota en superficies de vidrio translúcido con `backdrop-filter`, rim lights
y sombras de gema. Acento primario **Jade Imperial `#2eb189`** (玉), secundario
**Oro champaña `#d4b85a`** (regalia), utilitario **Nefrita gris**. La fuente de
verdad visual es el prototipo en `/design` (Claude Design); este documento es
el contrato de tokens que la implementación consume literalmente.

## Colors

Fondo del documento: gradientes radiales superpuestos (jade 28% arriba-izq,
oro 16% abajo-der, verde profundo, jade claro, oro tenue) sobre `#06120e`,
`background-attachment: fixed`. Las tarjetas usan blanco translúcido
(`glass-card` 5.5%) con `backdrop-filter: blur(60px) saturate(190%)`. Texto en
blanco a 95/60/40/22 % de opacidad (jerarquía por opacidad, no por color).
Estados: verde `#82c8a3`, rojo `#c8525e`, idle = oro suave. El texto primario
(95% sobre fondo oscuro) supera 4.5:1; los secundarios solo para texto de
apoyo a tamaño body o mayor.

## Typography

EB Garamond (serif display) para títulos de página, números de héroe y el
input del command palette. Inter / SF Pro para toda la UI (base 13px,
`letter-spacing: -0.003em`). JetBrains Mono / SF Mono para datos técnicos,
tokens, kbd. Escala: title-l 22/600, section-header 18/600, title 15/600,
body 13, caption/mono 11.

## Layout

Shell tipo ventana macOS: Sidebar vidrio (232px completa / 64px rail) +
columna con Topbar (56px: traffic-lights + breadcrumb + estado servicios +
⌘K) + `main` scrollable. Contenedor de página `.page`: max 900px centrado,
padding `28px 32px 56px`. Listas agrupadas inset (`.group`/`.row`) estilo
Ajustes de iOS. Overlays glass: Command Palette (⌘K), atajos (⇧?), wizard de
clonado de voz, A/B compare, onboarding, popover de sistema.

## Elevation & Depth

Profundidad por vidrio + rim, no por sombra plana: cada superficie lleva
`inset` rim-top (luz) + rim-bottom (sombra) + hairline 0.5px + sombra
ambiental. Botones y thumbs son "gemas": gradiente + pseudo-elemento
especular superior + caustic inferior con `mix-blend-mode: screen`.

## Shapes

Radios 6/10/14/18px; controles y botones son cápsulas (`999px`). Azulejos de
icono `lg-tile` 6–10px con tinte por variable `--tint`.

## Components

Definidos verbatim en `/design/styles.css` (≈768 líneas) — se portan a
`apps/desktop/src/styles/globals.css` como clases semánticas (NO utilidades
Tailwind; el sistema es CSS plano bespoke con pseudo-elementos y
backdrop-filter). Las pantallas en `/design/screens` y el chrome en
`/design/shell.jsx` son la referencia estructural; se portan a las rutas
TanStack reales preservando hooks, `pipelineStore` e IPC Tauri.

## Do's and Don'ts

- DO consumir los tokens de este contrato literalmente; el prototipo `/design` manda.
- DO preservar TODO el cableado funcional (rutas, store, Tauri IPC, backend) — solo cambia la capa visual.
- DO usar Phosphor Icons; nunca emojis como iconos.
- DON'T introducir utilidades Tailwind nuevas para la UI del rediseño — usar las clases del sistema.
- DON'T tocar el supervisor Rust ni el sidecar Python: el rediseño es exclusivamente frontend.
- DON'T portar el `TweaksPanel` ni los datos demo de `/design` (tooling de diseño).
