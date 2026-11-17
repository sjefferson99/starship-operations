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
            { id: 'task-1', systemKey: 'o2', band: 'minor', totalHours: 3, hoursRemaining: 1.5, status: 'in-progress', targetPct: 50 },
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
        rng: { state: 3735928559 }, // above 2^31: the full uint32 range must survive
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
            crew: { count: 1, members: [] }, comms: { seed: null, locations: [], market: [], resale: {} }, rng: { state: 3735928559 },
            shipInstanceId: 'player-ship-1',
            environment: { inBreathableAtmosphere: true, ventsOpen: false },
            notifications: [],
        });

        const ship = result.shipInstances.ships[0];
        expect(ship.id).toBe('player-ship-1');
        expect(ship.systemState.o2Generator).toEqual({ active: true, count: 1, tier: 1, target: 21.0, repairPct: 80, juryRigged: false, destroyed: false });
        expect(ship.systemState.generator).toEqual({ active: false, count: null, tier: null, target: null, repairPct: 0, juryRigged: true, destroyed: true });
        expect(ship.repairQueue.map(t => t.id)).toEqual(['task-1', 'task-2']);
        // A task saved without a target (from before targets existed) reads back as a full repair.
        expect(ship.repairQueue.map(t => t.targetPct)).toEqual([50, 100]);

        // This payload predates the transceiver / water maker: no row is written
        // for them, and they read back flagged as absent rather than as broken.
        expect(ship.systemState.transceiver.present).toBe(false);
        expect(ship.systemState.waterMaker.present).toBe(false);
    });

    test('transceiver, water maker, black-water exposure and market listings round-trip', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run A');

        const base = sampleShip();
        const ship = sampleShip({
            systemState: {
                ...base.systemState,
                transceiver: { active: true, count: 1, tier: 1, repairPct: 100, juryRigged: false, destroyed: false, installed: true },
                waterMaker:  { active: false, count: 1, tier: 1, repairPct: 17, juryRigged: false, destroyed: false, installed: false },
                water: { freshCurrentL: 40, freshCapacityL: 500, rationing: true, freshDepletedHours: 0, rationHours: 3,
                         blackLiquidL: 80, blackSolidL: 20, blackCapacityL: 100, blackExposureHours: 2.5 },
            },
        });
        const market = [
            { id: 'mkt-1', locationId: 'home', moduleKey: 'waterMaker', name: 'Salvaged Water Maker', repairPct: 17, price: 124 },
            { id: 'mkt-2', locationId: 'home', moduleKey: 'o2', name: 'Salvaged O₂ Generator', repairPct: 40, price: 186 },
        ];
        db.saveSave(conn, id, { world: sampleWorld({ comms: { seed: 7, locations: [], market } }), shipInstances: { ships: [ship] } });

        const result = db.getSave(conn, id);
        const state  = result.shipInstances.ships[0].systemState;
        expect(state.transceiver).toMatchObject({ present: true, active: true, repairPct: 100, installed: true });
        expect(state.waterMaker).toMatchObject({ present: true, active: false, repairPct: 17, installed: false });
        expect(state.water.blackExposureHours).toBe(2.5);
        expect(result.world.comms.market).toEqual(market);

        // Re-saving with one listing sold fully replaces the stock; deleting the save clears it.
        db.saveSave(conn, id, { world: sampleWorld({ comms: { seed: 7, locations: [], market: [market[1]] } }), shipInstances: { ships: [ship] } });
        expect(db.getSave(conn, id).world.comms.market).toEqual([market[1]]);
        db.deleteSave(conn, id);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM market_listings').get().n).toBe(0);
    });

    test('crew members round-trip health/shifts/dead, and re-saving fully replaces the roster', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run A');

        const members = [
            { id: 'player', health: 62.5, varianceFactor: 1.1, dead: false, shifts: [{ startHour: 9, endHour: 13 }] },
            { id: 'second', health: 0, varianceFactor: 0.85, dead: true, shifts: [] },
        ];
        db.saveSave(conn, id, { world: sampleWorld({ crew: { count: 2, members } }), shipInstances: { ships: [] } });

        expect(db.getSave(conn, id).world.crew.members).toEqual(members);

        // Re-saving with a smaller roster should fully replace, not append.
        const solo = [{ id: 'player', health: 100, varianceFactor: 1.1, dead: false, shifts: [{ startHour: 9, endHour: 13 }, { startHour: 14, endHour: 18 }] }];
        db.saveSave(conn, id, { world: sampleWorld({ crew: { count: 1, members: solo } }), shipInstances: { ships: [] } });

        expect(db.getSave(conn, id).world.crew.members).toEqual(solo);
    });

    test('comms locations round-trip seed/kind/coordinates, and re-saving fully replaces the roster', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run A');

        const locations = [
            { id: 'home', kind: 'home', name: 'Kel Veth III', x: 4.2, y: 7.1, z: 1.9 },
            { id: 'location-ab12cd', kind: 'location', name: 'Harlow Station', x: 4.9, y: 6.8, z: 2.3 },
            { id: 'signal-ef34gh', kind: 'signal', name: 'Unidentified Transmission', x: 3.6, y: 7.5, z: 1.2 },
        ];
        db.saveSave(conn, id, { world: sampleWorld({ comms: { seed: 123456789, locations } }), shipInstances: { ships: [] } });

        const saved = db.getSave(conn, id).world.comms;
        expect(saved.seed).toBe(123456789);
        expect(saved.locations).toEqual(locations);

        // Re-saving with a different roster should fully replace, not append.
        const resown = [{ id: 'home', kind: 'home', name: 'Kel Veth III', x: 4.2, y: 7.1, z: 1.9 }];
        db.saveSave(conn, id, { world: sampleWorld({ comms: { seed: 42, locations: resown } }), shipInstances: { ships: [] } });

        const resaved = db.getSave(conn, id).world.comms;
        expect(resaved.seed).toBe(42);
        expect(resaved.locations).toEqual(resown);
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
        expect(tasks[0]).toEqual({ id: 'task-2', systemKey: 'co2', band: 'major', totalHours: 10, hoursRemaining: 4, status: 'in-progress', targetPct: 100 });
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
