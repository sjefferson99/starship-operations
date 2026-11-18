// Notifications (notifications.js): the list behind the header pill — what
// gets listed, deleting one or all, and that the list is saved with the game.
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');
const db = require('../db.js');

const freeze = page => page.evaluate(() => window.game._stopTimer());
// One comparison, on demand, instead of waiting for the next tick.
const check  = page => page.evaluate(() => window.game.notifications.check());
const titles = page => page.evaluate(() => window.game.notifications.list.map(n => n.title));

test.describe('notifications', () => {
    test('a status getting worse is listed once, repeats are grouped, and nothing is listed on arrival', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await check(page);

        // A new ship already has warnings; none of them were listed.
        expect(await titles(page)).toEqual([]);
        await expect(page.locator('#notifications-count')).toBeHidden();

        await page.evaluate(() => { const o2 = window.game.systems.o2; o2.status = 'Warning'; o2.pct = 18.5; });
        await check(page);
        await page.evaluate(() => { window.game.systems.o2.status = 'Critical'; });
        await check(page);
        // Recovering isn't listed.
        await page.evaluate(() => { window.game.systems.o2.status = 'Normal'; });
        await check(page);
        // Flicking back to a warning moves the earlier entry to the top with a count.
        await page.evaluate(() => { window.game.systems.o2.status = 'Warning'; });
        await check(page);

        const list = await page.evaluate(() => window.game.notifications.list.map(n => ({ title: n.title, level: n.level, count: n.count })));
        expect(list).toEqual([
            { title: 'Oxygen warning',  level: 'warning',  count: 2 },
            { title: 'Oxygen critical', level: 'critical', count: 1 },
        ]);
        await expect(page.locator('#notifications-count')).toHaveText('2');
        await expect(page.locator('#notifications-pill')).toHaveClass(/stat-critical/);
    });

    test('repairs, a destroyed module, purchases, a dump, crew health and compost are all listed', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await check(page);

        const step = async change => { await page.evaluate(change); await check(page); };

        await step(() => { window.game.systems.power.repairPct = 100; });
        await step(() => { window.game.systems.co2.destroyed = true; window.game.systems.co2.status = 'Critical'; });
        await step(() => {
            const g = window.game;
            g.systems.transceiver.repairPct = 100; g.systems.transceiver.active = true;
            g.systemUpdate.update(1);
            g.berth = 'port'; // trade is direct at the port
            g.notifications._prev = g.notifications._state(); // re-baseline: the setup isn't the event under test
            g.commsNav.purchase(g.market.find(l => l.moduleKey === 'waterMaker').id);
        });
        await step(() => {
            const g = window.game;
            g.systems.blackWater.liquidL = 40; g.systems.blackWater.current = 40;
            g.notifications._prev = g.notifications._state();
            g.systems.blackWater.liquidL = 0; g.systems.blackWater.current = 0; g.credits -= 100;
        });
        await step(() => { window.game.crewManifest[0].health = 10; });
        await step(() => {
            const g = window.game;
            g.cargo.boxes = []; // the new ship's food box: eaten from, but not the subject here
            g.notifications._prev = g.notifications._state();
            g.cargo.boxes.push({ id: 'box-t', kind: 'compost', fillL: 30, sealed: false, compostHours: 0 });
        });
        await step(() => { window.game.cargo.boxes[0].sealed = true; });
        await step(() => { window.game.cargo.boxes[0].compostHours = window.game.fabrication.COMPOST_HOURS; });

        const listed = (await titles(page)).reverse(); // oldest first
        expect(listed[0]).toBe('Power Generator repaired to 100%');
        expect(listed[1]).toBe('CO₂ Scrubber destroyed');
        // Buying a module fits it: one entry, not "bought" and then "fitted".
        expect(listed.filter(t => /Water Maker/.test(t))).toHaveLength(1);
        expect(listed.some(t => /^Bought .*Water Maker/.test(t))).toBe(true);
        expect(listed).toContain('Black water dumped');
        expect(listed).toContain('Crew 1 is unconscious');
        expect(listed).toContain('Storage box fabricated');
        expect(listed).toContain('Storage Box 1 sealed');
        expect(listed).toContain('Compost ready in Storage Box 1');
        // A destroyed module isn't listed twice (once as destroyed, once as a critical status).
        expect(listed.filter(t => t.startsWith('CO₂'))).toEqual(['CO₂ Scrubber destroyed']);
    });

    test('a drone repair is listed and chimes, but wear from flying is not', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => {
            const g = window.game;
            g.drones = [{ id: 'd1', tier: 1, repairPct: 40, juryRigged: false, destroyed: false, chargeWh: 1500,
                          chargeFromBattery: false, plan: [], planOut: [], state: 'stowed', hoursLeft: 0, cargoOut: [], cargoIn: [] }];
            g.notifications._prev = g.notifications._state();
            window.sound._prev = window.sound._snapshot();
            window.sound.log = [];
        });
        await page.evaluate(() => { window.game.drones[0].repairPct = 38; }); // a run's wear
        await check(page);
        expect(await titles(page)).toEqual([]);

        await page.evaluate(() => { window.game.drones[0].repairPct = 80; window.sound._lastChimeAt = 0; window.sound._poll(); });
        await check(page);
        expect(await titles(page)).toEqual(['Transfer Drone 1 repaired to 80%']);
        expect(await page.evaluate(() => window.sound.log)).toContain('repaired');
    });

    test('an infection is listed and chimes as critical; compost being ready has its own chime', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => window.sound._poll());
        await page.evaluate(() => { window.sound.log.length = 0; });

        await page.evaluate(() => {
            const g = window.game;
            g.systems.blackWater.exposureHours = 500; // the infection chance is as high as it goes
            g.rng.next = () => 0;                      // and the roll comes up
            g.crewManager.update(3600);
        });
        expect((await titles(page))[0]).toBe('Crew 1 has caught an infection');
        await page.evaluate(() => window.sound._poll());
        expect(await page.evaluate(() => window.sound.log.slice())).toContain('critical');

        await page.evaluate(() => {
            const g = window.game;
            g.cargo.boxes = [];
            g.cargo.boxes.push({ id: 'box-r', kind: 'compost', fillL: 30, sealed: true, compostHours: 0 });
            window.sound._poll();
            window.sound.log.length = 0;
            g.cargo.boxes[0].compostHours = g.fabrication.COMPOST_HOURS;
            window.sound._poll();
        });
        expect(await page.evaluate(() => window.sound.log.slice())).toEqual(['ready']);
    });

    test('the pill opens the list; one or all can be deleted, and clicking elsewhere closes it', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => {
            const n = window.game.notifications;
            n.add({ level: 'info', title: 'First' });
            n.add({ level: 'warning', title: 'Second', detail: 'Some <b>detail</b>' });
            n.add({ level: 'good', title: 'Third' });
        });
        await expect(page.locator('#notifications-count')).toHaveText('3');
        await expect(page.locator('#notifications-panel')).toBeHidden();

        await page.click('#notifications-pill');
        await expect(page.locator('#notifications-panel')).toBeVisible();
        await expect(page.locator('.notification-title')).toHaveText(['Third', 'Second', 'First']);
        // Text is shown as text, never as markup.
        await expect(page.locator('.notification-detail')).toHaveText('Some <b>detail</b>');
        await expect(page.locator('.notification-time').first()).toHaveText('Day 1 · 00:00');

        await page.locator('.notification', { hasText: 'Second' }).locator('.notification-dismiss').click();
        await expect(page.locator('.notification-title')).toHaveText(['Third', 'First']);
        await expect(page.locator('#notifications-count')).toHaveText('2');
        await expect(page.locator('#notifications-panel')).toBeVisible(); // deleting doesn't close it

        await page.click('#notifications-clear-btn');
        await expect(page.locator('.notification')).toHaveCount(0);
        await expect(page.locator('#notifications-list .task-empty')).toBeVisible();
        await expect(page.locator('#notifications-count')).toBeHidden();
        await expect(page.locator('#notifications-clear-btn')).toBeDisabled();

        await page.click('.system-dashboard', { position: { x: 5, y: 5 } });
        await expect(page.locator('#notifications-panel')).toBeHidden();
        await page.click('#notifications-pill');
        await page.keyboard.press('Escape');
        await expect(page.locator('#notifications-panel')).toBeHidden();
        // …and only closes it: the same Escape doesn't also pause the game.
        await expect(page.locator('#pause-menu')).toBeHidden();
        expect(await page.evaluate(() => window.game.gamePaused)).toBe(false);
    });

    test('the list is saved with the game and comes back on load', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const saveId = await page.evaluate(async () => {
            const g = window.game;
            g.notifications.add({ key: 'status:o2', level: 'critical', title: 'Oxygen critical', detail: 'Cabin oxygen at 15.0%.' });
            g.notifications.add({ key: 'status:o2', level: 'critical', title: 'Oxygen critical', detail: 'Cabin oxygen at 14.0%.' });
            g.notifications.add({ level: 'good', title: 'Compost sold', detail: '+60 credits.' });
            await GameState.saveServer(g);
            g.notifications.clear();
            await GameState.loadServer(g, g.saveId);
            return g.saveId;
        });
        expect(saveId).toBeTruthy();
        const list = await page.evaluate(() => window.game.notifications.list.map(({ title, level, detail, count }) => ({ title, level, detail, count })));
        expect(list).toEqual([
            { title: 'Compost sold', level: 'good', detail: '+60 credits.', count: 1 },
            { title: 'Oxygen critical', level: 'critical', detail: 'Cabin oxygen at 14.0%.', count: 2 },
        ]);
        await expect(page.locator('#notifications-count')).toHaveText('2');
    });

    test('a tip points out the pill the first time something is listed', async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('starshipOps.tipsOff'));
        await startNewGame(page);
        await freeze(page);
        // Only this tip is due: every other one is marked as already seen for this save.
        await page.evaluate(() => {
            const t = window.game.tour;
            t.tips.filter(tip => tip.id !== 'notifications').forEach(tip => t._markTipSeen(tip.id));
            window.game.notifications.add({ level: 'warning', title: 'Battery warning' });
            t.checkTips();
        });
        await expect(page.locator('#tour-title')).toHaveText('Notifications');
        expect(await page.evaluate(() => window.game.tour.tip?.target)).toBe('#notifications-pill');
    });
});

test.describe('notifications table (db.js)', () => {
    test('a save keeps its notifications in order; old payloads without any load as empty; deleting the save removes them', () => {
        const conn = db.initDb(':memory:');
        const { id } = db.createSave(conn, 'Run');
        const world = notifications => ({
            version: '2.0.0', world: { gameTime: 0, credits: 1000, gameSpeed: 1 }, crew: { count: 1 },
            shipInstanceId: 'player-ship-1', environment: { inBreathableAtmosphere: true, ventsOpen: false },
            ...(notifications ? { notifications } : {}),
        });

        db.saveSave(conn, id, { world: world([
            { id: 'n-2', key: null, level: 'good', title: 'Newer', detail: '', gameTime: 7200, count: 1 },
            { id: 'n-1', key: 'status:o2', level: 'warning', title: 'Older', detail: 'd', gameTime: 3600, count: 3 },
        ]), shipInstances: { ships: [] } });
        expect(db.getSave(conn, id).world.notifications).toEqual([
            { id: 'n-2', key: null, level: 'good', title: 'Newer', detail: '', gameTime: 7200, count: 1 },
            { id: 'n-1', key: 'status:o2', level: 'warning', title: 'Older', detail: 'd', gameTime: 3600, count: 3 },
        ]);

        db.saveSave(conn, id, { world: world(null), shipInstances: { ships: [] } });
        expect(db.getSave(conn, id).world.notifications).toEqual([]);

        db.saveSave(conn, id, { world: world([{ id: 'n-1', level: 'info', title: 'x', gameTime: 0 }]), shipInstances: { ships: [] } });
        db.deleteSave(conn, id);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM notifications').get().n).toBe(0);
    });
});

test.describe('tips for the Timeline and ship capacity', () => {
    // Shows only the named tip (every other one is marked seen), after `setup` runs.
    const onlyTip = (page, id, setup) => page.evaluate(([tipId, setupSrc]) => {
        const g = window.game, t = g.tour;
        t.tips.filter(tip => tip.id !== tipId).forEach(tip => t._markTipSeen(tip.id));
        const due = t.tips.find(tip => tip.id === tipId).when(g);
        new Function('g', setupSrc)(g);
        t.checkTips();
        return { dueBefore: due, shown: t.tip?.id ?? null };
    }, [id, setup]);

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('starshipOps.tipsOff'));
        await startNewGame(page);
        await freeze(page);
    });

    test('the Timeline tip appears once a module is destroyed', async ({ page }) => {
        const result = await onlyTip(page, 'timeline', 'g.systems.co2.destroyed = true;');
        expect(result).toEqual({ dueBefore: false, shown: 'timeline' });
        await expect(page.locator('#tour-title')).toHaveText('You can go back');
    });

    test('the Timeline tip appears once a crew member is unconscious', async ({ page }) => {
        const result = await onlyTip(page, 'timeline', 'g.crewManifest[0].health = 10;');
        expect(result).toEqual({ dueBefore: false, shown: 'timeline' });
    });

    test('the capacity tip appears when the hold is nearly full, pointing at Ship Capacity', async ({ page }) => {
        // Fill the hold with empty machine boxes until under 15% of the volume is left.
        const result = await onlyTip(page, 'space-low', `
            const cap = g._computeShipCapacity();
            const vol = g.fabrication.MACHINE_BOX.volumeM3;
            const n = Math.ceil((cap.freeVolumeM3 - cap.totalVolumeM3 * 0.1) / vol);
            for (let i = 0; i < n; i++) g.fabrication.boxes().push(g.fabrication._emptyBox('machine'));
        `);
        expect(result).toEqual({ dueBefore: false, shown: 'space-low' });
        expect(await page.evaluate(() => window.game.tour.tip.target)).toBe('#ship-capacity-btn');
    });
});
