# Session instructions: Tontine polish, write-up, deploy readiness

Work in `apps/the-tontine`, the root `README.md`, `docs/KIRO_USAGE.md` (new), `.github/workflows` (new CI file only) and the
per-app deploy config. Another session is still polishing `apps/haunted-tip-jar`: do not touch that app, `packages/` or
`power/`. Follow `.kiro/steering`. Do not commit. Verify each item (tests, type check, production build, e2e) and report
evidence.

## 1. Polish the Tontine (same gaps found in the Tip Jar review)
- The Summon the Poltergeist "Ghosts by fault" table can show a Vibe Pay row with drifted ghosts but a drift of 0.000000,
  because the pot loses what members gain and the total nets to zero. Show lost and conjured separately (or the sum of
  absolute account drifts) so a drifted row never reads as zero. Derive it from existing report fields; do not change core.
  Add a test that fails against the old behaviour (show it failing first).
- Animate the storm: ghosts drift across both panels while it runs, the twin's meter climbs red, Ossuary's stays at zero.
  Respect `prefers-reduced-motion` (static fallback) and add a polite live region announcing "storm finished: drift X".
- Candle flicker on the circle (respecting reduced motion), consistent with the existing candlelit theme.
- Check 390 px and 1280 px: no horizontal scroll, readable text, visible focus rings, contrast at least 4.5:1. Fix failures.
- Open Questions Q2 in the design mentions a possible core change (a payout handler). Leave core alone; record the
  recommendation under "Follow-ups" in `docs/polish-followups.md`.
- Add the new behaviour to the e2e test (desktop and mobile).

## 2. CI
Add `.github/workflows/ci.yml` that, on push and pull request, installs with `pnpm install --frozen-lockfile` and runs the
core tests, each app's tests, type checks and builds, and the power's tests. Keep Playwright e2e in a separate job that
installs the Chromium browser. Validate the YAML structure with a local check. Note in the README that it has not yet run
on GitHub.

## 3. Deploy readiness
Add the minimal static-site config for each app (for example `vercel.json` with the monorepo install and build commands and
the output directory), and a root README "Live apps" section with placeholders for the URLs. Do not deploy.

## 4. Write-up: docs/KIRO_USAGE.md and the README section "How Kiro was used"
Wait until the other polish session has exited: poll with `pgrep -f session-polish-tipjar` every 60 seconds until it
returns nothing, then measure. Answer each question the Kiroween rules list, using real numbers measured with commands, not
estimates: IDE vs CLI vs Web vs Crew (what was actually used: the IDE for the first specs, the Kiro CLI headless for the
later sessions and for generating the twin), custom agents, agent hooks, spec-driven development vs vibe coding (the twin
is the vibe-coded comparison), steering, MCP, property-based testing (list each property and the mutations it was checked
against), and the Kiro power. Include a claims-to-evidence table (claim, file, command to reproduce) and a repository
map. State known limits plainly: the CI workflow has not run on GitHub, the IDE "install power from folder" route is
unconfirmed, the twin is less naive than expected (packages/twin/PRODUCED.md), and PGlite logs one harmless ErrnoError in the
browser. Do not claim anything you did not measure.

## Final
Run everything: `pnpm --filter core test`, each app's tests, type checks, builds and e2e, and the power's tests. Report
counts and anything that fails.
