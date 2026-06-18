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

const SYSTEM_KEYS = ['o2Generator', 'co2Scrubber', 'generator'];

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
        ['repair_tasks', 'ship_fuel', 'ship_battery', 'ship_modules', 'ship_atmosphere', 'ships'].forEach(table => {
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

    const world = {
        version: save.version,
        savedAt: save.updated_at,
        world: { gameTime: save.game_time, credits: save.credits, gameSpeed: save.game_speed },
        crew: { count: save.crew_count },
        shipInstanceId: save.ship_instance_id,
        environment: {
            inBreathableAtmosphere: !!save.in_breathable_atmosphere,
            ventsOpen: !!save.vents_open,
        },
    };

    const shipRows = db.prepare('SELECT * FROM ships WHERE save_id = ?').all(saveId);
    const shipInstances = { version: '1.0.0', ships: shipRows.map(sh => _composeShip(db, saveId, sh)) };

    return { world, shipInstances };
}

function _composeShip(db, saveId, shipRow) {
    const atm     = db.prepare('SELECT * FROM ship_atmosphere WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const modules = db.prepare('SELECT * FROM ship_modules WHERE save_id = ? AND ship_id = ?').all(saveId, shipRow.id);
    const byKey   = Object.fromEntries(modules.map(m => [m.system_key, m]));
    const battery = db.prepare('SELECT * FROM ship_battery WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const fuel    = db.prepare('SELECT * FROM ship_fuel WHERE save_id = ? AND ship_id = ?').get(saveId, shipRow.id) ?? {};
    const tasks   = db.prepare('SELECT * FROM repair_tasks WHERE save_id = ? AND ship_id = ? ORDER BY queue_position').all(saveId, shipRow.id);

    const moduleState = key => {
        const m = byKey[key] ?? {};
        return {
            active: !!m.active, count: m.count, tier: m.tier, target: m.target,
            repairPct: m.repair_pct, juryRigged: !!m.jury_rigged, destroyed: !!m.destroyed,
        };
    };

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
            fuel: { currentL: fuel.current_l, capacityL: fuel.capacity_l },
        },
        repairQueue: tasks.map(t => ({
            id: t.id, systemKey: t.system_key, band: t.band,
            totalHours: t.total_hours, hoursRemaining: t.hours_remaining, status: t.status,
        })),
    };
}

function saveSave(db, saveId, { world, shipInstances }) {
    db.exec('BEGIN');
    try {
        db.prepare(`
            UPDATE saves SET
                updated_at = ?, version = ?, game_time = ?, credits = ?, game_speed = ?,
                crew_count = ?, ship_instance_id = ?, in_breathable_atmosphere = ?, vents_open = ?
            WHERE id = ?
        `).run(
            new Date().toISOString(), world?.version ?? null,
            world?.world?.gameTime ?? null, world?.world?.credits ?? null, world?.world?.gameSpeed ?? null,
            world?.crew?.count ?? null, world?.shipInstanceId ?? null,
            world?.environment?.inBreathableAtmosphere ? 1 : 0, world?.environment?.ventsOpen ? 1 : 0,
            saveId
        );

        for (const ship of shipInstances?.ships ?? []) _saveOneShip(db, saveId, ship);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
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
        const m = s[key] ?? {};
        db.prepare(`
            INSERT INTO ship_modules (save_id, ship_id, system_key, active, count, tier, target, repair_pct, jury_rigged, destroyed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(save_id, ship_id, system_key) DO UPDATE SET
                active = excluded.active, count = excluded.count, tier = excluded.tier, target = excluded.target,
                repair_pct = excluded.repair_pct, jury_rigged = excluded.jury_rigged, destroyed = excluded.destroyed
        `).run(
            saveId, ship.id, key, m.active ? 1 : 0, m.count ?? null, m.tier ?? null, m.target ?? null,
            m.repairPct ?? 100, m.juryRigged ? 1 : 0, m.destroyed ? 1 : 0
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

    db.prepare('DELETE FROM repair_tasks WHERE save_id = ? AND ship_id = ?').run(saveId, ship.id);
    (ship.repairQueue ?? []).forEach((task, idx) => {
        db.prepare(`
            INSERT INTO repair_tasks (id, save_id, ship_id, system_key, band, total_hours, hours_remaining, status, queue_position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(task.id, saveId, ship.id, task.systemKey, task.band, task.totalHours, task.hoursRemaining, task.status, idx);
    });
}

module.exports = {
    initDb,
    listSaves, createSave, deleteSave,
    getSave, saveSave,
};
