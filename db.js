// SQLite-backed persistence for named save slots (world state + ship instance
// state + repair queue, all scoped to a save). Static reference data (ship
// classes, module specs, crew manifest, story messages) stays as plain JSON in
// data/ — unrelated to this file.
//
// Uses node:sqlite (built-in, no npm install required) rather than a third-party
// driver, to keep `node server.js` working with zero install steps.

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const SYSTEM_KEYS = ['o2Generator', 'co2Scrubber', 'generator', 'transceiver', 'waterMaker', 'thrusters', 'ionDrive'];
const OPTIONAL_SYSTEM_KEYS = ['transceiver', 'waterMaker', 'thrusters', 'ionDrive']; // added after the first saves were written

// Each entry runs once, in order, against a fresh-or-upgrading DB. Append new
// entries here as the schema grows — never edit an already-shipped entry.
const MIGRATIONS = [
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS world_save (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version TEXT,
                game_time REAL,
                credits INTEGER,
                game_speed INTEGER,
                crew_count INTEGER,
                ship_instance_id TEXT,
                in_breathable_atmosphere INTEGER,
                vents_open INTEGER,
                saved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS ships (
                id TEXT PRIMARY KEY,
                name TEXT,
                registration TEXT
            );

            CREATE TABLE IF NOT EXISTS ship_atmosphere (
                ship_id TEXT PRIMARY KEY REFERENCES ships(id),
                o2_pct REAL,
                co2_pct REAL
            );

            CREATE TABLE IF NOT EXISTS ship_modules (
                ship_id TEXT REFERENCES ships(id),
                system_key TEXT,
                active INTEGER,
                count INTEGER,
                tier INTEGER,
                target REAL,
                repair_pct REAL,
                jury_rigged INTEGER,
                destroyed INTEGER,
                PRIMARY KEY (ship_id, system_key)
            );

            CREATE TABLE IF NOT EXISTS ship_battery (
                ship_id TEXT PRIMARY KEY REFERENCES ships(id),
                current_wh REAL,
                capacity_wh REAL,
                count INTEGER,
                tier INTEGER,
                target REAL
            );

            CREATE TABLE IF NOT EXISTS ship_fuel (
                ship_id TEXT PRIMARY KEY REFERENCES ships(id),
                current_l REAL,
                capacity_l REAL
            );

            CREATE TABLE IF NOT EXISTS repair_tasks (
                id TEXT PRIMARY KEY,
                ship_id TEXT REFERENCES ships(id),
                system_key TEXT,
                band TEXT,
                total_hours REAL,
                hours_remaining REAL,
                status TEXT,
                queue_position INTEGER
            );
        `);
    },
    // Multiple named save slots. world_save was always a singleton 1:1 with "the"
    // save; now every save has its own world columns, living directly on `saves`.
    // Ship-scoped tables gain a save_id column so the same ship id can exist once
    // per save. Pre-existing singleton-schema rows (save_id IS NULL) are simply
    // orphaned — this is pre-release dev data, not a real player save worth a
    // data-preserving migration.
    db => {
        db.exec(`
            DROP TABLE IF EXISTS world_save;

            CREATE TABLE saves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version TEXT,
                game_time REAL,
                credits INTEGER,
                game_speed INTEGER,
                crew_count INTEGER,
                ship_instance_id TEXT,
                in_breathable_atmosphere INTEGER,
                vents_open INTEGER
            );

            -- The original tables' PRIMARY KEY was on ship_id alone (singleton-save
            -- era) — ALTER TABLE can't change a primary key, so these are dropped and
            -- recreated with save_id as part of the key from the start. Acceptable
            -- data loss per the migration note above (pre-release dev data only).
            DROP TABLE IF EXISTS ships;
            CREATE TABLE ships (
                save_id INTEGER,
                id TEXT,
                name TEXT,
                registration TEXT,
                PRIMARY KEY (save_id, id)
            );

            DROP TABLE IF EXISTS ship_atmosphere;
            CREATE TABLE ship_atmosphere (
                save_id INTEGER,
                ship_id TEXT,
                o2_pct REAL,
                co2_pct REAL,
                PRIMARY KEY (save_id, ship_id)
            );

            DROP TABLE IF EXISTS ship_modules;
            CREATE TABLE ship_modules (
                save_id INTEGER,
                ship_id TEXT,
                system_key TEXT,
                active INTEGER,
                count INTEGER,
                tier INTEGER,
                target REAL,
                repair_pct REAL,
                jury_rigged INTEGER,
                destroyed INTEGER,
                PRIMARY KEY (save_id, ship_id, system_key)
            );

            DROP TABLE IF EXISTS ship_battery;
            CREATE TABLE ship_battery (
                save_id INTEGER,
                ship_id TEXT,
                current_wh REAL,
                capacity_wh REAL,
                count INTEGER,
                tier INTEGER,
                target REAL,
                PRIMARY KEY (save_id, ship_id)
            );

            DROP TABLE IF EXISTS ship_fuel;
            CREATE TABLE ship_fuel (
                save_id INTEGER,
                ship_id TEXT,
                current_l REAL,
                capacity_l REAL,
                PRIMARY KEY (save_id, ship_id)
            );

            -- Also recreated: its old "REFERENCES ships(id)" pointed at what was then
            -- a singleton primary key. ships.id is no longer unique on its own (only
            -- (save_id, id) is), so that foreign key is no longer valid — drop the
            -- reference entirely (deleteSave() already cleans these up explicitly,
            -- nothing relies on FK enforcement here). Task ids stay globally unique
            -- (timestamp + random), just gain a save_id to filter by.
            DROP TABLE IF EXISTS repair_tasks;
            CREATE TABLE repair_tasks (
                save_id INTEGER,
                id TEXT,
                ship_id TEXT,
                system_key TEXT,
                band TEXT,
                total_hours REAL,
                hours_remaining REAL,
                status TEXT,
                queue_position INTEGER,
                PRIMARY KEY (save_id, id)
            );
        `);
    },
    // Crew health/shifts, persisted per save (not ship-scoped — crew belongs
    // to the save, same as repair_tasks did before gaining save_id).
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS crew_members (
                save_id INTEGER,
                id TEXT,
                health REAL,
                variance_factor REAL,
                dead INTEGER,
                shifts TEXT,
                PRIMARY KEY (save_id, id)
            );
        `);
    },
    // Comms & Nav: the seeded sector roster (current location + discovered
    // points of interest), persisted per save like crew_members above.
    db => {
        db.exec(`
            ALTER TABLE saves ADD COLUMN comms_seed INTEGER;

            CREATE TABLE IF NOT EXISTS comms_locations (
                save_id INTEGER,
                id TEXT,
                kind TEXT,
                name TEXT,
                x REAL,
                y REAL,
                z REAL,
                PRIMARY KEY (save_id, id)
            );
        `);
    },
    // Fresh/black water tanks — no water makers yet, so fresh only drains and
    // must be manually topped up; black water accumulates from fresh usage.
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS ship_water (
                save_id INTEGER,
                ship_id TEXT,
                fresh_current_l REAL,
                fresh_capacity_l REAL,
                fresh_conservative_mode INTEGER,
                fresh_depleted_hours REAL,
                black_liquid_l REAL,
                black_solid_l REAL,
                black_capacity_l REAL,
                PRIMARY KEY (save_id, ship_id)
            );
        `);
    },
    // The fresh-water conservative/normal toggle was replaced by a ration
    // on/off mechanic with its own duration timer — recreated rather than
    // ALTERed for the same reason migration index 1 recreated its tables:
    // this is still pre-release dev data, not a real player save worth a
    // data-preserving migration. Only water state resets; every other table
    // (crew, atmosphere, modules, repair tasks, comms) is untouched.
    db => {
        db.exec(`
            DROP TABLE IF EXISTS ship_water;
            CREATE TABLE ship_water (
                save_id INTEGER,
                ship_id TEXT,
                fresh_current_l REAL,
                fresh_capacity_l REAL,
                fresh_rationing INTEGER,
                fresh_depleted_hours REAL,
                fresh_ration_hours REAL,
                black_liquid_l REAL,
                black_solid_l REAL,
                black_capacity_l REAL,
                PRIMARY KEY (save_id, ship_id)
            );
        `);
    },
    // Transceiver + water maker modules (rows in ship_modules like the rest;
    // `installed` is what distinguishes "no water maker fitted yet" from a
    // fitted one), black-water exposure time, and the local market's stock.
    db => {
        db.exec(`
            ALTER TABLE ship_modules ADD COLUMN installed INTEGER;
            ALTER TABLE ship_water ADD COLUMN black_exposure_hours REAL;

            CREATE TABLE IF NOT EXISTS market_listings (
                save_id INTEGER,
                id TEXT,
                location_id TEXT,
                module_key TEXT,
                name TEXT,
                repair_pct REAL,
                price INTEGER,
                PRIMARY KEY (save_id, id)
            );
        `);
    },
    // Staged repairs: a task now works up through stages toward a chosen level.
    db => {
        db.exec('ALTER TABLE repair_tasks ADD COLUMN target_pct REAL;');
    },
    // Seeded gameplay RNG: where its sequence is, so loading a save carries on
    // with the same rolls (rng.js, docs/rewind-readiness.md).
    db => {
        db.exec('ALTER TABLE saves ADD COLUMN rng_state INTEGER;');
    },
    // Rewind checkpoints (docs/rewind-readiness.md): a tree per save. Each row
    // holds a full {world, shipInstances} payload as JSON, plus its parent.
    // saves.head_checkpoint_id is the checkpoint the live state grew from,
    // which becomes the parent of the next checkpoint.
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS save_checkpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                save_id INTEGER NOT NULL,
                parent_id INTEGER,
                game_time REAL,
                created_at TEXT,
                kind TEXT,
                credits REAL,
                crew_count INTEGER,
                payload TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_save_checkpoints_save ON save_checkpoints (save_id);
            ALTER TABLE saves ADD COLUMN head_checkpoint_id INTEGER;
        `);
    },
    // Fabrication (fabrication.js): fabrication jobs share repair_tasks (a
    // `kind` and the recipe; system_key is null for them), supplies aboard
    // are counted per item, and storage boxes are rows of their own.
    db => {
        db.exec(`
            ALTER TABLE repair_tasks ADD COLUMN kind TEXT;
            ALTER TABLE repair_tasks ADD COLUMN recipe_key TEXT;

            CREATE TABLE IF NOT EXISTS ship_cargo_items (
                save_id INTEGER,
                ship_id TEXT,
                item_key TEXT,
                quantity INTEGER,
                PRIMARY KEY (save_id, ship_id, item_key)
            );

            CREATE TABLE IF NOT EXISTS storage_boxes (
                save_id INTEGER,
                ship_id TEXT,
                id TEXT,
                position INTEGER,
                kind TEXT,
                fill_l REAL,
                sealed INTEGER,
                compost_hours REAL,
                PRIMARY KEY (save_id, ship_id, id)
            );
        `);
    },
    // Notifications (notifications.js): the save's list, newest first by position.
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                save_id INTEGER,
                id TEXT,
                position INTEGER,
                key TEXT,
                level TEXT,
                title TEXT,
                detail TEXT,
                game_time REAL,
                count INTEGER,
                PRIMARY KEY (save_id, id)
            );
        `);
    },
    // Food and machine boxes (fabrication.js): a box has a size, and a machine
    // box can hold one module. Rations are kept in food boxes (kind 'food'),
    // so only the starvation clock needs a table of its own.
    db => {
        db.exec(`
            ALTER TABLE storage_boxes ADD COLUMN size TEXT;
            ALTER TABLE storage_boxes ADD COLUMN module_key TEXT;
            ALTER TABLE storage_boxes ADD COLUMN module_tier INTEGER;
            ALTER TABLE storage_boxes ADD COLUMN module_repair_pct REAL;
            ALTER TABLE storage_boxes ADD COLUMN module_jury_rigged INTEGER;
            ALTER TABLE storage_boxes ADD COLUMN module_destroyed INTEGER;

            CREATE TABLE IF NOT EXISTS ship_food (
                save_id INTEGER,
                ship_id TEXT,
                starved_hours REAL,
                PRIMARY KEY (save_id, ship_id)
            );
        `);
    },
    // Module resale (fabrication.js): recent sales per module type, which
    // hold the price of the next one down until they wear off.
    db => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS market_resale (
                save_id INTEGER,
                module_key TEXT,
                recent_sales REAL,
                PRIMARY KEY (save_id, module_key)
            );
        `);
    },
    // Black water the water maker can't reclaim (system_update.js
    // _runWaterMaker), and each crew member's rested duty hours: the hours a
    // day their body is used to, which follows a shift change over about a day
    // (crew_manager.js) instead of jumping with it.
    db => {
        db.exec(`
            ALTER TABLE ship_water ADD COLUMN black_residue_l REAL;
            ALTER TABLE crew_members ADD COLUMN rested_duty_hours REAL;
        `);
    },
    // Food rationing (half a ration a meal) and how long the crew have been underfed.
    db => {
        db.exec(`
            ALTER TABLE ship_food ADD COLUMN rationing INTEGER;
            ALTER TABLE ship_food ADD COLUMN ration_hours REAL;
        `);
    },
    // Logistics (logistics.js): where the ship is berthed (Harlow's yard or
    // Port Carrow) and any flight under way, drone docks, the transfer drones
    // (their loads are JSON lists, like crew shifts), and orders waiting at the
    // port. Supplies now live in storage boxes: a parts box's contents are a
    // JSON map of item -> count. The drives are ship_modules rows.
    db => {
        db.exec(`
            ALTER TABLE storage_boxes ADD COLUMN contents TEXT;

            CREATE TABLE IF NOT EXISTS ship_logistics (
                save_id INTEGER,
                ship_id TEXT,
                berth TEXT,
                flight_to TEXT,
                flight_hours_left REAL,
                flight_total_hours REAL,
                drone_docks INTEGER,
                PRIMARY KEY (save_id, ship_id)
            );

            CREATE TABLE IF NOT EXISTS drones (
                save_id INTEGER,
                ship_id TEXT,
                id TEXT,
                position INTEGER,
                tier INTEGER,
                state TEXT,
                hours_left REAL,
                charge_wh REAL,
                repair_pct REAL,
                jury_rigged INTEGER,
                cargo_out TEXT,
                cargo_in TEXT,
                PRIMARY KEY (save_id, ship_id, id)
            );

            CREATE TABLE IF NOT EXISTS port_hold (
                save_id INTEGER,
                ship_id TEXT,
                id TEXT,
                position INTEGER,
                entry TEXT,
                PRIMARY KEY (save_id, ship_id, id)
            );
        `);
    },
    // A drone's "charge from battery" switch (logistics.js).
    db => {
        db.exec('ALTER TABLE drones ADD COLUMN charge_from_battery INTEGER;');
    },
    // A drone's planned run: what it brings back from the port hold, as JSON.
    db => {
        db.exec('ALTER TABLE drones ADD COLUMN plan TEXT;');
    },
    // Black water spilled in the cabin, waiting to be cleaned up.
    db => {
        db.exec(`
            ALTER TABLE ship_water ADD COLUMN black_spill_liquid_l REAL;
            ALTER TABLE ship_water ADD COLUMN black_spill_solid_l REAL;
        `);
    },
    // A drone's planned run out: what it takes to the port to sell, as JSON.
    db => {
        db.exec('ALTER TABLE drones ADD COLUMN plan_out TEXT;');
    },
    // Where a drone flies back to (the ship may have flown on without it), and a
    // flight's fuel bill, now burnt over the flight rather than at lift-off.
    db => {
        db.exec(`
            ALTER TABLE drones ADD COLUMN base TEXT;
            ALTER TABLE ship_logistics ADD COLUMN flight_fuel_l REAL;
        `);
    },
];

function _ensureMetaTable(db) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
}

function _getSchemaVersion(db) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    return row ? parseInt(row.value, 10) : 0;
}

function _setSchemaVersion(db, v) {
    db.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(v));
}

function _runMigrations(db) {
    _ensureMetaTable(db);
    const startVersion = _getSchemaVersion(db);
    for (let i = startVersion; i < MIGRATIONS.length; i++) {
        db.exec('BEGIN');
        try {
            MIGRATIONS[i](db);
            _setSchemaVersion(db, i + 1);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}

function initDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    _runMigrations(db);
    return db;
}

// ── Saves list / lifecycle ──────────────────────────────────────────────────

function listSaves(db) {
    const rows = db.prepare('SELECT * FROM saves ORDER BY updated_at DESC, id DESC').all();
    return rows.map(r => ({
        id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
        day: r.game_time != null ? Math.floor(r.game_time / 86400) + 1 : 1,
        credits: r.credits,
    }));
}

function createSave(db, name) {
    const now = new Date().toISOString();
    try {
        const result = db.prepare(`
            INSERT INTO saves (name, created_at, updated_at, version, game_time, credits, game_speed, crew_count, ship_instance_id, in_breathable_atmosphere, vents_open)
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
        `).run(name, now, now);
        return { id: Number(result.lastInsertRowid) };
    } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) return null;
        throw e;
    }
}

function deleteSave(db, saveId) {
    db.exec('BEGIN');
    try {
        ['port_hold', 'drones', 'ship_logistics', 'notifications', 'market_resale', 'ship_food', 'storage_boxes', 'ship_cargo_items', 'save_checkpoints', 'market_listings', 'comms_locations', 'crew_members', 'repair_tasks', 'ship_water', 'ship_fuel', 'ship_battery', 'ship_modules', 'ship_atmosphere', 'ships'].forEach(table => {
            db.prepare(`DELETE FROM ${table} WHERE save_id = ?`).run(saveId);
        });
        db.prepare('DELETE FROM saves WHERE id = ?').run(saveId);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

// ── Save data (world + ship instance, combined) ─────────────────────────────

function getSave(db, saveId) {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(saveId);
    if (!save) return null;

    const crewRows = db.prepare('SELECT * FROM crew_members WHERE save_id = ?').all(saveId);
    const crewMembers = crewRows.map(r => ({
        id: r.id, health: r.health, varianceFactor: r.variance_factor,
        dead: !!r.dead, shifts: JSON.parse(r.shifts ?? '[]'),
        restedDutyHours: r.rested_duty_hours,
    }));

    const commsRows = db.prepare('SELECT * FROM comms_locations WHERE save_id = ?').all(saveId);
    const commsLocations = commsRows.map(r => ({
        id: r.id, kind: r.kind, name: r.name, x: r.x, y: r.y, z: r.z,
    }));

    const marketRows = db.prepare('SELECT * FROM market_listings WHERE save_id = ?').all(saveId);
    const resale = Object.fromEntries(db.prepare('SELECT * FROM market_resale WHERE save_id = ?').all(saveId)
        .map(r => [r.module_key, r.recent_sales]));
    const market = marketRows.map(r => ({
        id: r.id, locationId: r.location_id, moduleKey: r.module_key, name: r.name,
        repairPct: r.repair_pct, price: r.price,
    }));

    const notifications = db.prepare('SELECT * FROM notifications WHERE save_id = ? ORDER BY position').all(saveId).map(r => ({
        id: r.id, key: r.key ?? null, level: r.level, title: r.title, detail: r.detail ?? '',
        gameTime: r.game_time, count: r.count ?? 1,
    }));

    const world = {
        version: save.version,
        savedAt: save.updated_at,
        world: { gameTime: save.game_time, credits: save.credits, gameSpeed: save.game_speed },
        crew: { count: save.crew_count, members: crewMembers },
        comms: { seed: save.comms_seed, locations: commsLocations, market, resale },
        rng: { state: save.rng_state ?? null },
        shipInstanceId: save.ship_instance_id,
        environment: {
            inBreathableAtmosphere: !!save.in_breathable_atmosphere,
            ventsOpen: !!save.vents_open,
        },
        notifications,
    };

    const shipRows = db.prepare('SELECT * FROM ships WHERE save_id = ?').all(saveId);
    const shipInstances = { version: '1.0.0', ships: shipRows.map(sh => _composeShip(db, saveId, sh)) };

    return { world, shipInstances };
}

function _saveMarketResale(db, saveId, resale) {
    db.prepare('DELETE FROM market_resale WHERE save_id = ?').run(saveId);
    const insert = db.prepare('INSERT INTO market_resale (save_id, module_key, recent_sales) VALUES (?, ?, ?)');
    Object.entries(resale).forEach(([key, n]) => { if (n > 0) insert.run(saveId, key, n); });
}

function _composeShip(db, saveId, shipRow) {
    const atm     = db.prepare('SELECT * FROM ship_atmosphere WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const modules = db.prepare('SELECT * FROM ship_modules WHERE save_id = ? AND ship_id = ?').all(saveId, shipRow.id);
    const byKey   = Object.fromEntries(modules.map(m => [m.system_key, m]));
    const battery = db.prepare('SELECT * FROM ship_battery WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const fuel    = db.prepare('SELECT * FROM ship_fuel WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const water   = db.prepare('SELECT * FROM ship_water WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const tasks   = db.prepare('SELECT * FROM repair_tasks WHERE save_id = ? AND ship_id = ? ORDER BY queue_position').all(saveId, shipRow.id);
    const items   = db.prepare('SELECT * FROM ship_cargo_items WHERE save_id = ? AND ship_id = ?').all(saveId, shipRow.id);
    const boxes   = db.prepare('SELECT * FROM storage_boxes WHERE save_id = ? AND ship_id = ? ORDER BY position').all(saveId, shipRow.id);
    const food    = db.prepare('SELECT * FROM ship_food WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id);
    const logi    = db.prepare('SELECT * FROM ship_logistics WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id);
    const drones  = db.prepare('SELECT * FROM drones WHERE save_id = ? AND ship_id = ? ORDER BY position').all(saveId, shipRow.id);
    const hold    = db.prepare('SELECT * FROM port_hold WHERE save_id = ? AND ship_id = ? ORDER BY position').all(saveId, shipRow.id);
    const json    = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

    const moduleState = key => {
        const m = byKey[key] ?? {};
        return {
            active: !!m.active, count: m.count, tier: m.tier, target: m.target,
            repairPct: m.repair_pct, juryRigged: !!m.jury_rigged, destroyed: !!m.destroyed,
        };
    };
    // Modules added after the original three. `present` is false for a save
    // written before they existed, so the client can pick sensible defaults
    // instead of reading a row of nulls as "broken and switched off".
    const optionalModuleState = key => ({
        ...moduleState(key),
        present: !!byKey[key],
        installed: byKey[key]?.installed == null ? null : !!byKey[key].installed,
    });

    return {
        id: shipRow.id, name: shipRow.name, registration: shipRow.registration,
        systemState: {
            atmosphere:  { o2Pct: atm.o2_pct, co2Pct: atm.co2_pct },
            o2Generator: moduleState('o2Generator'),
            co2Scrubber: moduleState('co2Scrubber'),
            battery: {
                currentWh: battery.current_wh, capacityWh: battery.capacity_wh,
                count: battery.count, tier: battery.tier, target: battery.target,
            },
            generator: moduleState('generator'),
            transceiver: optionalModuleState('transceiver'),
            waterMaker: optionalModuleState('waterMaker'),
            thrusters: optionalModuleState('thrusters'),
            ionDrive: optionalModuleState('ionDrive'),
            fuel: { currentL: fuel.current_l, capacityL: fuel.capacity_l },
            water: {
                freshCurrentL: water.fresh_current_l, freshCapacityL: water.fresh_capacity_l,
                rationing: water.fresh_rationing == null ? null : !!water.fresh_rationing,
                freshDepletedHours: water.fresh_depleted_hours,
                rationHours: water.fresh_ration_hours,
                blackLiquidL: water.black_liquid_l, blackSolidL: water.black_solid_l, blackCapacityL: water.black_capacity_l,
                blackExposureHours: water.black_exposure_hours,
                blackResidueL: water.black_residue_l,
                blackSpillLiquidL: water.black_spill_liquid_l,
                blackSpillSolidL: water.black_spill_solid_l,
            },
            // `present` is false for a save written before food existed (no row).
            food: {
                present: !!food, starvedHours: food?.starved_hours ?? null,
                rationing: food?.rationing == null ? null : !!food.rationing, rationHours: food?.ration_hours ?? null,
            },
        },
        repairQueue: tasks.map(t => (t.kind === 'fabricate' || t.kind === 'strip')
            ? {
                id: t.id, kind: t.kind, recipeKey: t.recipe_key, band: t.band,
                totalHours: t.total_hours, hoursRemaining: t.hours_remaining, status: t.status,
            }
            : {
                id: t.id, systemKey: t.system_key, band: t.band,
                totalHours: t.total_hours, hoursRemaining: t.hours_remaining, status: t.status,
                targetPct: t.target_pct ?? 100, // tasks saved before repair targets existed were full repairs
            }),
        cargo: {
            items: Object.fromEntries(items.map(r => [r.item_key, r.quantity ?? 0])),
            boxes: boxes.map(b => ({
                id: b.id, size: b.size ?? 'standard', kind: b.kind ?? null, fillL: b.fill_l ?? 0,
                sealed: !!b.sealed, compostHours: b.compost_hours ?? 0,
                parts: b.kind === 'parts' ? json(b.contents, {}) : null,
                module: b.module_key ? {
                    moduleKey: b.module_key, tier: b.module_tier ?? 1, repairPct: b.module_repair_pct ?? 100,
                    juryRigged: !!b.module_jury_rigged, destroyed: !!b.module_destroyed,
                } : null,
            })),
        },
        // Absent (null) for a save written before logistics: the client starts it at the yard.
        logistics: logi ? {
            berth: logi.berth ?? 'yard',
            flight: logi.flight_to ? { to: logi.flight_to, hoursLeft: logi.flight_hours_left ?? 0, totalHours: logi.flight_total_hours ?? 0, fuelL: logi.flight_fuel_l ?? 0 } : null,
            droneDocks: logi.drone_docks ?? 0,
            drones: drones.map(d => ({
                id: d.id, tier: d.tier ?? 1, state: d.state, hoursLeft: d.hours_left ?? 0, chargeWh: d.charge_wh ?? 0,
                chargeFromBattery: !!d.charge_from_battery,
                plan: json(d.plan, []),
                planOut: json(d.plan_out, []),
                repairPct: d.repair_pct ?? 100, juryRigged: !!d.jury_rigged,
                cargoOut: json(d.cargo_out, []), cargoIn: json(d.cargo_in, []),
                base: d.base ?? null,
            })),
            portHold: hold.map(h => json(h.entry, null)).filter(Boolean),
        } : null,
    };
}

function saveSave(db, saveId, payload) {
    db.exec('BEGIN');
    try {
        _writeSave(db, saveId, payload);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

// saveSave's body without its own transaction, so restoreCheckpoint can write
// the live state as part of its transaction.
function _writeSave(db, saveId, { world, shipInstances }) {
        db.prepare(`
            UPDATE saves SET
                updated_at = ?, version = ?, game_time = ?, credits = ?, game_speed = ?,
                crew_count = ?, ship_instance_id = ?, in_breathable_atmosphere = ?, vents_open = ?, comms_seed = ?,
                rng_state = ?
            WHERE id = ?
        `).run(
            new Date().toISOString(), world?.version ?? null,
            world?.world?.gameTime ?? null, world?.world?.credits ?? null, world?.world?.gameSpeed ?? null,
            world?.crew?.count ?? null, world?.shipInstanceId ?? null,
            world?.environment?.inBreathableAtmosphere ? 1 : 0, world?.environment?.ventsOpen ? 1 : 0,
            world?.comms?.seed ?? null,
            world?.rng?.state ?? null,
            saveId
        );

        for (const ship of shipInstances?.ships ?? []) _saveOneShip(db, saveId, ship);
        _saveCrewMembers(db, saveId, world?.crew?.members ?? []);
        _saveCommsLocations(db, saveId, world?.comms?.locations ?? []);
        _saveMarketListings(db, saveId, world?.comms?.market ?? []);
        _saveMarketResale(db, saveId, world?.comms?.resale ?? {});
        _saveNotifications(db, saveId, world?.notifications ?? []);
}

// ── Rewind checkpoints ──────────────────────────────────────────────────────
// A tree of full-state snapshots per save. Going back never loses anything:
// the state being left is kept as a 'branch-end', and checkpoints made after
// going back are added under the checkpoint you went back to.

const CHECKPOINT_KINDS = ['start', 'hourly', 'save', 'branch-end'];
const CHECKPOINT_RECENT_S = 86400; // every hourly checkpoint within a game day of the newest is kept

function _insertCheckpoint(db, saveId, parentId, kind, payload) {
    const result = db.prepare(`
        INSERT INTO save_checkpoints (save_id, parent_id, game_time, created_at, kind, credits, crew_count, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        saveId, parentId ?? null,
        payload?.world?.world?.gameTime ?? 0, new Date().toISOString(), kind,
        payload?.world?.world?.credits ?? null, payload?.world?.crew?.count ?? null,
        JSON.stringify({ world: payload?.world ?? null, shipInstances: payload?.shipInstances ?? null })
    );
    return Number(result.lastInsertRowid);
}

function _headCheckpointId(db, saveId) {
    return db.prepare('SELECT head_checkpoint_id AS head FROM saves WHERE id = ?').get(saveId)?.head ?? null;
}

function _setHead(db, saveId, checkpointId) {
    db.prepare('UPDATE saves SET head_checkpoint_id = ? WHERE id = ?').run(checkpointId, saveId);
}

// Thins the line leading to `newestId`: hourly checkpoints more than a game
// day older than it are cut down to the earliest one of each game day. Start,
// manual saves, branch ends and branch points (more than one child) are always
// kept. A removed checkpoint's only child is re-attached to the removed
// checkpoint's parent, so the tree stays connected.
function _pruneCheckpoints(db, saveId, newestId) {
    const rows = db.prepare('SELECT id, parent_id, game_time, kind FROM save_checkpoints WHERE save_id = ?').all(saveId);
    const byId = new Map(rows.map(r => [r.id, { ...r }]));
    const childCount = new Map();
    rows.forEach(r => { if (r.parent_id != null) childCount.set(r.parent_id, (childCount.get(r.parent_id) ?? 0) + 1); });

    const newest = byId.get(newestId);
    if (!newest) return;

    const chain = []; // root first, ending with `newest`
    const seen = new Set([newestId]);
    for (let p = byId.get(newest.parent_id); p && !seen.has(p.id); p = byId.get(p.parent_id)) {
        seen.add(p.id);
        chain.unshift(p);
    }
    chain.push(newest);

    const keptDays = new Set();
    const reparent = db.prepare('UPDATE save_checkpoints SET parent_id = ? WHERE id = ?');
    const remove   = db.prepare('DELETE FROM save_checkpoints WHERE id = ?');
    for (let i = 0; i < chain.length - 1; i++) {
        const cp = chain[i];
        if (cp.kind !== 'hourly') continue;
        if (newest.game_time - cp.game_time < CHECKPOINT_RECENT_S) continue;
        if ((childCount.get(cp.id) ?? 0) > 1) continue;
        const day = Math.floor(cp.game_time / 86400);
        if (!keptDays.has(day)) { keptDays.add(day); continue; }

        const child = chain[i + 1];
        reparent.run(cp.parent_id, child.id);
        child.parent_id = cp.parent_id;
        remove.run(cp.id);
    }
}

// Adds a checkpoint after the current head and makes it the new head.
// Returns null if the save doesn't exist.
function addCheckpoint(db, saveId, kind, payload) {
    if (!CHECKPOINT_KINDS.includes(kind)) throw new Error('Unknown checkpoint kind');
    if (!db.prepare('SELECT 1 FROM saves WHERE id = ?').get(saveId)) return null;
    db.exec('BEGIN');
    try {
        const id = _insertCheckpoint(db, saveId, _headCheckpointId(db, saveId), kind, payload);
        _setHead(db, saveId, id);
        _pruneCheckpoints(db, saveId, id);
        db.exec('COMMIT');
        return { id };
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

// The tree without its payloads, for drawing the timeline.
function listCheckpoints(db, saveId) {
    const rows = db.prepare(`
        SELECT id, parent_id, game_time, created_at, kind, credits, crew_count
        FROM save_checkpoints WHERE save_id = ? ORDER BY game_time, id
    `).all(saveId);
    return {
        headId: _headCheckpointId(db, saveId),
        checkpoints: rows.map(r => ({
            id: r.id, parentId: r.parent_id, gameTime: r.game_time, createdAt: r.created_at,
            kind: r.kind, credits: r.credits, crewCount: r.crew_count,
        })),
    };
}

// Goes back to `checkpointId`, all in one transaction. First `current` (the
// live state being left) is kept as a 'branch-end' after the head, unless it's
// still at the head's exact game time (nothing played since). Then the
// checkpoint's payload becomes the live save, and the checkpoint becomes the
// head, so play from here starts a new branch under it. Returns that payload,
// or null if the checkpoint isn't one of this save's.
function restoreCheckpoint(db, saveId, checkpointId, current) {
    const target = db.prepare('SELECT payload FROM save_checkpoints WHERE id = ? AND save_id = ?').get(checkpointId, saveId);
    if (!target) return null;
    const payload = JSON.parse(target.payload);

    db.exec('BEGIN');
    try {
        const headId = _headCheckpointId(db, saveId);
        const head = headId != null
            ? db.prepare('SELECT game_time FROM save_checkpoints WHERE id = ?').get(headId)
            : null;
        const currentTime = current?.world?.world?.gameTime;
        if (current?.world && !(head && head.game_time === currentTime)) {
            _insertCheckpoint(db, saveId, headId, 'branch-end', current);
        }
        _writeSave(db, saveId, payload);
        _setHead(db, saveId, checkpointId);
        db.exec('COMMIT');
        return payload;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

function _saveCrewMembers(db, saveId, members) {
    db.prepare('DELETE FROM crew_members WHERE save_id = ?').run(saveId);
    members.forEach(m => {
        db.prepare(`
            INSERT INTO crew_members (save_id, id, health, variance_factor, dead, shifts, rested_duty_hours)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(saveId, m.id, m.health, m.varianceFactor, m.dead ? 1 : 0, JSON.stringify(m.shifts ?? []), m.restedDutyHours ?? null);
    });
}

function _saveCommsLocations(db, saveId, locations) {
    db.prepare('DELETE FROM comms_locations WHERE save_id = ?').run(saveId);
    locations.forEach(loc => {
        db.prepare(`
            INSERT INTO comms_locations (save_id, id, kind, name, x, y, z)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(saveId, loc.id, loc.kind, loc.name, loc.x, loc.y, loc.z);
    });
}

function _saveMarketListings(db, saveId, listings) {
    db.prepare('DELETE FROM market_listings WHERE save_id = ?').run(saveId);
    listings.forEach(l => {
        db.prepare(`
            INSERT INTO market_listings (save_id, id, location_id, module_key, name, repair_pct, price)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(saveId, l.id, l.locationId ?? null, l.moduleKey ?? null, l.name ?? null, l.repairPct ?? null, l.price ?? null);
    });
}

function _saveNotifications(db, saveId, notifications) {
    db.prepare('DELETE FROM notifications WHERE save_id = ?').run(saveId);
    const insert = db.prepare(`
        INSERT INTO notifications (save_id, id, position, key, level, title, detail, game_time, count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    notifications.forEach((n, i) => {
        insert.run(saveId, String(n.id), i, n.key ?? null, n.level ?? 'info', String(n.title ?? ''),
            n.detail ?? '', n.gameTime ?? 0, n.count ?? 1);
    });
}

function _saveOneShip(db, saveId, ship) {
    db.prepare(`
        INSERT INTO ships (id, name, registration, save_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(save_id, id) DO UPDATE SET name = excluded.name, registration = excluded.registration
    `).run(ship.id, ship.name ?? null, ship.registration ?? null, saveId);

    const s   = ship.systemState ?? {};
    const atm = s.atmosphere ?? {};
    db.prepare(`
        INSERT INTO ship_atmosphere (save_id, ship_id, o2_pct, co2_pct) VALUES (?, ?, ?, ?)
        ON CONFLICT(save_id, ship_id) DO UPDATE SET o2_pct = excluded.o2_pct, co2_pct = excluded.co2_pct
    `).run(saveId, ship.id, atm.o2Pct ?? null, atm.co2Pct ?? null);

    for (const key of SYSTEM_KEYS) {
        // A payload from before the newer modules existed carries no entry for
        // them — write no row at all rather than a row of defaults.
        if (s[key] == null && OPTIONAL_SYSTEM_KEYS.includes(key)) continue;
        const m = s[key] ?? {};
        db.prepare(`
            INSERT INTO ship_modules (save_id, ship_id, system_key, active, count, tier, target, repair_pct, jury_rigged, destroyed, installed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(save_id, ship_id, system_key) DO UPDATE SET
                active = excluded.active, count = excluded.count, tier = excluded.tier, target = excluded.target,
                repair_pct = excluded.repair_pct, jury_rigged = excluded.jury_rigged, destroyed = excluded.destroyed,
                installed = excluded.installed
        `).run(
            saveId, ship.id, key, m.active ? 1 : 0, m.count ?? null, m.tier ?? null, m.target ?? null,
            m.repairPct ?? 100, m.juryRigged ? 1 : 0, m.destroyed ? 1 : 0,
            m.installed == null ? null : (m.installed ? 1 : 0)
        );
    }

    const battery = s.battery ?? {};
    db.prepare(`
        INSERT INTO ship_battery (save_id, ship_id, current_wh, capacity_wh, count, tier, target)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(save_id, ship_id) DO UPDATE SET
            current_wh = excluded.current_wh, capacity_wh = excluded.capacity_wh,
            count = excluded.count, tier = excluded.tier, target = excluded.target
    `).run(saveId, ship.id, battery.currentWh ?? null, battery.capacityWh ?? null, battery.count ?? null, battery.tier ?? null, battery.target ?? null);

    const fuel = s.fuel ?? {};
    db.prepare(`
        INSERT INTO ship_fuel (save_id, ship_id, current_l, capacity_l) VALUES (?, ?, ?, ?)
        ON CONFLICT(save_id, ship_id) DO UPDATE SET current_l = excluded.current_l, capacity_l = excluded.capacity_l
    `).run(saveId, ship.id, fuel.currentL ?? null, fuel.capacityL ?? null);

    const water = s.water ?? {};
    db.prepare(`
        INSERT INTO ship_water (save_id, ship_id, fresh_current_l, fresh_capacity_l, fresh_rationing, fresh_depleted_hours, fresh_ration_hours, black_liquid_l, black_solid_l, black_capacity_l, black_exposure_hours, black_residue_l, black_spill_liquid_l, black_spill_solid_l)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(save_id, ship_id) DO UPDATE SET
            fresh_current_l = excluded.fresh_current_l, fresh_capacity_l = excluded.fresh_capacity_l,
            fresh_rationing = excluded.fresh_rationing, fresh_depleted_hours = excluded.fresh_depleted_hours,
            fresh_ration_hours = excluded.fresh_ration_hours,
            black_liquid_l = excluded.black_liquid_l, black_solid_l = excluded.black_solid_l, black_capacity_l = excluded.black_capacity_l,
            black_exposure_hours = excluded.black_exposure_hours, black_residue_l = excluded.black_residue_l,
            black_spill_liquid_l = excluded.black_spill_liquid_l, black_spill_solid_l = excluded.black_spill_solid_l
    `).run(
        saveId, ship.id, water.freshCurrentL ?? null, water.freshCapacityL ?? null,
        water.rationing ? 1 : 0, water.freshDepletedHours ?? null, water.rationHours ?? null,
        water.blackLiquidL ?? null, water.blackSolidL ?? null, water.blackCapacityL ?? null,
        water.blackExposureHours ?? null, water.blackResidueL ?? null,
        water.blackSpillLiquidL ?? null, water.blackSpillSolidL ?? null
    );

    db.prepare('DELETE FROM repair_tasks WHERE save_id = ? AND ship_id = ?').run(saveId, ship.id);
    (ship.repairQueue ?? []).forEach((task, idx) => {
        db.prepare(`
            INSERT INTO repair_tasks (id, save_id, ship_id, system_key, band, total_hours, hours_remaining, status, queue_position, target_pct, kind, recipe_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            task.id, saveId, ship.id, task.systemKey ?? null, task.band ?? null, task.totalHours, task.hoursRemaining, task.status, idx,
            (task.kind === 'fabricate' || task.kind === 'strip') ? null : (task.targetPct ?? 100),
            task.kind ?? 'repair', task.recipeKey ?? null
        );
    });

    db.prepare('DELETE FROM ship_cargo_items WHERE save_id = ? AND ship_id = ?').run(saveId, ship.id);
    db.prepare('DELETE FROM storage_boxes WHERE save_id = ? AND ship_id = ?').run(saveId, ship.id);
    Object.entries(ship.cargo?.items ?? {}).forEach(([key, quantity]) => {
        db.prepare('INSERT INTO ship_cargo_items (save_id, ship_id, item_key, quantity) VALUES (?, ?, ?, ?)')
            .run(saveId, ship.id, key, quantity ?? 0);
    });
    (ship.cargo?.boxes ?? []).forEach((box, idx) => {
        const m = box.module;
        db.prepare(`
            INSERT INTO storage_boxes (save_id, ship_id, id, position, kind, fill_l, sealed, compost_hours,
                size, module_key, module_tier, module_repair_pct, module_jury_rigged, module_destroyed, contents)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(saveId, ship.id, box.id, idx, box.kind ?? null, box.fillL ?? 0, box.sealed ? 1 : 0, box.compostHours ?? 0,
            box.size ?? 'standard', m?.moduleKey ?? null, m ? (m.tier ?? 1) : null, m ? (m.repairPct ?? 100) : null,
            m ? (m.juryRigged ? 1 : 0) : null, m ? (m.destroyed ? 1 : 0) : null,
            box.parts ? JSON.stringify(box.parts) : null);
    });

    _saveLogistics(db, saveId, ship.id, ship.logistics);

    // A payload from before food existed carries no food state: write no row,
    // so loading it still reads as "no food state" and gets starter rations.
    db.prepare('DELETE FROM ship_food WHERE save_id = ? AND ship_id = ?').run(saveId, ship.id);
    const food = s.food;
    if (food && food.present !== false && food.starvedHours != null) {
        db.prepare('INSERT INTO ship_food (save_id, ship_id, starved_hours, rationing, ration_hours) VALUES (?, ?, ?, ?, ?)')
            .run(saveId, ship.id, food.starvedHours, food.rationing ? 1 : 0, food.rationHours ?? 0);
    }
}

// Berth, drones and the port hold. A payload from before logistics carries
// none: write no rows, so loading it still reads as "start at the yard".
function _saveLogistics(db, saveId, shipId, logi) {
    ['ship_logistics', 'drones', 'port_hold'].forEach(table =>
        db.prepare(`DELETE FROM ${table} WHERE save_id = ? AND ship_id = ?`).run(saveId, shipId));
    if (!logi) return;
    db.prepare(`
        INSERT INTO ship_logistics (save_id, ship_id, berth, flight_to, flight_hours_left, flight_total_hours, drone_docks, flight_fuel_l)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saveId, shipId, logi.berth ?? 'yard', logi.flight?.to ?? null, logi.flight?.hoursLeft ?? null,
        logi.flight?.totalHours ?? null, logi.droneDocks ?? 0, logi.flight?.fuelL ?? null);
    const insertDrone = db.prepare(`
        INSERT INTO drones (save_id, ship_id, id, position, tier, state, hours_left, charge_wh, repair_pct, jury_rigged, cargo_out, cargo_in, charge_from_battery, plan, plan_out, base)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (logi.drones ?? []).forEach((d, i) => insertDrone.run(saveId, shipId, String(d.id), i, d.tier ?? 1, d.state ?? 'stowed',
        d.hoursLeft ?? 0, d.chargeWh ?? 0, d.repairPct ?? 100, d.juryRigged ? 1 : 0,
        JSON.stringify(d.cargoOut ?? []), JSON.stringify(d.cargoIn ?? []), d.chargeFromBattery ? 1 : 0,
        JSON.stringify(d.plan ?? []), JSON.stringify(d.planOut ?? []), d.base ?? null));
    const insertHold = db.prepare('INSERT INTO port_hold (save_id, ship_id, id, position, entry) VALUES (?, ?, ?, ?, ?)');
    (logi.portHold ?? []).forEach((e, i) => insertHold.run(saveId, shipId, String(e.id ?? `hold-${i}`), i, JSON.stringify(e)));
}

module.exports = {
    initDb,
    listSaves, createSave, deleteSave,
    getSave, saveSave,
    addCheckpoint, listCheckpoints, restoreCheckpoint, CHECKPOINT_KINDS,
};
