// Rewind checkpoints (docs/rewind-readiness.md): the checkpoint tree in db.js,
// and the Timeline screen (timeline.js) that takes checkpoints and goes back
// to them. Going back must never lose a line that was already played.
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');
const db = require('../db.js');

const HOUR = 3600;

function payloadAt(gameTime, credits = 1000) {
    return {
        world: {
            version: '2.0.0',
            world: { gameTime, credits, gameSpeed: 1 },
            crew: { count: 1 },
            shipInstanceId: 'player-ship-1',
            environment: { inBreathableAtmosphere: true, ventsOpen: false },
        },
        shipInstances: { version: '1.0.0', ships: [] },
    };
}

function newSave(name = 'Run') {
    const conn = db.initDb(':memory:');
    const { id } = db.createSave(conn, name);
    return { conn, id };
}

test.describe('checkpoint tree (db.js)', () => {
    test('each checkpoint follows the one before it, and the newest is the head', () => {
        const { conn, id } = newSave();
        const a = db.addCheckpoint(conn, id, 'start',  payloadAt(0));
        const b = db.addCheckpoint(conn, id, 'hourly', payloadAt(HOUR));
        const c = db.addCheckpoint(conn, id, 'save',   payloadAt(HOUR + 600, 900));

        const tree = db.listCheckpoints(conn, id);
        expect(tree.headId).toBe(c.id);
        expect(tree.checkpoints.map(cp => [cp.id, cp.parentId, cp.kind])).toEqual([
            [a.id, null, 'start'], [b.id, a.id, 'hourly'], [c.id, b.id, 'save'],
        ]);
        expect(tree.checkpoints[2]).toMatchObject({ gameTime: HOUR + 600, credits: 900, crewCount: 1 });
    });

    test('going back keeps the line being left, and new play branches from the checkpoint', () => {
        const { conn, id } = newSave();
        const a = db.addCheckpoint(conn, id, 'start',  payloadAt(0));
        const b = db.addCheckpoint(conn, id, 'hourly', payloadAt(HOUR, 950));
        const c = db.addCheckpoint(conn, id, 'hourly', payloadAt(2 * HOUR, 700));

        // Live play has moved on to 2.5h when the player goes back to b.
        const restored = db.restoreCheckpoint(conn, id, b.id, payloadAt(2.5 * HOUR, 650));
        expect(restored.world.world).toMatchObject({ gameTime: HOUR, credits: 950 });
        expect(db.getSave(conn, id).world.world).toMatchObject({ gameTime: HOUR, credits: 950 }); // live save too

        let tree = db.listCheckpoints(conn, id);
        expect(tree.headId).toBe(b.id);
        const left = tree.checkpoints.find(cp => cp.kind === 'branch-end');
        expect(left).toMatchObject({ parentId: c.id, gameTime: 2.5 * HOUR, credits: 650 });

        // Playing on from b starts a second branch under it.
        const d = db.addCheckpoint(conn, id, 'hourly', payloadAt(2 * HOUR, 990));
        tree = db.listCheckpoints(conn, id);
        expect(tree.checkpoints.find(cp => cp.id === d.id).parentId).toBe(b.id);
        expect(tree.checkpoints.filter(cp => cp.parentId === b.id).map(cp => cp.id)).toEqual([c.id, d.id]);

        // …and the first line is still there to return to.
        const back = db.restoreCheckpoint(conn, id, left.id, payloadAt(2.2 * HOUR, 980));
        expect(back.world.world).toMatchObject({ gameTime: 2.5 * HOUR, credits: 650 });
        expect(db.listCheckpoints(conn, id).checkpoints).toHaveLength(6); // a, b, c, left, d + the end of d's line
        expect(a.id).toBeGreaterThan(0);
    });

    test('going back with nothing played since the head adds no duplicate checkpoint', () => {
        const { conn, id } = newSave();
        const a = db.addCheckpoint(conn, id, 'start',  payloadAt(0));
        db.addCheckpoint(conn, id, 'hourly', payloadAt(HOUR));

        db.restoreCheckpoint(conn, id, a.id, payloadAt(HOUR)); // still exactly at the head's time
        expect(db.listCheckpoints(conn, id).checkpoints).toHaveLength(2);
    });

    test('old hourly checkpoints thin to one per game day; saves and branch points are kept', () => {
        const { conn, id } = newSave();
        db.addCheckpoint(conn, id, 'start', payloadAt(0));
        let branchPoint = null, manual = null;
        for (let h = 1; h <= 72; h++) {
            const cp = db.addCheckpoint(conn, id, h === 30 ? 'save' : 'hourly', payloadAt(h * HOUR));
            if (h === 30) manual = cp.id;
            if (h === 5) {
                // Branch at hour 5: go back to it straight away, then carry on.
                branchPoint = cp.id;
                db.restoreCheckpoint(conn, id, cp.id, payloadAt(5.5 * HOUR));
            }
        }

        const { checkpoints, headId } = db.listCheckpoints(conn, id);
        const ids = new Set(checkpoints.map(cp => cp.id));
        const line = []; // the current line, newest first
        for (let cp = checkpoints.find(c => c.id === headId); cp; cp = checkpoints.find(c => c.id === cp.parentId)) line.push(cp);

        // Still one connected line back to the start.
        expect(line[line.length - 1].kind).toBe('start');
        // The most recent game day is complete…
        const recent = line.filter(cp => cp.kind === 'hourly' && 72 * HOUR - cp.gameTime < 86400);
        expect(recent).toHaveLength(24);
        // …and older days are down to a single hourly each, apart from the kept branch point.
        const older = line.filter(cp => cp.kind === 'hourly' && 72 * HOUR - cp.gameTime >= 86400 && cp.id !== branchPoint);
        expect(older.map(cp => Math.floor(cp.gameTime / 86400))).toEqual([2, 1, 0]); // hour 48 is exactly a day old, and is day 3's kept one
        expect(ids.has(branchPoint)).toBe(true);
        expect(ids.has(manual)).toBe(true);
        expect(checkpoints.some(cp => cp.kind === 'branch-end')).toBe(true);
    });

    test('checkpoints belong to one save: no cross-save restore, and deleting the save removes them', () => {
        const conn = db.initDb(':memory:');
        const a = db.createSave(conn, 'A');
        const b = db.createSave(conn, 'B');
        const cpA = db.addCheckpoint(conn, a.id, 'start', payloadAt(0));
        db.addCheckpoint(conn, b.id, 'start', payloadAt(0));

        expect(db.restoreCheckpoint(conn, b.id, cpA.id, payloadAt(60))).toBeNull();
        expect(db.addCheckpoint(conn, 9999, 'start', payloadAt(0))).toBeNull();
        expect(() => db.addCheckpoint(conn, a.id, 'nonsense', payloadAt(0))).toThrow();

        db.deleteSave(conn, a.id);
        expect(db.listCheckpoints(conn, a.id).checkpoints).toEqual([]);
        expect(db.listCheckpoints(conn, b.id).checkpoints).toHaveLength(1);
    });
});

// ── In the browser ──────────────────────────────────────────────────────────

const listTree = page => page.evaluate(() => GameState.listCheckpoints(window.game.saveId));

// Stops the tick loop and moves the clock on, taking the hourly checkpoint the
// tick would have taken.
async function playTo(page, gameTime, mutate = '') {
    await page.evaluate(async ({ gameTime, mutate }) => {
        const g = window.game;
        g._stopTimer();
        g.gameTime = gameTime;
        if (mutate) new Function('g', mutate)(g);
        await g.timeline.maybeCheckpoint();
    }, { gameTime, mutate });
}

test.describe('Timeline', () => {
    test('a new game starts its timeline, and crossing a game hour adds a checkpoint', async ({ page }) => {
        await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.map(c => c.kind)).toEqual(['start']);

        await playTo(page, HOUR - 10);   // not there yet
        expect((await listTree(page)).checkpoints).toHaveLength(1);
        await playTo(page, HOUR + 5);
        await playTo(page, HOUR + 900);  // same hour: no second one

        const tree = await listTree(page);
        expect(tree.checkpoints.map(c => c.kind)).toEqual(['start', 'hourly']);
        expect(tree.headId).toBe(tree.checkpoints[1].id);
    });

    test('Save Game marks a checkpoint on the timeline', async ({ page }) => {
        await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.length).toBe(1);
        await page.evaluate(async () => { window.game._stopTimer(); window.game.gameTime = 1200; await window.game.saveGame(); });
        expect((await listTree(page)).checkpoints.map(c => c.kind)).toEqual(['start', 'save']);
    });

    test('going back from the Timeline restores that state and keeps the line left behind', async ({ page }) => {
        await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.length).toBe(1);
        await playTo(page, HOUR,     'g.credits = 900;');
        await playTo(page, 2 * HOUR, 'g.credits = 400; g.systems.o2.repairPct = 12;');
        await page.evaluate(() => { window.game.gameTime = 2.5 * 3600; window.game.credits = 300; });

        await page.keyboard.press('Escape');
        await page.click('#timeline-btn');
        await expect(page.locator('#timeline-tree .timeline-node')).toHaveCount(4); // start, 2 hourly, now
        await expect(page.locator('#timeline-tree .timeline-node-live')).toHaveCount(1);

        const firstHour = (await listTree(page)).checkpoints[1];
        await page.locator(`[data-checkpoint-id="${firstHour.id}"]`).click();
        await expect(page.locator('#timeline-selected-title')).toHaveText('Day 1, 01:00');
        await page.click('#timeline-restore-btn');
        await expect(page.locator('#timeline-screen')).toBeHidden();

        const state = await page.evaluate(() => ({
            time: window.game.gameTime, credits: window.game.credits,
            paused: window.game.gamePaused, active: window.game.gameActive,
        }));
        expect(state).toEqual({ time: HOUR, credits: 900, paused: true, active: true });

        // The line that was left is kept, ending where it was left.
        const tree = await listTree(page);
        expect(tree.headId).toBe(firstHour.id);
        expect(tree.checkpoints.find(c => c.kind === 'branch-end')).toMatchObject({ gameTime: 2.5 * HOUR, credits: 300 });

        // Playing on draws a second branch, and the old tip can be gone back to.
        await page.evaluate(() => window.game.togglePause());
        await playTo(page, 2 * HOUR, 'g.credits = 880;');
        await page.keyboard.press('Escape');
        await page.click('#timeline-btn');
        await expect(page.locator('#timeline-tree .timeline-node')).toHaveCount(5); // + branch end + new hourly (head is "now")
        await page.locator('#timeline-tree .timeline-node-branch-end').click();
        await page.click('#timeline-restore-btn');
        await expect(page.locator('#timeline-screen')).toBeHidden();
        expect(await page.evaluate(() => [window.game.gameTime, window.game.credits])).toEqual([2.5 * HOUR, 300]);
    });

    test('the live save follows a rewind, so loading the save later resumes from there', async ({ page }) => {
        await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.length).toBe(1);
        await playTo(page, HOUR, 'g.credits = 777;');
        await page.evaluate(() => { window.game.gameTime = 5000; window.game.credits = 1; });

        const saved = await page.evaluate(async () => {
            const g = window.game;
            const { checkpoints } = await GameState.listCheckpoints(g.saveId);
            await g.timeline.goBack(checkpoints[1].id);
            const resp = await fetch(`/api/saves/${g.saveId}`);
            return (await resp.json()).world.world;
        });
        expect(saved).toMatchObject({ gameTime: HOUR, credits: 777 });
    });

    test('a game that ended in GAME OVER can be gone back from', async ({ page }) => {
        await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.length).toBe(1);
        await playTo(page, HOUR);
        await page.evaluate(() => {
            const g = window.game;
            g.gameTime = 1.5 * 3600;
            g.crewManifest.forEach(m => { m.health = 0; m.dead = true; });
            g.systemUpdate.update(1);
        });
        await expect(page.locator('#pause-title')).toHaveText('GAME OVER');

        await page.click('#timeline-btn');
        const hourly = (await listTree(page)).checkpoints[1];
        await page.locator(`[data-checkpoint-id="${hourly.id}"]`).click();
        await page.click('#timeline-restore-btn');

        await expect(page.locator('#pause-title')).toHaveText('Game Paused');
        const state = await page.evaluate(() => ({
            alive: window.game.crewManager.aliveCount(), active: window.game.gameActive, time: window.game.gameTime,
        }));
        expect(state.alive).toBeGreaterThan(0);
        expect(state).toMatchObject({ active: true, time: HOUR });
    });

    test('a save from before checkpoints gets a first one when it is loaded', async ({ page, request }) => {
        const name = await startNewGame(page);
        await expect.poll(async () => (await listTree(page)).checkpoints.length).toBe(1);
        // An old save: same slot, but no timeline. Recreate that with a second
        // slot written by the plain save API only.
        const oldName = name + ' old';
        const { id } = await (await request.post('/api/saves', { data: { name: oldName } })).json();
        const body = await page.evaluate(() => ({ world: GameState.snapshot(window.game), shipInstances: GameState.shipInstanceSnapshot(window.game) }));
        await request.put(`/api/saves/${id}`, { data: body });

        page.once('dialog', d => d.accept());
        await page.keyboard.press('Escape');
        await page.click('#main-menu-btn');
        await page.click('#load-game-btn');
        await page.locator('.save-card').filter({ hasText: oldName }).locator('.save-load-btn').click();
        await page.waitForSelector('#game-container', { state: 'visible' });

        await expect.poll(async () => (await listTree(page)).checkpoints.map(c => c.kind)).toEqual(['save']);
        await request.delete(`/api/saves/${id}`);
    });
});
