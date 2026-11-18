# Repository Summary

### 1. Repository Overview
- Purpose: browser dashboard game. Keep a worn-out salvage ship and its crew alive, repair and trade salvage, and get the ship flying from a salvage yard to a spaceport.
- Architectural style: client-heavy monolith. The browser holds all game logic in global classes with no bundler. A minimal Node HTTP server provides static files plus a JSON save/checkpoint API over SQLite.
- Runtime environment: Node.js (`server.js`, `db.js`, built-in `node:sqlite`, no runtime npm deps). Browser plain JavaScript (classic `<script>` tags, shared global scope).

---

### 2. Core Components
- **Game orchestrator**: `StarshipGame` owns live state, the 1 s tick loop, all DOM rendering and event wiring, plus overlay screens and save/load flows. Key files: `main.js`
- **Physics tick**: `SystemUpdate` runs the per-tick simulation:
  - power budget, O2, CO2, transceiver;
  - food (meals), water and the black-water loop;
  - power/fuel and dock charging.
  - It then calls the other domains' `update(dt)`.
  - Key files: `system_update.js`
- **Repairs and work queue**: `RepairManager` handles module wear, staged repairs, the repair→output curve, crew-shift gating, and a work queue shared with fabrication and strip jobs. Key files: `repair_manager.js`
- **Crew**: `CrewManager` keeps the live roster merged from a template, and the health model (atmosphere, overwork, starvation, sewage exposure, infection) behind work effectiveness. Key files: `crew_manager.js`
- **Fabrication and cargo**: `Fabrication` handles supplies, storage/machine boxes, food rations, composting, fabrication recipes, and module resale with market flooding. Key files: `fabrication.js`
- **Logistics**: `Logistics` covers:
  - yard/port berth and flight;
  - transfer drones, two-way run plans, drone docks and charging;
  - the port hold, stripping wrecked drives, and the room-aboard checks.
  - Key files: `logistics.js`
- **Comms & Nav**: `CommsNav` generates the seeded sector, decides transceiver visibility, holds the market and purchase rules, and restocks drone-sized salvage. Key files: `comms_nav.js`
- **Persistence (client)**: `GameState` snapshots and restores the whole game, calls the REST API for saves and checkpoints, and does file export/import. Key files: `game_state.js`
- **Persistence (server)**: `db.js` has the schema-versioned SQLite migrations, named save slots, and a checkpoint tree with pruning and restore. Key files: `db.js`, `server.js`
- **Rewind UI**: `Timeline` takes hourly/start/save checkpoints and draws a rolled-up tree to go back to. Key files: `timeline.js`, `docs/rewind-readiness.md`
- **Seeded RNG**: `GameRng` (mulberry32) has saveable state; every gameplay roll goes through it. Key files: `rng.js`
- **Guidance**: `Tour` runs the first-run guided tour plus priority-ordered contextual tips on one spotlight card. Key files: `tour.js`
- **Observers**: `Notifications` (an event list from state diffs) and `SoundManager` (Web Audio synthesis from state diffs and UI clicks). Key files: `notifications.js`, `sound.js`
- **Callout positioning**: `Anchor` keeps floating messages fixed beside their target element. Key files: `anchor.js`
- **UI shell**: a single HTML page (dashboard card skeletons plus overlay screens) and CSS split into four imported sheets. Key files: `index.html`, `styles.css`, `css/*.css`
- **E2E tests**: Playwright specs driving the real page through the exposed `window.game`, plus direct `db.js` unit specs. Key files: `tests/`, `playwright.config.js`

---

### 3. File Index
**API / backend**
- `server.js` — Node `http` server: static files (path-traversal guarded) and the `/api/saves…` JSON routes; `PORT`, `GAME_DB_PATH` env.

**Frontend / UI**
- `index.html` — single page: launch, seed and intro screens; dashboard card groups; overlays (work queue, timeline, load, crew, comms & nav, ship capacity, drone run plan, cargo, sounds, pause). Loads the scripts in a fixed order.
- `main.js` — `Overlay` helper and `StarshipGame`: tick loop, `updateDisplay()` full re-render, card layout, all click handlers, the market/cargo/plan-run screens, saves, autosave; exposes `window.game`.
- `anchor.js` — `Anchor.attach/detach`: re-measures fixed-position callouts against their target every animation frame.
- `tour.js` — `Tour`: guided tour steps (`_buildSteps`) and contextual tips (`_buildTips`); seen-state in `localStorage`.
- `timeline.js` — `Timeline`: checkpoint timing, the rewind screen's SVG tree with month/week/day roll-up, and going back.
- `notifications.js` — `Notifications`: header pill and list; diffs state each redraw; direct `add()` for events with no state to diff.
- `sound.js` — `SoundManager`: synthesised UI/effect/alert/hum sounds, per-channel volume in `localStorage`; observer only, loaded after `main.js`.
- `styles.css` — entry stylesheet, `@import`s the four sheets below.
- `css/base.css` — reset and body layout.
- `css/backgrounds.css` — `body[data-bg]` themes: `space`, `city` (salvage yard), `port`, `flight` (animated); inline SVG layers.
- `css/menu.css` — launch screen, intro modal, pause overlay.
- `css/dashboard.css` — dashboard, fixed-height cards and groups, overlays, work queue columns, plan-run, market and cargo styles.
- `assets/ships/vagrant-mk1.svg` — ship illustration (intro, header thumbnail, capacity screen).

**Data / database**
- `db.js` — SQLite schema (`MIGRATIONS` array, `meta.schema_version`), save CRUD, per-ship and per-save table writers/readers, the checkpoint tree.
- `data/module_specs.json` — per-module, per-tier specs (power, output, mass/volume, `repairStages`), drives, `transferDrone`, `droneDock`.
- `data/ship_classes.json` — ship class blueprint (`version`, `classes`).
- `data/crew_manifest.json` — crew template (`id`, `classes`, `shifts`).
- `data/story_messages.json` — intro narrative keyed `new-game`.
- `data/ship_instances.json` — legacy flat ship state; not fetched or read by any code.
- `savegame/.gitkeep` — keeps the save directory; `savegame/game.db` (gitignored) is the live database.

**Infrastructure / config**
- `package.json` — `start` (`node --no-warnings server.js`) and `test` (`playwright test`) scripts; only dev dep `@playwright/test`.
- `package-lock.json` — npm lockfile.
- `playwright.config.js` — `testDir: ./tests`; starts `server.js` with `PORT` from `TEST_PORT` (default 3001) and `GAME_DB_PATH=test-results/test-game.db`; `reuseExistingServer: !process.env.CI`.
- `.gitignore` — ignores `node_modules/`, `test-results/`, Playwright reports and cache, `savegame/game.db`.

**Core logic / domain**
- `system_update.js` — `SystemUpdate`: physics and the order of the per-tick update; game-over check.
- `repair_manager.js` — `RepairManager`: decay, `efficiencyFor`, staged repair tasks, `processQueue`; unit keys for fitted modules, `box:<id>` and `drone:<id>`.
- `crew_manager.js` — `CrewManager`: roster merge, health impacts, availability, effectiveness, death.
- `fabrication.js` — `Fabrication`: items, boxes, food storage and eating, compost, recipes and fabrication jobs, machine-box modules, swap, resale value and flooding.
- `logistics.js` — `Logistics`: berth/flight, drones (buy, berth, launch, legs, charge, wear), `plan`/`planOut`, port hold orders and delivery, strip jobs, dock charging demand, capacity rows.
- `comms_nav.js` — `CommsNav`: seeded sector generation, range/visibility, market generation and restock, purchase rules, fitting modules.

**Utilities / shared**
- `rng.js` — `mulberry32(seed)` PRNG and `GameRng`, a wrapper whose state is saved with the game.
- `game_state.js` — `GameState`: `snapshot`/`shipInstanceSnapshot`/`restore` with legacy defaults; REST calls; JSON export/import.

**Docs**
- `README.md` — player-facing intro and early-concept status.
- `CLAUDE.md` — contributor and agent guidance: commands, architecture, invariants.
- `docs/rewind-readiness.md` — how rewind works and the rules for keeping new state compatible with it.
- `docs/repo-analysis-prompt.md` — the process that regenerates this file.
- `docs/repo-summary.md` — this file.

**Tests** (`tests/`, Playwright; one line per suite)
- `tests/helpers.js` — shared `test` fixture (tour/tips pre-dismissed), `startNewGame`, `bringCommsOnline`, `atPort`.
- `tests/atmosphere.spec.js` — CO2 vent equilibrium at large ticks.
- `tests/checkpoints.spec.js` — `db.js` checkpoint tree (thinning, restore, branches) and the Timeline UI.
- `tests/comms.spec.js` — sector generation, plane views, range-gated visibility.
- `tests/dashboard.spec.js` — grouped fixed-height cards, collapse/expand, layout stability.
- `tests/db.spec.js` — `db.js` unit tests run directly against SQLite (round-trips, ordering, migrations).
- `tests/fabrication.spec.js` — supplies, parts boxes, compost lifecycle, fabrication jobs, persistence.
- `tests/food-and-machine-boxes.spec.js` — meals and rationing, machine boxes, swap, resale and flooding.
- `tests/logistics.spec.js` — yard start, drones, two-way run planning, room aboard, restock, strip, dock, thrusters, flight, persistence.
- `tests/notifications.spec.js` — what gets listed, grouping, pill UI, persistence, related tips.
- `tests/persistence.spec.js` — autosave timer and message.
- `tests/repair.spec.js` — repair state, queue ordering, staged repairs, crew gating.
- `tests/rng.spec.js` — seeded determinism and saved RNG state.
- `tests/saves.spec.js` — named slots: create, list, load, delete.
- `tests/sound.spec.js` — sound triggers via `sound.log`, channels, Sounds panel.
- `tests/systems.spec.js` — power budget, market/water maker, water and black water (residue, spills, rationing), fatigue, idle crew.
- `tests/tour.spec.js` — header location, guided tour, tips holding the clock.
- `tests/_manual_capacity_modal_check.spec.js` — ship capacity modal opens and closes without console errors.

---

### 4. Data Model / Schema
- **Static reference** (read-only JSON fetched at startup, not checkpointed): module specs, ship classes, crew template, story text.
- **Live state** (`StarshipGame` instance properties):
  - `systems` (o2, co2, power, fuel, freshWater, blackWater, food, transceiver, waterMaker, thrusters, ionDrive);
  - `repairQueue`, `crewManifest`, `cargo.boxes`;
  - `market`, `moduleResale`, `commsLocations`;
  - `berth`, `flight`, `drones`, `droneDocks`, `portHold`;
  - `notifications.list`, `rng` state, `gameTime`, `credits`.
- **Save payload**: `{ world, shipInstances }` (`GameState.snapshot` and `shipInstanceSnapshot`), written in one PUT and one DB transaction.
- **SQLite tables** (`db.js`):
  - `saves` (`head_checkpoint_id`);
  - ship-scoped, keyed `(save_id, ship_id, …)`: `ships`, `ship_atmosphere`, `ship_modules`, `ship_battery`, `ship_fuel`, `ship_water` (incl. residue/spill columns), `ship_food`, `repair_tasks` (`kind`, `recipe_key`), `storage_boxes` (`contents` JSON), `ship_cargo_items` (legacy loose items), `ship_logistics`, `drones` (`plan`, `plan_out`, cargo as JSON), `port_hold` (`entry` JSON);
  - save-scoped, keyed `(save_id, id)`: `crew_members`, `comms_locations`, `market_listings`, `notifications`, `market_resale`;
  - `save_checkpoints` (`parent_id` tree, full JSON `payload`, `kind` ∈ `start|hourly|save|branch-end`);
  - `meta` (`schema_version`).
- **Relationships**:
  - a save has one ship (`'player-ship-1'`), whose modules, tasks, boxes, drones and hold all hang off `(save_id, ship_id)`;
  - checkpoints form a tree per save, with `saves.head_checkpoint_id` pointing at the current one;
  - repair tasks reference units by key: a system key, `box:<boxId>` or `drone:<droneId>`.

---

### 5. API / Interface Surface
- `GET /api/saves`: list saves (`db.listSaves`).
- `POST /api/saves` with `{ name }`: create a save. Returns 201; 400 if the name is missing, 409 if it's a duplicate.
- `GET /api/saves/:id`: returns `{ world, shipInstances }`, or 404.
- `PUT /api/saves/:id` with `{ world, shipInstances }`: `db.saveSave` in one transaction. Returns 400 or 500 on error.
- `DELETE /api/saves/:id`: delete the save and all its rows.
- `GET /api/saves/:id/checkpoints`: list the checkpoint tree.
- `POST /api/saves/:id/checkpoints` with `{ kind, world, shipInstances }`: `db.addCheckpoint`. `kind` must be one of `CHECKPOINT_KINDS`.
- `POST /api/saves/:id/checkpoints/:checkpointId/restore` with `{ current }`: `db.restoreCheckpoint` stores the live state as `branch-end` and returns the checkpoint's payload.
- `OPTIONS` (any path): 204. Any other path is a static file, with `/` serving `index.html`.
- `db.js` exports: `initDb`, `listSaves`, `createSave`, `deleteSave`, `getSave`, `saveSave`, `addCheckpoint`, `listCheckpoints`, `restoreCheckpoint`, `CHECKPOINT_KINDS`.
- Test seam: `window.game` (`StarshipGame`) and `window.sound` (`SoundManager`).

---

### 6. Control Flow
- **Startup**: `main.js` fetches the four reference JSON files and shows the launch screen.
- **New Game**: name prompt → seed screen (`CommsNav.rollSeed`) → `startNewGame()`:
  - pure defaults, `commsNav.generate(seed)`, starter boxes, `logistics.reset()`;
  - `start` checkpoint, intro, then the tour auto-starts for first-time players.
- **Load**: `#load-screen` → `GameState.loadServer` → `restore` (legacy defaults, residue re-split) → `timeline.onGameLoaded()`.
- **Tick** (`_startTimer`, every real second, unless paused or a tour card holds time):
  - `gameTime += gameSpeed`;
  - `systemUpdate.update(gameSpeed)`, in order: power budget → O2 → CO2 → transceiver → food (meals from `gameTime`) → water/black water/water maker → power and fuel (dock charging) → crew health → repair decay → work queue → fabrication → logistics (flight, drone legs, deliveries) → market restock → statuses → game-over check;
  - then `updateDisplay()` (full re-render, then `notifications.check()`), `tour.checkTips()` and `timeline.maybeCheckpoint()`.
- **Player actions**: delegated click handlers (`data-fab-action`, `data-logi-action`, button ids) call domain methods, which enforce their own `*Blocker()` rules, then redraw.
- **Trade**: `Logistics.tradeMode()` decides `direct` (berthed at the port) or `drone` (at the yard):
  - in drone mode, a purchase becomes a `portHold` order;
  - a drone's `plan` (inbound) and `planOut` (outbound) are loaded at `launch`/`_reachPort`;
  - sales are paid on arrival at the port, and goods are delivered aboard on return.
- **Save**: manual save, or autosave every real 5 minutes → `GameState.saveServer` → `PUT /api/saves/:id` (plus a `save` checkpoint for a manual save).
- **Rewind**: Timeline → `POST …/restore` → `restore` → `game.afterRewind()` (paused on the pause menu).
- **Observers**: `notifications.check()` after each redraw; `SoundManager._poll()` every 400 ms, diffing snapshots.

---

### 7. Dependencies
- External: `@playwright/test` (dev only). Runtime uses only Node built-ins (`http`, `fs`, `path`, `node:sqlite`) and browser APIs (Web Audio, `localStorage`, `fetch`, SVG).
- Frameworks: none (no bundler, no client framework).
- Internal:
  - load order `rng` → `game_state` → `system_update` → `repair_manager` → `fabrication` → `logistics` → `crew_manager` → `comms_nav` → `tour` → `timeline` → `notifications` → `anchor` → `main` → `sound`;
  - `StarshipGame` constructs every domain class;
  - domain classes read and write each other through `this.game`. Examples: `Fabrication` calls `logistics.tradeMode`, `CommsNav` calls `logistics.orderBlocker`, `RepairManager` calls `fabrication`/`logistics` for unit keys, `SystemUpdate` calls them all.

---

### 8. Important Notes
- **No encapsulation**: all live state is plain properties on `StarshipGame`, mutated directly by several classes. Grep for every reader before changing a field's shape.
- **Rewind invariants** (`docs/rewind-readiness.md`):
  - all state goes through `GameState` snapshot/restore;
  - `restore` must accept older payloads;
  - gameplay rolls use `game.rng.next()`, never `Math.random()`;
  - time-based events (meals, restock) are derived from `gameTime` rather than stored counters.
- **Large `dt`**: ticks can be up to 1000 game-seconds. Per-tick maths must clamp to equilibrium, loop through discrete events (meals, drone legs), or use an energy-over-tick budget (power).
- **Migrations are append-only**: a server applies them once, at startup. A long-running server (including one reused by Playwright through `reuseExistingServer`) keeps its old schema and can mask migration bugs.
- **Load order is load-bearing**: classes reference earlier globals by bare name. `sound.js` is deliberately loaded last and nothing calls into it.
- **Unit keys**: a work-queue task may lack a `systemKey` (fabricate/strip jobs) or use a `box:` or `drone:` key. Code iterating `repairQueue` must allow for all of these.
- **Observer pairing**: a new sound trigger should get a matching notification and vice versa, since both diff similar state.
- **Legacy**: `data/ship_instances.json` is never read. `ship_cargo_items` (loose cargo items from before boxes) is still written and read, but `GameState._applyCargo` packs such items into boxes. `world_save` is created by the first migration and dropped by a later one.
- **Security**: the server is plain HTTP, has no rate limiting, and echoes the exception message in the save-failure JSON response. It's intended for local use.
