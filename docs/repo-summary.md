# Repository Summary

### 1. Repository Overview
- Purpose: Browser dashboard game — player keeps a starship's life-support and power systems running, manages module wear/repair via a crew-limited task queue, and progresses a short narrative intro.
- Architectural style: Client-heavy monolith. No client framework/bundler; a minimal same-process Node HTTP server provides only static-file serving plus two JSON read/write routes for persistence.
- Runtime environment: Node.js (server.js, built-ins only — no npm runtime deps); browser-executed plain JavaScript (ES2015 classes, classic `<script>` tags, shared global scope, no modules/bundler).

---

### 2. Core Components
- **Game Orchestrator** — `StarshipGame` class — owns game state, DOM rendering, event bindings, the tick loop. Key files: `main.js`
- **Tick Physics Engine** — `SystemUpdate` class — per-tick O2/CO2/power/fuel simulation, consumes repair efficiency. Key files: `system_update.js`
- **Repair Domain Logic** — `RepairManager` class — module decay curve, crew-shift gating, repair task queue. Key files: `repair_manager.js`
- **Persistence** — `GameState` class — snapshot/restore world+ship state via the server API, plus file export/import. Key files: `game_state.js`
- **Dev/Static Server** — plain Node `http` server — serves all static assets, exposes `/api/save` and `/api/ship-instances`. Key files: `server.js`
- **Reference & Live Data** — flat JSON files, no database. Key files: `data/ship_classes.json`, `data/ship_instances.json`, `data/module_specs.json`, `data/crew_manifest.json`, `data/story_messages.json`
- **UI Shell** — single HTML page, screens toggled via inline `display`. Key files: `index.html`, `styles.css` (`@import`s `css/*.css`)
- **E2E Tests** — Playwright specs driving the real browser UI via a `window.game` test seam. Key files: `tests/repair.spec.js`, `playwright.config.js`

---

### 3. File Index
**Backend**
- `server.js` — Node `http` server; static file passthrough + `GET/POST /api/ship-instances`, `GET/POST/HEAD /api/save`

**Frontend / UI**
- `index.html` — single page; launch/intro/dashboard/pause/task-queue screens as sibling `<div>`s
- `main.js` — `StarshipGame`: game loop, DOM rendering, event wiring, repair UI, drag-reorder
- `styles.css`, `css/base.css`, `css/dashboard.css`, `css/menu.css`, `css/backgrounds.css` — visual styling

**Data**
- `data/ship_classes.json` — static ship blueprint specs (tiers, crew bounds)
- `data/ship_instances.json` — live per-ship system state + `repairQueue[]`
- `data/module_specs.json` — per-tier output/power-draw/degradation/repair-band specs
- `data/crew_manifest.json` — crew roster, classes, shift hours
- `data/story_messages.json` — narrative intro text (keyed by event name, e.g. `new-game`)
- `savegame/save.json` — world-state save file, written by `server.js`

**Infrastructure / config**
- `package.json`, `package-lock.json` — npm metadata; sole dependency is the dev-only `@playwright/test`
- `playwright.config.js` — e2e test runner config, auto-launches `server.js`
- `.gitignore`

**Core logic / domain**
- `system_update.js` — `SystemUpdate`: per-tick O2/CO2/power/fuel physics
- `repair_manager.js` — `RepairManager`: decay, efficiency curve, repair queue processing
- `game_state.js` — `GameState`: save/load/export/import (client-side serialization only)

**Utilities / shared**
- None — no shared-utility module exists; each class above is self-contained.

**Tests**
- `tests/repair.spec.js` — e2e coverage for repair decay, bands, shift-gated queue progress, cancel, both replacement outcomes, and the 2dp power-output regression

---

### 4. Data Model / Schema
- **Ship class** (static) — `id`, `specs`, `defaultSystems` — `data/ship_classes.json`
- **Ship instance** (live) — `id`, `classId`, `condition`, `systemState` (`atmosphere`, `o2Generator`, `co2Scrubber`, `battery`, `generator`, `fuel`), `repairQueue[]` — `data/ship_instances.json`
- **Module spec** (static) — keyed by type+tier: `powerDrawW`/`outputLhr`/`outputW`, `degradationPctPerHr`, `repair.{minor,major,replacement}` (`hours`, `restorePct`, `destroyChance`) — `data/module_specs.json`
- **Crew member** (static) — `id`, `name`, `classes[]`, `shifts[{startHour,endHour}]` — `data/crew_manifest.json`
- **Repair task** (runtime, embedded per ship) — `id`, `systemKey`, `band`, `totalHours`, `hoursRemaining`, `status`
- **Save snapshot** (world state) — `version`, `world{gameTime,credits,gameSpeed}`, `crew{count}`, `shipInstanceId`, `environment` — `savegame/save.json`

Relationships are plain in-memory id lookups across separate flat files, not joins: ship instance → `classId` → ship class; `systemState.*.tier` → `module_specs[type][tier]`; `repairQueue[].systemKey` → `systemState[systemKey]`. No relational database exists.

---

### 5. API / Interface Surface
- `GET /api/ship-instances` — returns `ship_instances.json` (404 if missing)
- `POST /api/ship-instances` — overwrites `ship_instances.json` (validates JSON; 400 if invalid)
- `GET /api/save` — returns `save.json` (404 if missing)
- `POST /api/save` — overwrites `save.json`
- `HEAD /api/save` — 200/404 existence check
- All other paths — static file passthrough from repo root, with a path-traversal guard
- No other server endpoints exist.
- Client-side test/debug surface: `window.game` — the live `StarshipGame` instance, exposed solely so `tests/repair.spec.js` can read/drive internal state.

---

### 6. Control Flow
- **Boot**: `DOMContentLoaded` → `new StarshipGame()` → fetches `data/ship_classes.json`, `ship_instances.json`, `story_messages.json`, `module_specs.json`, `crew_manifest.json` → shows launch screen.
- **New game**: launch screen → intro modal (text from `story_messages.json`) → `startNewGame()` seeds `this.systems`/`this.repairQueue` from the ship instance → `setInterval` tick loop starts.
- **Tick** (every 1 real second, scaled by `gameSpeed` ∈ {1,10,100,1000}×): `gameTime` advances → `SystemUpdate.update(dt)` runs O2 → CO2 → power/fuel → repair decay → repair-queue processing → status thresholds → `updateDisplay()` re-renders the whole dashboard imperatively (no virtual DOM/diffing).
- **Repair flow**: click a card's Repair button → `RepairManager.startRepair()` queues a task sized by the module's current repair band → each tick, on-shift engineering crew (matched against the ship clock via `crew_manifest.json`) work the front of the queue → on completion, `repairPct` is restored, or — on the risky "replacement" band — either jury-rigged (50% cap, 10× decay) or destroyed (1-in-5).
- **Save/Load**: `saveGame()`/`loadGame()` round-trip world + ship-instance state through the two `server.js` JSON endpoints (or a portable single-file export/import that never touches the server).

---

### 7. Dependencies
- External (runtime, shipped to the browser): none — zero npm packages; no framework, no bundler.
- Dev-only: `@playwright/test` (e2e browser testing; not shipped).
- Frameworks: none.
- Internal: `main.js` → `game_state.js`, `system_update.js`, `repair_manager.js` (all plain globals, wired by `<script>` load order in `index.html`); `system_update.js` → `repair_manager.js` (reads `game.repairManager.efficiency()`); all three of `game_state.js`/`system_update.js`/`repair_manager.js` read and write `main.js`'s `StarshipGame` instance properties directly (`this.systems`, `this.repairQueue`, `this.moduleSpecs`, `this.crewManifest`) — no encapsulation boundary between them.

---

### 8. Important Notes
- **No module boundary**: all four client classes mutate the same `StarshipGame` instance's properties directly; nothing is private or passed by interface.
- **Load-order coupling**: `main.js`, `system_update.js`, `repair_manager.js`, `game_state.js` are plain global-scope scripts — their `<script>` order in `index.html` is load-bearing and untested.
- **Non-atomic persistence**: `/api/save` and `/api/ship-instances` are two independent POSTs (see `GameState.saveServer`); a failure between them can leave world state and ship state out of sync.
- **Single-ship/single-player assumption hardcoded**: `shipInstanceId` defaults to `'player-ship-1'` throughout; the crew manifest currently holds exactly one member.
- **Deliberate test seam in production code**: `window.game` is exposed permanently in `main.js` purely so `tests/repair.spec.js` can drive internal state — an intentional but unusual test/production coupling.
- **Floating-point display risk**: numeric UI fields are explicitly rounded at render time; this has already caused one real bug (unrounded power-draw wattage leaking 16-digit floats once repair efficiency introduced non-terminating fractions) — any new calculated field needs the same explicit rounding.
