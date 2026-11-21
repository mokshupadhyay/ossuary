# Session instructions: polish the Haunted Tip Jar

Work ONLY in `apps/haunted-tip-jar` and its spec folder `.kiro/specs/haunted-tip-jar`. Another session is still finishing
`apps/the-tontine`; do not touch it, `packages/` or `power/`. If a fix needs a change outside the app, do the app-side part
and write the rest under "Follow-ups" in a new file `docs/polish-followups.md`. Follow `.kiro/steering`. Do not commit.
Verify after each item (`pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm e2e`) and report evidence.

## 1. Fix a misleading number
The "Ghosts by fault" table in the Summon the Poltergeist view shows a Vibe Pay row with 8/8 ghosts drifted but a drift of
0.000000 (concurrent double-tap): the pot loses what the members gain, so the total nets to zero, and a viewer reads
"drifted but zero". Derive from the existing report fields what the table needs (do not change core) and show lost and
conjured separately, or the sum of absolute per-account drifts, so a row with drifted ghosts never reads as zero. Add a
test that fails against the old behaviour (show it failing first), and keep the per-account totals in the meters unchanged.

## 2. Make the demo memorable (Design and Presentation are 40% of the score)
- Animate the storm in the Summon the Poltergeist view: ghosts drift across both panels while it runs, the twin's meter
  climbs red, Ossuary's stays at zero. Respect `prefers-reduced-motion` (static fallback), and add a polite live region
  that announces "storm finished: drift X" for screen readers.
- Give the overlay and jar a little more atmosphere without hurting legibility: a faint candlelit glow and consistent
  ghost and tombstone treatment, using the existing palette (amber accent).
- Check 390 px and 1280 px widths: no horizontal scroll, readable text, visible focus rings, contrast at least 4.5:1.
  Fix what fails, and add a Playwright check for the mobile width.
- Update the app README and add the new behaviour to the e2e test.

When all is verified, report: test counts, what changed, evidence for each item, and anything you could not fix.
