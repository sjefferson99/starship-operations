# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Run the app**: `node server.js` (or `npm start`) → http://localhost:3001. No build step — it's static files served as-is.
- **Run tests**: `npm test` (runs `playwright test`, which auto-starts `node server.js` for the duration of the run).
- **Run a single test**: `npx playwright test -g "<test name substring>"` or `npx playwright test tests/<file>.spec.js`.
- **No lint/typecheck configured.**

## Architecture

This is a vanilla-JS browser dashboard game with **zero build tooling**: no bundler, no
framework, no `import`/`export`. Every client file is a plain global `class` loaded via a
classic `<script>` tag in `index.html`, in this order: `game_state.js` → `system_update.js` →
`repair_manager.js` → `main.js`. That order is load-bearing — later classes reference earlier
ones by bare global name (e.g. `new SystemUpdate(this)` inside `StarshipGame`'s constructor).

**No encapsulation between the four client classes.** `StarshipGame` (`main.js`) holds all
live state (`this.systems`, `this.repairQueue`, `this.moduleSpecs`, `this.crewManifest`) as
plain instance properties, and `GameState`, `SystemUpdate`, and `RepairManager` all read/write
those properties directly rather than through an interface. When changing state shape, grep
for every reader, don't assume one file owns a field.

**The tick loop is the heart of the simulation** (`main.js`'s `_startTimer`): every real second,
if not paused, `gameTime` advances by `gameSpeed` (1/10/100/1000×) and that same value is passed
as `dt` (game-seconds elapsed) into `SystemUpdate.update(dt)`, which runs O2 → CO2 →
power/fuel → repair decay → repair-queue processing → status thresholds, in that fixed order,
then `main.js` does a full imperative DOM re-render (no diffing). Because `dt` can be as large
as 1000 at high speed, any new per-tick calculation needs to be safe against one huge step —
see the CO2-vent-overshoot fix in `system_update.js` for the pattern (clamp to the equilibrium
target instead of letting a big tick blow through it).

**Persistence is a two-file split**, both served by `server.js` (plain Node `http`, no
framework): `savegame/save.json` holds world state (time/credits/speed), `data/ship_instances.json`
holds the ship's live system state + repair queue. `GameState.saveServer`/`loadServer` POST/GET
both via `/api/save` and `/api/ship-instances` as two independent requests — there's no
transaction across them. Static reference data (`ship_classes.json`, `module_specs.json`,
`crew_manifest.json`, `story_messages.json`) is fetched read-only and never written by the server.

**Repair domain logic is isolated in `repair_manager.js`** (`RepairManager`) on purpose, kept
separate from the physics in `system_update.js`: it owns the decay curve, the crew-shift lookup
(matches `data/crew_manifest.json` shift windows against the in-game clock derived from
`gameTime`), and the repair task queue (array order = priority; only the front N tasks — N =
on-shift engineering crew — actually progress each tick, which is what makes reordering "pause"
a task instead of resetting it).

**`window.game`** is deliberately exposed in `main.js` so `tests/*.spec.js` can drive internal
state directly in a real browser via Playwright, rather than re-implementing game logic in the
test layer.

For a full file-by-file breakdown, data schemas, and API surface, see `docs/repo-summary.md` —
treat it as a starting point to verify against current source, not as ground truth, since it's
a generated snapshot that can drift. Regenerate it (don't hand-patch it) using the process in
`docs/repo-analysis-prompt.md` after notable feature work.
