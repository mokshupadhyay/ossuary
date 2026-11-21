# Session instructions: polish, write-up and deploy readiness

Work only in this repository. Both apps and the power are built and committed; this session closes the gaps found in review.
Follow `.kiro/steering`. Do not commit. Verify after each item (tests, type check, production build) and report evidence.

## 1. Fix a misleading number in the poltergeist views (both apps)
The "Ghosts by fault" table shows a Vibe Pay row with 8/8 ghosts drifted but a drift of 0.000000 (concurrent double-tap),
because the pot loses money and the members gain the same amount, so the total nets to zero. A viewer reads "drifted but
zero". Show per-fault conjured and lost separately, or the sum of absolute account drifts, so a netted-out row never reads
as zero. Update the report schema consumers, the tests and the README wording. Add a property or unit test that a row
with drifted ghosts never displays zero drift.

## 2. Make the demo memorable (Design and Presentation are 40% of the score)
- In each app's Summon the Poltergeist view, animate the storm: ghosts drift across both panels while it runs, the twin's
  meter climbs red, Ossuary's stays at zero. Respect `prefers-reduced-motion` (static fallback) and keep it keyboard and
  screen-reader friendly (a polite live region announcing "storm finished: drift X").
- Keep the candle and coffin metaphors consistent across both apps (shared palette, same ghost and tombstone treatment).
- Check both apps at 390 px width and at 1280 px: no horizontal scroll, readable text, visible focus rings, contrast at
  least 4.5:1. Fix what fails.

## 3. Write-up: docs/KIRO_USAGE.md and the README section "How Kiro was used"
Answer each question the Kiroween rules list, with real numbers measured from this repository (count them with commands,
do not estimate): IDE vs CLI vs Web vs Crew (what you actually used), custom agents, agent hooks, spec-driven development
vs vibe coding (point at the twin as the vibe-coded comparison), steering, MCP, property-based testing (list each
property and the mutations it was checked against), and the Kiro power. Include a claims-to-evidence table (claim, file,
command to reproduce). State known limits plainly: the CI workflow has not run on GitHub, the IDE "install power from
folder" route is unconfirmed, and the twin is less naive than expected (see packages/twin/PRODUCED.md).

## 4. Deploy readiness
Add `vercel.json` (or the minimal config the host needs) for each app so it deploys as a static site from its folder with
the monorepo install, and a root README "Live apps" section with placeholders for the URLs. Do not deploy.

## Final
Run the whole workspace: `pnpm --filter core test`, each app's tests, type checks and builds, the power's tests and the
e2e tests. Report counts and anything that fails.
