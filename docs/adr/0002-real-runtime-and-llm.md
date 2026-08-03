# ADR 0002 — Real runtime and LLM only

## Status

Accepted (supersedes ADR-0001 mock CI wording for production/lab)

## Context

ADR-0001 sketched injectable mock LLM and mock Docker/process adapters for fast CI. Autonomy rules for PlayOn now require truthful production and lab paths: Venice (`openai_compatible`) and `PLAYON_RUNTIME=docker` or `native`. Placeholder containers, sleep stubs, and IntentMock paths must not be reintroduced.

## Decision

- Production and the Linux lab verify bar use **real Venice** and a **real Docker or native** runtime only.
- `RuntimeAdapters.mode` must match the host configuration (`"docker"` | `"native"`); native hosts must not probe or label themselves as Docker.
- Skill `containerSupport` is colocated with host capability: `none` → process; `full`/`partial` → Docker when the host runs docker mode; native host mode always uses the process supervisor.
- Do **not** reintroduce IntentMock or mock runtime adapters into the merge/verify path.

## Consequences

- Lab verification needs Docker (for docker mode) and `PLAYON_VENICE_API_KEY` (or Settings DB key).
- Native-only hosts remain honest: container ops fail via `UnavailableDockerAdapter` with a clear error.
- ADR-0001 remains valid for monorepo shape; its mock-CI sentence is superseded here for autonomy and production truthfulness.
