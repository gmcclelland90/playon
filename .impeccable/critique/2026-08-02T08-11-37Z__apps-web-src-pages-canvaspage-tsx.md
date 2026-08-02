---
target: CanvasPage+AgentCanvas
total_score: 30
p0_count: 0
p1_count: 0
timestamp: 2026-08-02T08-11-37Z
slug: apps-web-src-pages-canvaspage-tsx
---
# Critique — Map + AgentCanvas

Method: dual-agent (A: 9fddfa4e · B: b0ebd4eb) then re-critique A: 699fd215 after fixes

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Live chip, crate status·busy, loading≠empty, dock busy |
| 2 | Match System / Real World | 3 | Booth language; shortPersona still terse |
| 3 | User Control and Freedom | 3 | Esc deny + focus Approve; no map home |
| 4 | Consistency and Standards | 3 | Tabs + tokens aligned |
| 5 | Error Prevention | 3 | Always-allow buried; delete confirm |
| 6 | Recognition Rather Than Recall | 3 | Pan/zoom hint; join copy |
| 7 | Flexibility and Efficiency | 3 | Join copy; Enter send; rail arrows |
| 8 | Aesthetic and Minimalist Design | 3 | Progressive disclosure; honest cast |
| 9 | Error Recovery | 3 | Errors surface with retry |
| 10 | Help and Documentation | 2 | Contextual crumbs only |
| **Total** | | **30/40** | **Good — gate met** |

## Anti-Patterns Verdict
Not AI-slop. Detector clean (`[]`). Browser overlay unavailable (BROWSER_MUTATION_UNAVAILABLE).

## Priority Issues (post-fix)
None P0/P1 remaining for gate. Optional P2: map reset, ring legend.

## Fixes applied
- reduced-motion Pixi snap
- persona color + phase ring
- no fake cast; idle hide when busy
- desktop Chat/Controls tabs; join/status in head
- confirm hierarchy + Esc/focus
- loading map state; join Copy; pan/zoom hint; live chip
