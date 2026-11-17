# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Run the app**: `node --no-warnings server.js` (or `npm start`) → http://localhost:3001. No build step — client is static files served as-is. The `--no-warnings` flag suppresses `node:sqlite`'s experimental-feature warning.
- **Run tests**: `npm test` (runs `playwright test`, which auto-starts `node server.js` against an isolated `test-results/test-game.db` via `GAME_DB_PATH` — never the real `savegame/game.db`).
- **Before running tests, check whether a server is already on port 3001** (`netstat -ano | findstr :3001`, or `Get-NetTCPConnection -LocalPort 3001` in PowerShell). `playwright.config.js` sets `reuseExistingServer: !process.env.CI`, so if the user is already running `node server.js` (e.g. manually testing the app before handing you a prompt), `npm test` silently reuses that process instead of starting a fresh one — including whatever DB schema it already loaded in memory at its own startup. Since SQLite migrations in `db.js` only run once per process, at startup, a stale long-running process can mask a real schema/migration bug as a flaky test failure (look for "no such column" in a save's error response). If a process is already listening, don't kill it without asking — it may be the user's own manual test session. Instead, run the suite on its own port: `TEST_PORT=3017 npx playwright test` (Bash) / `$env:TEST_PORT=3017; npx playwright test` (PowerShell). `server.js` honours `PORT`, and the config passes it through.
- **Run a single test**: `npx playwright test -g "<test name substring>"` or `npx playwright test tests/<file>.spec.js`.
- **No lint/typecheck configured.**

## Architecture

This is a vanilla-JS browser dashboard game with **zero build tooling**: no bundler, no
framework, no `import`/`export`. Every client file is a plain global `class` loaded via a
classic `<script>` tag in `index.html`, in this order: `rng.js` → `game_state.js` → `system_update.js` →
`repair_manager.js` → `fabrication.js` → `crew_manager.js` → `comms_nav.js` → `tour.js` → `timeline.js` → `notifications.js` → `main.js` → `sound.js`. That order is load-bearing —
later classes reference earlier ones by bare global name (e.g. `new SystemUpdate(this)` inside
`StarshipGame`'s constructor).

**Rewind — read [docs/rewind-readiness.md](docs/rewind-readiness.md) before adding game state or
randomness.** The player can go back to earlier checkpoints and branch from them (the Timeline,
below), so every change must keep to its rules: (1) all game state goes through
`GameState.snapshot`/`shipInstanceSnapshot`/`restore`; (2) `restore` keeps loading older payloads,
with defaults for missing fields; (3) every gameplay roll uses `game.rng.next()` (the seeded
`GameRng` in `rng.js`, whose state is saved), never `Math.random()`; (4) static reference JSON is
deliberately not checkpointed.

**No encapsulation between the client classes.** `StarshipGame` (`main.js`) holds all
live state (`this.systems`, `this.repairQueue`, `this.moduleSpecs`, `this.crewManifest`) as
plain instance properties, and `GameState`, `SystemUpdate`, `RepairManager`, `CrewManager`, and
`CommsNav` all read/write those properties directly rather than through an interface. When
changing state shape, grep for every reader, don't assume one file owns a field.

**The tick loop is the heart of the simulation** (`main.js`'s `_startTimer`): every real second,
if not paused, `gameTime` advances by `gameSpeed` (1/10/100/1000×) and that same value is passed
as `dt` (game-seconds elapsed) into `SystemUpdate.update(dt)`, which runs O2 → CO2 →
transceiver → food (eating) → water (incl. water maker) → power/fuel → crew health → repair decay → work-queue
processing → composting → status thresholds, in that fixed order (preceded by the power-budget calculation
described below), then `main.js` does a full imperative DOM re-render (no diffing). Because `dt` can be
as large as 1000 at high speed, any new per-tick calculation needs to be safe against one huge
step — see the CO2-vent-overshoot fix in `system_update.js` for the pattern (clamp to the
equilibrium target instead of letting a big tick blow through it).

**Nothing electrical runs without power.** `SystemUpdate._computePowerBudget(dt)` runs first each
tick and sets `systems.power.powerFraction` (0–1): the share of the tick's total rated electrical
demand that the battery plus this tick's generator output can actually cover. Every powered module
(O2 generator, CO2 scrubber, transceiver, water maker — the list is `_poweredDevices()`) scales its
output by that fraction, so a flat battery means zero output regardless of the module's own on/off
switch, and a shortfall is a proportional brownout. It is deliberately an energy-over-the-tick
calculation rather than a `battery > 0` check, for the same large-`dt` reason as above. A new powered
module must be added to `_poweredDevices()` and multiply its output by `_powerFraction()`.

**Modules are the five keys `RepairManager.repairableKeys()` returns** (`transceiver`, `power`,
`o2`, `co2`, `waterMaker`) — each has `repairPct`/`juryRigged`/`destroyed` and a tiered spec in
`module_specs.json`. `installed === false` (only the water maker, until one is bought) hides a
module from repair, decay, power demand and ship capacity. The **transceiver**'s range is
`transmitW × rangeLyPerW × efficiency`; `CommsNav` turns that range into what is visible
(`visibleLocations()`, `hasLocalDetails()`) — the current location's market/news first, then other
contacts once range covers their distance. Visibility is derived live, never remembered, so an
unpowered or switched-off transceiver shows nothing but the ship's own position. The **market**
(`game.market`, seeded alongside the sector in `CommsNav.generate`) is a list of salvaged modules;
`CommsNav.purchaseBlocker()`/`purchase()` hold every buying rule (on-planet only, local network in
range, enough credits, and either a module slot that is empty or destroyed — `dest: 'fit'` — or an
empty machine storage box — `dest: 'store'`). The **water maker** reclaims
black-water liquid into fresh water first and, in a breathable atmosphere, makes up the rest from
outside air.

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
`comms_locations` follows the same `(save_id, id)` shape for the Comms & Nav sector roster, as does
`market_listings` for the market's remaining stock.
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

**Repairs are staged, and the stages are the tuning dials.** Each module tier in
`module_specs.json` has a `repairStages` list (`name`, `toPct`, `efficiency`, `hours`, optional
`destroyChance`/`juryRig`) — see the header comment in `repair_manager.js`. Those stages define
both the output curve (`efficiencyFor(systemKey)`: linear between stage boundaries, replacing the
old fixed quadratic) and how a repair proceeds: a task works one stage at a time, the module jumps
to that stage's `toPct` only when the stage completes, and the task then continues to the next
stage until `task.targetPct` is reached. `task.band`/`totalHours`/`hoursRemaining` describe the
stage currently being worked, not the whole job (`remainingHours(task)` gives that). The target is
chosen with the "Repair to" chips (card, Available Repairs, or on a queued task) and defaults to 100.

**Fabrication and cargo live in `fabrication.js`** (`Fabrication`). `game.cargo` holds supplies
aboard (`items`: `basicComponents`, `compostingAgent`, bought on any planet you can trade at — unlimited
stock, defined in `Fabrication.ITEMS`) and storage boxes (`boxes`). The repair queue is the ship's
**work queue**: fabrication jobs are tasks in `game.repairQueue` with `kind: 'fabricate'` and a
`recipeKey` (no `systemKey`), worked by the same engineers in the same order; components are taken when
the job is queued and refunded on cancel, and `RepairManager.processQueue` calls
`Fabrication.completeTask` when the hours are done. Anything reading `repairQueue` must allow for tasks
without a `systemKey`. A box holds one kind of thing at a time: composting agent makes an empty box a
compost box, solid waste (`blackWater.solidL`) is moved into it instantly, sealing (by hand or once full)
starts `COMPOST_HOURS` of composting, and finished compost sells on a planet, which empties the box.
Boxes, supplies and boxes being made count toward `_computeShipCapacity()`, and buying or fabricating is
refused when it wouldn't fit (`Fabrication.spaceBlocker`). Persisted in `ship_cargo_items` and
`storage_boxes`; `repair_tasks` gained `kind`/`recipe_key`.

**Food is a box kind, and the only source of solid waste.** Rations (`RATIONS_PER_CREW_DAY` = 3 per crew member) are
bought by the case (`Fabrication.FOOD`, not in `ITEMS`) and stored as `kind: 'food'` boxes, `fillL`
counting rations: they top up food boxes, then claim empty standard boxes, and are refused with no
room. `SystemUpdate._updateFood` eats from the emptiest food box (a box eaten empty goes back to
unassigned) and turns what was eaten into `blackWater.solidL` (`SOLID_WASTE_L_PER_RATION`); water
use now only makes the liquid. `systems.food` holds the derived reading plus `starvedHours`, which
drives `CrewManager`'s starvation impact after `FOOD_GRACE_HOURS` (persisted in `ship_food`). A new
ship starts with one box of `STARTER_RATIONS`, and so does a payload from before food existed
(`GameState._hasFoodState`).

**Machine storage boxes** (`size: 'machine'`, the `machineBox` recipe: 2 components, 10 h) each hold
one `module` record (`moduleKey`, `tier`, `repairPct`, `juryRigged`, `destroyed`) that needs no
dashboard slot and doesn't wear. RepairManager treats it as the **unit key** `box:<boxId>`: repair
tasks for it carry that as their `systemKey`, so code that looks for a fitted module's tasks by key
never matches them (`repairManager.isStoredUnit()`, `storedKeys()`). `Fabrication.swap` exchanges it
with the fitted unit (queued repairs follow their unit; `swapCount` lets the observers tell a swap
from a repair) and `sellModule` sells it on a planet for `moduleSaleValue` (40–400 by condition,
less if jury-rigged, scrap if destroyed) — the buy-salvage, repair, sell loop. Each sale adds to
`game.moduleResale[moduleKey]`, which cuts the next sale of that type by `MODULE_RESALE_DROP` per
recent sale and wears off over `MODULE_RESALE_RECOVERY_DAYS` (persisted in `market_resale`). The
market itself never restocks: a bought listing is gone. Scarcity dials are `CommsNav.MARKET_STOCK`
counts and the price/condition ranges beside it; repair time is `repairStages` in `module_specs.json`.

**Crew health lives in `crew_manager.js`** (`CrewManager`), separate from `data/crew_manifest.json`
(the static, read-only template of `{id, classes, shifts}`). `this.crewManifest` on `StarshipGame`
is the *live* roster — template merged with per-save state (`health`, `varianceFactor`, `dead`,
and a player-editable copy of `shifts`) — and is what `RepairManager` and the dashboard actually
read. `CrewManager.update(dt)` (called from `SystemUpdate.update`) raises/lowers each member's
health based on continuous O2-low/CO2-high severity (reusing the same threshold bands as
`SystemUpdate._updateStatuses`) plus a per-member `varianceFactor` rolled once at creation, so
crew don't all decline in lockstep. Health <20% marks a member unavailable for repair work
(`isAvailable`); health hitting 0 sets `dead: true` permanently — there's no reviving a dead
crew member even if the environment recovers. Two further health sources live here: **overwork**
is per member, from scheduled hours per day (`dutyHours`, overlaps counted once) — free to 8h, only
slower work to 12h (`fatigueWorkFactor`), and beyond that health is pulled down to a ceiling
(`fatigueHealthCap`) that falls non-linearly to 0 at 24h; and **sewage exposure** while the black
water tank is full (`blackWater.exposureHours`), an immediate drain that steepens hourly plus a
rising per-hour chance of a lump-damage infection. Dumping the tank resets exposure and costs a
flat fine (`BLACK_WATER_DUMP_FINE` in `main.js`), which may take credits negative. `this.crew` (the headcount driving O2/CO2
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

**Tips share the tour's card.** `Tour._buildTips()` is a priority-ordered list of
`{id, when(game), target, title, body}`; `checkTips()` runs once per tick from `main.js` and shows
the first due tip not yet seen for this save (`localStorage`, keyed by save id). Anything that only
becomes relevant hours into a game belongs there, not in the linear tour.

**The Timeline (`timeline.js`, `Timeline`) is rewind.** Each save has a *tree* of checkpoints in
`save_checkpoints` (`db.js`): each row is a full `{world, shipInstances}` payload as JSON plus its
`parent_id`, and `saves.head_checkpoint_id` is the one the live state grew from. Checkpoints are taken
when the clock crosses a game hour (`maybeCheckpoint()`, every tick), at New Game (`start`) and on
Save Game (`save`). `db.addCheckpoint` thins the current line as it goes: hourly checkpoints more than a
game day old drop to one per day, but `start`, `save`, `branch-end` and branch points are always kept.
Going back is one server transaction (`db.restoreCheckpoint`): the live state being left is stored as
a `branch-end`, the checkpoint's payload becomes the live save, and the checkpoint becomes the head,
so later play grows a new branch and no line is ever lost. Afterwards `game.afterRewind()` leaves the
game paused on the pause menu (also reviving a GAME OVER). The screen, opened from the pause menu, draws
the tree as inline SVG: one column per distinct checkpoint time, one row per branch.

**The guided tour (`tour.js`, `Tour`)** auto-starts on a player's first New Game (a
`localStorage` flag, `starshipOps.tourSeen`, records that it's been finished or skipped) and can be
replayed from the header's Tour button. Steps are a plain array in `_buildSteps()`: each spotlights a
real element by CSS selector and either waits on a `done(game)` predicate — the player performs the
real action, the tour never changes gameplay state itself — or shows a Next button. The shared
Playwright `page` fixture in `tests/helpers.js` pre-sets the seen flag (and switches tips off) so the
card never covers controls other specs click; `tests/tour.spec.js` clears them again. Specs about
Comms & Nav call `bringCommsOnline(page)` from the same helpers, since a new ship's transceiver
reaches nothing.

**Sound (`sound.js`, `SoundManager`) is an observer and the one exception to the load order:** it
loads *after* `main.js`, creates itself (`window.sound`) once `window.game` exists, and nothing in the
game calls it. UI sounds come from a single delegated document click listener; everything else (hum
level, alert chimes, repairs landing, vents, purchases, dumps) comes from diffing a small state
snapshot every 400 ms in `_poll()`. All audio is synthesised with the Web Audio API — there are no
audio files — and the `AudioContext` is only created on the first user gesture. To add a sound, add
a recipe to `_recipes()` and a trigger in `_onClick()` or `_poll()`; don't add calls into it from
game code. Loudness is mixed per channel — buttons, effects, alerts, systems hum, plus a master —
set by the player in the Sounds panel (`#sound-screen`, which `sound.js` also owns) and stored in
`localStorage`; a recipe's own `gain` is only its level relative to others in the same channel, and
`BASE` sets what each channel's default slider position means. The intended tone is calm (soft chimes, never alarms). `sound.log` records which sounds
were requested, which is what `tests/sound.spec.js` asserts on.

**Notifications (`notifications.js`, `Notifications`)** are the list behind the header's Notifications
pill (count, delete one, Clear all). `check()` runs at the end of every `updateDisplay()` and diffs a small
state snapshot against the last one — the same kinds of event `sound.js` chimes for (a status or crew
health band getting worse, a repair stage landing, a module destroyed, purchases, compost sealed / ready /
sold, a black-water dump) — so **a new sound trigger should get a matching notification, and vice versa**.
Vent toggles are deliberately not listed (the player's own click). Events with no state left to diff call
`game.notifications.add()` where they happen (the infection roll in `CrewManager`). Entries with the same
`key` and title are grouped with a count rather than repeated. The list is game state: saved as
`world.notifications` (the `notifications` table) and restored by `GameState.restore`, which also resets
the baseline so nothing is listed on arrival.

**`window.game`** is deliberately exposed in `main.js` so `tests/*.spec.js` can drive internal
state directly in a real browser via Playwright, rather than re-implementing game logic in the
test layer.

For a full file-by-file breakdown, data schemas, and API surface, see `docs/repo-summary.md` —
treat it as a starting point to verify against current source, not as ground truth, since it's
a generated snapshot that can drift. Regenerate it (don't hand-patch it) using the process in
`docs/repo-analysis-prompt.md` after notable feature work.
