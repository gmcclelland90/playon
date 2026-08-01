# PlayOn Design

## Mood
LAN control booth after midnight — rose stage light on matte black gear.

## Color strategy
Restrained product UI; primary rose used for CTAs and brand marks ≤10–15% of surface. Accent cyan for live/online state.

## Palette (OKLCH)

```css
--bg: oklch(0.11 0 0);
--surface: oklch(0.16 0.012 353);
--surface-2: oklch(0.20 0.014 353);
--ink: oklch(0.96 0.012 353);
--muted: oklch(0.82 0.02 353);
--primary: oklch(0.62 0.16 353);
--accent: oklch(0.78 0.12 185);
--danger: oklch(0.68 0.18 25);
--line: oklch(0.96 0.01 353 / 0.12);
--focus: oklch(0.78 0.12 185);
```

Text on primary fills: near-white. Body contrast ≥7:1 on `--bg`.

## Typography
Single family: **DM Sans** (UI). Brand wordmark may use **Syne** only for the PlayOn mark — never for form labels or buttons.

Scale (rem): 0.75 / 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25

## Layout
App shell: top bar + main workspace. Chat is primary; side rail for nodes/servers/settings. Player panel is a separate calm route — scan-first, mobile-first.

## Motion
150–220ms ease-out state changes only. No page-load choreography. Respect reduced motion.

## Components
Consistent pill CTAs, 12px radius panels (not 24+), one border OR one soft shadow (never both), semantic status colors via accent/danger.
