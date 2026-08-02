---
name: PlayOn
description: LAN control booth UI — rose stage light on matte black gear
colors:
  bg: "oklch(0.11 0 0)"
  surface: "oklch(0.16 0.012 353)"
  surface-2: "oklch(0.20 0.014 353)"
  ink: "oklch(0.96 0.012 353)"
  muted: "oklch(0.84 0.02 353)"
  placeholder: "oklch(0.72 0.02 353)"
  primary: "oklch(0.62 0.16 353)"
  primary-ink: "oklch(0.98 0.01 353)"
  accent: "oklch(0.78 0.12 185)"
  danger: "oklch(0.68 0.18 25)"
  line: "oklch(0.96 0.01 353 / 0.12)"
  focus: "oklch(0.78 0.12 185)"
  canvas-deep: "oklch(0.12 0.02 350)"
  input-bg: "oklch(0.08 0 0)"
typography:
  display:
    fontFamily: "Syne, DM Sans, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, Cascadia Code, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "8px"
  md: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  1: "0.35rem"
  2: "0.55rem"
  3: "0.85rem"
  4: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.pill}"
    padding: "0.65rem 1.1rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.65rem 1.1rem"
    height: "2.75rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "0.65rem 1.1rem"
  input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.7rem 0.85rem"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "1rem 1.1rem"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.2rem 0.55rem"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.75rem"
  nav-link-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.75rem"
---

# Design System: PlayOn

## 1. Overview

**Creative North Star: "The LAN Control Booth"**

PlayOn’s UI is a LAN control booth after midnight: matte black gear, rose stage light, cyan live indicators. It is a product tool first — dense host surfaces for same-night ops, and a calmer scan-first `/play` panel for phones. Personality stays sharp, playful, trustworthy: fun without toyish, dense without SaaS-cream.

Depth comes from tonal surface steps and hairline borders, not glass stacks or ambient drop shadows. Interaction chroma should punch like arcade hits on CTAs and live state — rose and cyan used as deliberate hits against the dark booth, not as wallpaper.

This system explicitly rejects purple-on-white AI dashboards, cream/terracotta editorial kits, neon cyberpunk glassmorphism, generic “admin admin” Bootstrap panels, and hero-metric SaaS cards.

**Key Characteristics:**
- Restrained matte surfaces; rose primary and cyan accent as high-impact hits
- Single UI family (DM Sans) with Syne reserved for the PlayOn wordmark
- Pill CTAs, 12px panels, tonal elevation (borders over shadows)
- Host booth density vs calm player panel tempo
- State-change motion only (150–220ms ease-out); reduced-motion respected

## 2. Colors

OKLCH is canonical. Rose carries brand and primary actions; cyan marks live/online/focus; neutrals stay near-black with a faint rose tint on surfaces.

### Primary
- **Stage Rose** (`oklch(0.62 0.16 353)`): Primary CTAs, brand “On” in the wordmark, high-priority action fills. Text on fills uses near-white rose ink (`oklch(0.98 0.01 353)`).

### Secondary
- **Live Cyan** (`oklch(0.78 0.12 185)`): Online/live status, selection accents, focus rings. Same token as `--focus`.

### Tertiary
- **Alert Ember** (`oklch(0.68 0.18 25)`): Danger actions and error emphasis only.

### Neutral
- **Booth Black** (`oklch(0.11 0 0)`): Page background.
- **Panel Matte** (`oklch(0.16 0.012 353)`): Panels, docks, rails.
- **Panel Lift** (`oklch(0.20 0.014 353)`): Hover/selected secondary surfaces.
- **Ink** (`oklch(0.96 0.012 353)`): Body text.
- **Muted Ink** (`oklch(0.84 0.02 353)`): Secondary text (AA on bg).
- **Placeholder Ink** (`oklch(0.72 0.02 353)`): Input placeholders.
- **Hairline** (`oklch(0.96 0.01 353 / 0.12)`): Borders and dividers.
- **Well Black** (`oklch(0.08 0 0)`): Input wells.
- **Map Deep** (`oklch(0.12 0.02 350)`): Agent canvas stage fill.

### Named Rules
**The Stage-Light Rule.** Rose and cyan are arcade hits, not atmosphere. Keep saturated color on CTAs, status, focus, and brand marks — roughly ≤10–15% of any host screen. If the whole surface glows, turn it down.

**The AA Mute Rule.** Never drop muted body text below AA against `--bg`. If it feels elegant but hard to read, brighten `--muted` toward ink.

## 3. Typography

**Display Font:** Syne (with DM Sans / system-ui fallback) — **PlayOn wordmark only**
**Body Font:** DM Sans (with system-ui fallback)
**Label/Mono Font:** system UI monospace stack for logs/code

**Character:** One tuned sans for the tool; Syne is a brand spike, never a form label or button face.

### Hierarchy
- **Display** (800, 1.5rem–2.25rem on auth, -0.03em): Brand mark only.
- **Headline** (700, ~1.375rem, -0.02em): Page titles.
- **Title** (700, 1.125rem): Panel headings.
- **Body** (400, 1rem, 1.5): Prose and chat; lede lines cap ~36–42ch.
- **Label** (600, 0.875rem): Field labels; rail labels may go 0.75rem uppercase with light tracking.
- **Mono** (400, ~0.85rem): Logs and technical strings.

### Named Rules
**The Wordmark Fence.** Syne appears only on the PlayOn mark. Buttons, nav, fields, and data stay DM Sans.

## 4. Elevation

Flat by default. Depth is tonal: `--bg` → `--surface` → `--surface-2`, plus 1px `--line` borders. Shadows are rare and never paired with a decorative border as a “ghost card.” Floating docks and rails are the same matte panels as the rest of the booth — they float by position and border, not by soft ambient blur.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 0 oklch(0.9 0.02 353 / 0.04)`): Optional micro-separator on dense rows only — not a card elevation system.

### Named Rules
**The One Edge Rule.** Use a border **or** a soft shadow for decoration — never both on the same element. Prefer border + tonal fill.

## 5. Components

Playful arcade energy lives in chroma and CTA weight; structure stays booth-tight: pills, 12px panels, dense rails.

### Buttons
- **Shape:** Full pill (`999px`); min-height 2.75rem (compact 2.25rem; bump on coarse pointers).
- **Primary:** Stage Rose fill, near-white ink, weight 700; hover brightens slightly.
- **Ghost:** Transparent + hairline border; hover → Panel Lift.
- **Danger:** Ember text/border; soft ember wash on hover.
- **Focus:** 2px Live Cyan outline, 2px offset on all interactive controls.

### Chips
- **Style:** Pill chips for roles/status; small type (~0.7–0.85rem); muted or accent-tinted fills for live state.
- **State:** Selected list rows may use a cyan-tinted border/wash (`accent` at low alpha).

### Cards / Containers
- **Corner Style:** Panels at 12px; nested controls often 10px.
- **Background:** Panel Matte; wells use Well Black.
- **Shadow Strategy:** None by default (see Elevation).
- **Border:** 1px Hairline.
- **Internal Padding:** ~1rem panel; space scale 0.35 / 0.55 / 0.85 / 1.25rem.

### Inputs / Fields
- **Style:** Well Black fill, 10px radius, hairline border, 0.7rem × 0.85rem padding.
- **Focus:** Live Cyan outline (global focus-visible).
- **Error / Disabled:** Danger color for errors; disabled at ~0.55 opacity with muted text.

### Navigation
- Top bar: brand mark + role chip + pill nav links. Active link uses Panel Lift + Ink. Utility links (Player view, Sign out) stay quieter.

### Agent Map (signature)
Full-bleed Pixi map under a matte left rail and right chat dock. Empty state centered with a real CTA. Selection and live accents use Live Cyan — never neon bloom stacks.

## 6. Do's and Don'ts

### Do:
- **Do** keep the booth dark and matte; let Stage Rose and Live Cyan land as deliberate hits.
- **Do** put conversation/map first for hosts; keep `/play` calmer and scan-first on phones.
- **Do** use pill primary CTAs and 12px panels consistently across admin surfaces.
- **Do** reserve Syne for the PlayOn wordmark only.
- **Do** animate state changes only (≈150–220ms, `--ease`); honor `prefers-reduced-motion`.
- **Do** meet WCAG AA for body/muted text and keep keyboard focus visible (cyan ring).

### Don't:
- **Don't** ship purple-on-white AI dashboards.
- **Don't** drift into cream/terracotta editorial kits.
- **Don't** use neon cyberpunk glassmorphism (blur stacks, glow soup, holographic panels).
- **Don't** fall back to generic “admin admin” Bootstrap panels.
- **Don't** use hero-metric SaaS cards as layout scaffolding.
- **Don't** pair `1px` decorative borders with wide soft drop shadows on the same element.
- **Don't** put Syne (or any display face) on buttons, labels, or data.
- **Don't** paint large surfaces in saturated rose/cyan — hits, not wallpaper.
