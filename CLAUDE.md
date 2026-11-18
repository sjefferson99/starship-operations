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
`repair_manager.js` → `fabrication.js` → `logistics.js` → `crew_manager.js` → `comms_nav.js` → `tour.js` → `timeline.js` → `notifications.js` → `anchor.js` → `main.js` → `sound.js`. That order is load-bearing —
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
`CommsNav.purchaseBlocker()`/`purchase()` hold every buying rule (local network in range, not in
flight, enough credits, and either a module slot that is empty or destroyed — `dest: 'fit'` — or an
empty machine storage box — `dest: 'store'`); where the goods then go is logistics (below). The **water maker** reclaims
black-water liquid into fresh water first and, in a breathable atmosphere, makes up the rest from
outside air (the card shows the split, `fromBlackLhr`/`fromAirLhr`). It reclaims all of the *free* liquid, but
the solids hold `SOLIDS_HOLD_LIQUID_FRACTION` (0.2) of their volume as `blackWater.residueL`, which it can't
touch; `SystemUpdate.settleResidue()` re-splits liquid/residue whenever liquid or solids change (each tick,
`syncBlackWaterLevel`, restore), so moving solids to a compost box frees the liquid they held. Dumping always empties the whole tank — there's no prompt.

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

**Fabrication and cargo live in `fabrication.js`** (`Fabrication`). `game.cargo.boxes` holds storage
boxes, and **everything aboard bar a drone is in a box**: supplies (`Fabrication.ITEMS`: basic and
precision components, composting agent — unlimited stock) live in `kind: 'parts'` boxes as
`box.parts = { itemKey: count }`, each unit taking `ITEMS[k].litres` of the box; `count()`,
`storeParts()` (fullest parts box first, then empty boxes; `force` for refunds and strip yields) and
`takeParts()` are the only way in and out. `cargo.items` is legacy: `GameState._applyCargo` packs an old
payload's loose items into boxes. The repair queue is the ship's **work queue**: fabrication jobs are
tasks in `game.repairQueue` with `kind: 'fabricate'` and a `recipeKey` (no `systemKey`), and stripping
a wrecked drive is `kind: 'strip'` (`recipeKey` = the drive) — `RepairManager.isJob(task)` covers both.
They're worked by the same engineers in the same order; a recipe's `components` (a map of item → count)
are taken when the job is queued and refunded on cancel, and `RepairManager.processQueue` calls
`Fabrication.completeTask` when the hours are done. A recipe `makes` a box, a drone dock, or a fitted
module (the atmospheric thrusters). Anything reading `repairQueue` must allow for tasks without a
`systemKey`. A box holds one kind of thing at a time: composting agent makes an empty box a compost box,
solid waste (`blackWater.solidL`) is moved into it instantly, sealing (by hand or once full) starts
`COMPOST_HOURS` of composting, finished compost sells, which empties the box, or can be
tipped out for free instead (only once it's finished). Boxes and what's being made count toward `_computeShipCapacity()`, and
buying or fabricating is refused when it wouldn't fit (`Fabrication.spaceBlocker`). Persisted in
`storage_boxes` (a parts box's contents are JSON in `contents`); `repair_tasks` gained `kind`/`recipe_key`.

**Logistics (`logistics.js`, `Logistics`): the yard, the port, drones and drives.** A new ship is berthed
at Harlow's Salvage (`game.berth = 'yard'`), 120 km from Port Carrow, with both drives — `systems.thrusters`
and `systems.ionDrive`, `ship_modules` rows but not in `repairableKeys()` — wrecked, and an empty second
storage box for their parts. All trade happens at the port: `Logistics.tradeMode()` is `'direct'` when
berthed there, `'drone'` from the yard, `null` in flight or with the local network out of range, and every
buy/sell blocker in `Fabrication`/`CommsNav` goes through it. From the yard a purchase is an order in
`game.portHold` (same kind of thing merged into one line) and a sale is loaded onto a ready drone
(`sendForSale`, paid when it lands); `orderBlocker` refuses anything over a drone's `payloadKg` and anything
at all before a drone is owned. **Transfer drones** (`game.drones`, spec `transferDrone`) are bought from the
market and fly themselves over; `state` is arriving/outbound/returning (away) or parked/stowed/docked (home).
Each drone has a **plan** (`drone.plan = [{ holdId, qty }]`, the Plan Run screen) of what to bring back:
`planAdd` refuses anything over `payloadKg`, more than is waiting (counting other drones' plans), or more than
there's room aboard for (`roomAboardFor`: box litres, food room, tank room, empty machine boxes — net of every
plan and every drone's `cargoIn`) — so from the yard a module can be ordered to store (`dest: 'store'`) with no
machine box free, or none built yet: it waits in the hold until there's a box to plan it into. A drone's
**outbound** plan (`drone.planOut = [{ kind: 'module' | 'compost', boxId }]`, top of Plan Run) is what the run
takes out to sell; `launch` loads it out of its boxes (`_loadOut`), and a module going out counts as a free
machine box for that drone's inbound plan (`roomAboardFor(entry, drone)`), which is how a stored module is
swapped for another in one run. The port takes in new drone-sized salvage at `CommsNav.RESTOCK_HOURS`, up to
`RESTOCK[].max` of each kind (`CommsNav.update`, found from `gameTime`, rolls on `game.rng`), and
`_tidyPlans` keeps plans in step with the hold. A run (`launch`) needs charge for the round trip and a plan
(or, from `sendForSale`, something to sell), and spends charge and wear per km; at the port it sells `cargoOut`,
puts any undelivered `cargoIn` back in the hold, loads exactly the plan (splitting a part-planned order), and on
return `_deliver` puts what fits aboard — the rest stays in `cargoIn` and is retried each tick. One huge
tick can run a whole trip (`_updateDrone` loops through the legs). Drones are repair units
`drone:<id>` (`RepairManager.isDroneUnit`), repairable only while home. **Drone docks** (`game.droneDocks`,
fabricated) charge docked drones from spare generator output only, before the battery tops up, never from
the battery — unless that drone's **charge from battery** switch (`chargeFromBattery`) is on, when the shortfall comes from the battery down to `DOCK_BATTERY_FLOOR_PCT` (20%). Computed in `SystemUpdate._updatePowerAndFuel` (`power.dockW`, of which `dockBatteryW` from the battery). **Stripping** a wrecked drive
(`queueStrip`, needs box room for its `STRIP` yield) removes it and yields components; new atmospheric
thrusters are a recipe. `fly(to)` needs fitted thrusters, `hopFuelL`, and every drone aboard;
`game.flight` counts down and lands her (`_updateFlight`); at the port the hold is delivered straight
aboard each tick. `main.js _syncBackground` sets the background from the berth (city / port / flight, the
last animated). Persisted in `ship_logistics`, `drones` (loads as JSON) and `port_hold`; a payload
without logistics starts at the yard with the drives wrecked.

**Food is a box kind, and the only source of solid waste.** Rations are
bought by the case (`Fabrication.FOOD`, not in `ITEMS`) and stored as `kind: 'food'` boxes, `fillL`
counting rations: they top up food boxes, then claim empty standard boxes, and are refused with no
room. Eating is discrete: at each meal time on the ship's clock (`SystemUpdate.MEAL_HOURS`, 07/13/19) every
living member eats one whole ration, or `FOOD_RATION_PER_MEAL` (half) while `food.rationing` — meals are
found from `gameTime` (`_mealTimesBetween`), so code that calls `systemUpdate.update(dt)` must advance
`gameTime` too. A meal short of food is missed and starts `starvedHours`; the next full meal resets it.
Rationing builds `food.rationHours` (paid back at `FOOD_REFEED_RATE`× by full meals, so toggling can't
reset it): crew work `FOOD_RATION_WORK_FACTOR` slower while it's above 0, and health only declines after
`FOOD_RATION_GRACE_HOURS` (a week). `_updateFood` eats from the emptiest food box (a box eaten empty goes back to
unassigned) and turns what was eaten into `blackWater.solidL` (`SOLID_WASTE_L_PER_RATION`); water
use now only makes the liquid. `systems.food` holds the derived reading plus `starvedHours`, which
drives `CrewManager`'s starvation impact after `FOOD_GRACE_HOURS` (all persisted in `ship_food`). A new
ship starts with one box of `STARTER_RATIONS` (and one empty box), and so does a payload from before food existed
(`GameState._hasFoodState`).

**Machine storage boxes** (`size: 'machine'`, the `machineBox` recipe: 2 basic components, 10 h) each hold
one `module` record (`moduleKey`, `tier`, `repairPct`, `juryRigged`, `destroyed`) that needs no
dashboard slot and doesn't wear. RepairManager treats it as the **unit key** `box:<boxId>`: repair
tasks for it carry that as their `systemKey`, so code that looks for a fitted module's tasks by key
never matches them (`repairManager.isStoredUnit()`, `storedKeys()`). `Fabrication.swap` exchanges it
with the fitted unit (queued repairs follow their unit; `swapCount` lets the observers tell a swap
from a repair) and `sellModule` sells it for `moduleSaleValue` (40–750 by condition on a curve, `MODULE_SELL_CURVE`, so damaged units fetch little and repaired ones a lot;
less if jury-rigged, scrap if destroyed) — the buy-salvage, repair, sell loop. Each sale adds to
`game.moduleResale[moduleKey]`, which cuts the next sale of that type by `MODULE_RESALE_DROP` per
recent sale and wears off over `MODULE_RESALE_RECOVERY_DAYS` (persisted in `market_resale`). The
market only restocks drone-sized salvage (`CommsNav.RESTOCK`, see Logistics); anything else bought is gone. Scarcity dials are `CommsNav.MARKET_STOCK`
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
crew member even if the environment recovers. Recovery (`RECOVERY_PCT_PER_HR`) is deliberately much slower
than decline — about a day from 0 to 100% — so toggling a control off and on can't buy health back. Two further health sources live here: **overwork**
is per member, from scheduled hours per day (`dutyHours`, overlaps counted once) — free to 8h, only
slower work to 12h (`fatigueWorkFactor`); all fatigue works from `restedDutyHours`, which follows the
scheduled hours with a ~6h time constant (persisted per member), so a roster change settles in over about
a day rather than at once, and beyond that health is pulled down to a ceiling
(`fatigueHealthCap`) that falls non-linearly to 0 at 24h; and **sewage exposure** while black
water is spilled in the cabin (`blackWater.exposureHours`), an immediate drain that steepens hourly plus a
rising per-hour chance of a lump-damage infection. Water is a closed loop: all fresh water used (and the
rehydration draw on coming off rationing, which needs that much room in the tank) becomes black-water
liquid, 90% with the vents open (`blackFromUseFraction`). What a full tank can't take is kept as
`spillLiquidL`/`spillSolidL`, never lost; only `cleanUpSpill` (main.js) ends exposure — it puts the spill
back in the tank plus `SPILL_CLEANUP_WATER_PER_L` (0.5) of fresh water per litre, as much as tank room
and fresh water allow. Dumping empties the tank (not the spill) and costs a
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
reaches nothing, and specs about buying or selling call `atPort(page)`, since from the yard every
trade goes by drone (`tests/logistics.spec.js` covers that).

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

**The dashboard is grouped cards of fixed height** (`main.js` `_initDashboardLayout`/`_layoutCards`, run
after every redraw). Every `.system-card` is `--card-h` tall so a message appearing never moves the layout;
the part that varies sits in `.card-details`, which clips, and the card then offers a "More" toggle. Groups
(`.card-group`) collapse to each card's header and gauge bar; Expand/Collapse all sit above them. Both are
viewing preferences in `localStorage` (`starshipOps.dashboardLayout`), not game state. Card status is set
with `_setCardStatus` (class toggles) — never overwrite a card's `className`. **Floating messages are
anchored** (`anchor.js`, `Anchor.attach(el, target)`): the idle-crew note and the action-result toast
(`_showSaveStatus`, placed beside the button just pressed) are `position: fixed` and re-measured against
their target every frame, so put new callouts there rather than in the header's flow. **The Timeline rolls
up** long games into 4-week months, weeks and days (`_topUnit`, `_view`, a breadcrumb `_path`); a game
under two days shows every checkpoint at once.

**`window.game`** is deliberately exposed in `main.js` so `tests/*.spec.js` can drive internal
state directly in a real browser via Playwright, rather than re-implementing game logic in the
test layer.

For a full file-by-file breakdown, data schemas, and API surface, see `docs/repo-summary.md` —
treat it as a starting point to verify against current source, not as ground truth, since it's
a generated snapshot that can drift. Regenerate it (don't hand-patch it) using the process in
`docs/repo-analysis-prompt.md` after notable feature work.
