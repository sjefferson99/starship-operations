// Unit-level coverage for db.js, exercised directly (no browser, no HTTP, no
// real server). Uses in-memory SQLite so it never touches the developer's
// actual savegame/game.db.
const { test, expect } = require('@playwright/test');
const db = require('../db.js');

function sampleShip(overrides = {}) {
    return {
        id: 'player-ship-1', name: 'Stray Light', registration: 'PDR-4471-K',
        systemState: {
            atmosphere: { o2Pct: 21.0, co2Pct: 0.04 },
            o2Generator: { active: true, count: 1, tier: 1, target: 21.0, repairPct: 80, juryRigged: false, destroyed: false },
            co2Scrubber: { active: false, count: 1, tier: 1, target: 0.04, repairPct: 25, juryRigged: true, destroyed: false },
            battery: { currentWh: 500, capacityWh: 1000, count: 1, tier: 1, target: 80 },
            generator: { active: false, repairPct: 0, juryRigged: true, destroyed: true },
            fuel: { currentL: 42.5, capacityL: 100 },
        },
        repairQueue: [
            { id: 'task-1', systemKey: 'o2', band: 'minor', totalHours: 3, hoursRemaining: 1.5, status: 'in-progress' },
            { id: 'task-2', systemKey: 'co2', band: 'major', totalHours: 10, hoursRemaining: 10, status: 'queued' },
        ],
        ...overrides,
    };
}

function sampleWorld(overrides = {}) {
    return {
        version: '2.0.0',
        world: { gameTime: 12345, credits: 980, gameSpeed: 10 },
        crew: { count: 1 },
        shipInstanceId: 'player-ship-1',
        environment: { inBreathableAtmosphere: true, ventsOpen: false },
        ...overrides,
    };
}

test.describe('db.js', () => {
    test('a fresh database has no saves', () => {
        const conn = db.initDb(':memory:');
        expect(db.listSaves(conn)).toEqual([]);
        expect(db.getSave(conn, 1)).toBeNull();
    });

    test('createSave returns an id, and rejects a duplicate name with null', () => {
        const conn = db.initDb(':memory:');
        const created = db.createSave(conn, 'Run A');
        expect(created).toHaveProperty('id');
        expect(db.createSave(conn, 'Run A')).toBeNull();
        expect(db.createSave(conn, 'Run B')).toHaveProperty('id');
    });

    test('listSaves reflects name/day/credits and is ordered most-recently-updated first', () => {
        const conn = db.initDb(':memory:');
        const a = db.createSave(conn, 'Older');
        const b = db.createSave(conn, 'Newer');
        db.saveSave(conn, a.id, { world: sampleWorld({ world: { gameTime: 86400, credits: 500, gameSpeed: 1 } }), shipInstances: { ships: [] } });
        db.saveSave(conn, b.id, { world: sampleWorld({ world: { gameTime: 0, credits: 1000, gameSpeed: 1 } }), shipInstances: { ships: [] } });

        const list = db.listSaves(conn);
        expect(list.map(s => s.name)).toEqual(['Newer', 'Older']); // most recently saved/updated first
        expect(list.find(s => s.name === 'Older')).toMatchObject({ day: 2, credits: 500 });
        expect(list.find(s => s.name === 'Newer')).toMatchObject({ day: 1, credits: 1000 });
    });

    test('saveSave / getSave round-trip world + ship data exactly, including booleans and queue order', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run A');

        db.saveSave(conn, id, { world: sampleWorld(), shipInstances: { version: '1.0.0', ships: [sampleShip()] } });
        const result = db.getSave(conn, id);

        expect(result.world).toEqual({
            version: '2.0.0', savedAt: result.world.savedAt,
            world: { gameTime: 12345, credits: 980, gameSpeed: 10 },
            crew: { count: 1 }, shipInstanceId: 'player-ship-1',
            environment: { inBreathableAtmosphere: true, ventsOpen: false },
        });

        const ship = result.shipInstances.ships[0];
        expect(ship.id).toBe('player-ship-1');
        expect(ship.systemState.o2Generator).toEqual({ active: true, count: 1, tier: 1, target: 21.0, repairPct: 80, juryRigged: false, destroyed: false });
        expect(ship.systemState.generator).toEqual({ active: false, count: null, tier: null, target: null, repairPct: 0, juryRigged: true, destroyed: true });
        expect(ship.repairQueue.map(t => t.id)).toEqual(['task-1', 'task-2']);
    });

    test('re-saving fully replaces the repair queue rather than appending', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run A');
        db.saveSave(conn, id, { world: sampleWorld(), shipInstances: { ships: [sampleShip()] } });

        const reordered = sampleShip({
            repairQueue: [{ id: 'task-2', systemKey: 'co2', band: 'major', totalHours: 10, hoursRemaining: 4, status: 'in-progress' }],
        });
        db.saveSave(conn, id, { world: sampleWorld(), shipInstances: { ships: [reordered] } });

        const tasks = db.getSave(conn, id).shipInstances.ships[0].repairQueue;
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toEqual({ id: 'task-2', systemKey: 'co2', band: 'major', totalHours: 10, hoursRemaining: 4, status: 'in-progress' });
    });

    test('two saves with the same ship id do not collide with each other', () => {
        const conn = db.initDb(':memory:');
        const a = db.createSave(conn, 'Run A');
        const b = db.createSave(conn, 'Run B');

        db.saveSave(conn, a.id, { world: sampleWorld(), shipInstances: { ships: [sampleShip({ repairQueue: [] })] } });
        db.saveSave(conn, b.id, { world: sampleWorld(), shipInstances: { ships: [sampleShip({
            systemState: { ...sampleShip().systemState, o2Generator: { ...sampleShip().systemState.o2Generator, repairPct: 99 } },
            repairQueue: [],
        })] } });

        expect(db.getSave(conn, a.id).shipInstances.ships[0].systemState.o2Generator.repairPct).toBe(80);
        expect(db.getSave(conn, b.id).shipInstances.ships[0].systemState.o2Generator.repairPct).toBe(99);
    });

    test('deleteSave removes the save and all of its scoped data', () => {
        const conn = db.initDb(':memory:');
        const a = db.createSave(conn, 'Run A');
        const b = db.createSave(conn, 'Run B');
        db.saveSave(conn, a.id, { world: sampleWorld(), shipInstances: { ships: [sampleShip()] } });
        db.saveSave(conn, b.id, { world: sampleWorld(), shipInstances: { ships: [sampleShip()] } });

        db.deleteSave(conn, a.id);

        expect(db.getSave(conn, a.id)).toBeNull();
        expect(db.listSaves(conn).map(s => s.name)).toEqual(['Run B']);
        // Deleting one save's ship data must not affect the other save's same-id ship.
        expect(db.getSave(conn, b.id).shipInstances.ships[0].systemState.o2Generator.repairPct).toBe(80);
        // Creating a save with the freed name should work again — confirms a full delete, not a soft one.
        expect(db.createSave(conn, 'Run A')).toHaveProperty('id');
    });

    test('initDb is idempotent across repeated opens of the same file', () => {
        const fs   = require('fs');
        const path = require('path');
        const dbFile = path.join(__dirname, '..', 'test-results', 'db-spec-reopen.db');
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

        const conn1 = db.initDb(dbFile);
        const { id } = db.createSave(conn1, 'Persisted');
        db.saveSave(conn1, id, { world: sampleWorld(), shipInstances: { ships: [] } });
        conn1.close();

        const conn2 = db.initDb(dbFile); // re-open, runs migrations again
        expect(db.listSaves(conn2).map(s => s.name)).toEqual(['Persisted']);
        conn2.close();

        fs.unlinkSync(dbFile);
    });
});
