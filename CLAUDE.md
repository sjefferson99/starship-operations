# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Run the app**: `node --no-warnings server.js` (or `npm start`) → http://localhost:3001. No build step — client is static files served as-is. The `--no-warnings` flag suppresses `node:sqlite`'s experimental-feature warning.
- **Run tests**: `npm test` (runs `playwright test`, which auto-starts `node server.js` against an isolated `test-results/test-game.db` via `GAME_DB_PATH` — never the real `savegame/game.db`).
- **Before running tests, check whether a server is already on port 3001** (`netstat -ano | findstr :3001`, or `Get-NetTCPConnection -LocalPort 3001` in PowerShell). `playwright.config.js` sets `reuseExistingServer: !process.env.CI`, so if the user is already running `node server.js` (e.g. manually testing the app before handing you a prompt), `npm test` silently reuses that process instead of starting a fresh one — including whatever DB schema it already loaded in memory at its own startup. Since SQLite migrations in `db.js` only run once per process, at startup, a stale long-running process can mask a real schema/migration bug as a flaky test failure (look for "no such column" in a save's error response). If a process is already listening, don't kill it without asking — it may be the user's own manual test session.
- **Run a single test**: `npx playwright test -g "<test name substring>"` or `npx playwright test tests/<file>.spec.js`.
- **No lint/typecheck configured.**

## Architecture

This is a vanilla-JS browser dashboard game with **zero build tooling**: no bundler, no
framework, no `import`/`export`. Every client file is a plain global `class` loaded via a
classic `<script>` tag in `index.html`, in this order: `game_state.js` → `system_update.js` →
`repair_manager.js` → `crew_manager.js` → `comms_nav.js` → `main.js`. That order is load-bearing —
later classes reference earlier ones by bare global name (e.g. `new SystemUpdate(this)` inside
`StarshipGame`'s constructor).

**No encapsulation between the client classes.** `StarshipGame` (`main.js`) holds all
live state (`this.systems`, `this.repairQueue`, `this.moduleSpecs`, `this.crewManifest`) as
plain instance properties, and `GameState`, `SystemUpdate`, `RepairManager`, `CrewManager`, and
`CommsNav` all read/write those properties directly rather than through an interface. When
changing state shape, grep for every reader, don't assume one file owns a field.

**The tick loop is the heart of the simulation** (`main.js`'s `_startTimer`): every real second,
if not paused, `gameTime` advances by `gameSpeed` (1/10/100/1000×) and that same value is passed
as `dt` (game-seconds elapsed) into `SystemUpdate.update(dt)`, which runs O2 → CO2 →
power/fuel → crew health → repair decay → repair-queue processing → status thresholds, in that
fixed order, then `main.js` does a full imperative DOM re-render (no diffing). Because `dt` can be
as large as 1000 at high speed, any new per-tick calculation needs to be safe against one huge
step — see the CO2-vent-overshoot fix in `system_update.js` for the pattern (clamp to the
equilibrium target instead of letting a big tick blow through it).

**Saves are named slots, not one implicit save.** New Game always starts from pure
`_defaultSystems()` defaults (never resumes from a prior save) and prompts for a name via a
native `prompt()`; Load Game shows a list of named saves (`#load-screen`) with Load/Delete per
row. State lives in SQLite (`savegame/game.db`, via `db.js`, using the built-in `node:sqlite` —
no npm install required) behind `/api/saves` (list/create), `/api/saves/:id` (get/put/delete).
Each save's world-state and ship-instance data is written in **one PUT with one transaction**
(`db.saveSave`) — `GameState.saveServer`/`loadServer` send/receive both halves as a single
`{world, shipInstances}` payload, not two independent requests (that was the old single-save
model's gap; it's fixed now, not just deferred). `db.js` is schema-versioned
(`meta.schema_version` + an ordered `MIGRATIONS` array) — append new migration steps there,
never edit a shipped one; ship-scoped tables (`ships`, `ship_atmosphere`, `ship_modules`,
`ship_battery`, `ship_fuel`) all key on `(save_id, ship_id, ...)` since the same `ship_id`
(`'player-ship-1'`) recurs across every save. `crew_members` is keyed on `(save_id, id)` instead
(not ship-scoped — crew belongs to the save) and holds the live roster state described below.
`comms_locations` follows the same `(save_id, id)` shape for the Comms & Nav sector roster.
Static reference data (`ship_classes.json`,
`module_specs.json`, `crew_manifest.json`, `story_messages.json`) is untouched by any of
this — still fetched read-only, never written by the server, deliberately kept as
hand-editable JSON rather than DB tables. `data/ship_instances.json` and `savegame/save.json`
(the old single-save flat files) are fully dead — left on disk, never read or written.

**Repair domain logic is isolated in `repair_manager.js`** (`RepairManager`) on purpose, kept
separate from the physics in `system_update.js`: it owns the decay curve, the crew-shift lookup
(matches `data/crew_manifest.json` shift windows against the in-game clock derived from
`gameTime`), and the repair task queue (array order = priority; only the front N tasks — N =
on-shift, available engineering crew — actually progress each tick, which is what makes
reordering "pause" a task instead of resetting it). Each active task's progress this tick is
divided by `CrewManager.effectivenessMultiplier(health)` of whichever on-shift crew member is at
that queue position — a positional pairing for the tick, not a persistent assignment.

**Crew health lives in `crew_manager.js`** (`CrewManager`), separate from `data/crew_manifest.json`
(the static, read-only template of `{id, classes, shifts}`). `this.crewManifest` on `StarshipGame`
is the *live* roster — template merged with per-save state (`health`, `varianceFactor`, `dead`,
and a player-editable copy of `shifts`) — and is what `RepairManager` and the dashboard actually
read. `CrewManager.update(dt)` (called from `SystemUpdate.update`) raises/lowers each member's
health based on continuous O2-low/CO2-high severity (reusing the same threshold bands as
`SystemUpdate._updateStatuses`) plus a per-member `varianceFactor` rolled once at creation, so
crew don't all decline in lockstep. Health <20% marks a member unavailable for repair work
(`isAvailable`); health hitting 0 sets `dead: true` permanently — there's no reviving a dead
crew member even if the environment recovers. `this.crew` (the headcount driving O2/CO2
consumption) is just `crewManager.aliveCount()`, re-synced once per tick.

**Comms & Nav (`comms_nav.js`, `CommsNav`)** procedurally generates the small sector roster shown
in the Comms & Nav panel: the ship's current location plus a discovered trading post and a
detected comms signal. Generation is seeded — `_promptNewGame()` shows `#seed-screen` (a random
seed pre-filled via `CommsNav.rollSeed()`, editable, with a Regenerate button) right after naming
the save and before the backstory intro; whatever seed the player confirms there is stashed on
`game._pendingSeed` and consumed by `generate(seed)` in `startNewGame()`, which feeds it through a
tiny deterministic PRNG (`mulberry32`) so the same seed always reproduces the same layout. The
current location lands anywhere in a 10×10×10 cube; the other two are offset from it by up to 1
unit per axis, so they read as "nearby" rather than scattered across the whole grid. Only the
*resulting* `{id, kind, name, x, y, z}` records are what gets persisted (`comms_locations` table)
and read by the dashboard — the seed itself is kept only for display, generation is never re-run
from it after creation. The dashboard renders two orthographic plane views (Top X/Y, Side X/Z) as
plain inline SVG rather than attempting true 3D — there's no rendering library in this codebase
and a hand-rolled 3D projection wasn't worth the payoff for three points.

**`window.game`** is deliberately exposed in `main.js` so `tests/*.spec.js` can drive internal
state directly in a real browser via Playwright, rather than re-implementing game logic in the
test layer.

For a full file-by-file breakdown, data schemas, and API surface, see `docs/repo-summary.md` —
treat it as a starting point to verify against current source, not as ground truth, since it's
a generated snapshot that can drift. Regenerate it (don't hand-patch it) using the process in
`docs/repo-analysis-prompt.md` after notable feature work.
