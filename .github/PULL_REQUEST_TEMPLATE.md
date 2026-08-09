## Summary

<!-- What and why (1–3 bullets). -->

## Issue

Fixes #

## Verify bar used

- [ ] Fast — `pnpm verify` (CI)
- [ ] Merge — `pnpm loop:verify` (lab)
- [ ] Runtime — `pnpm loop:verify:runtime`
- [ ] Matrix — `pnpm lab:matrix --skill <id>`
- [ ] E2E — `pnpm test:e2e`
- [ ] Docs / templates only (no code bar)

## Human gates

- [ ] No product-scope / brand / irreversible host decision pending
- [ ] Or issue is labeled `blocked-human` and this PR must not merge until cleared

## Checklist

- [ ] Secrets redacted from logs/fixtures
- [ ] `P0`/`P1` bug includes regression test **or** linked `test-debt` issue
