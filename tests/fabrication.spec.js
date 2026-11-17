// Fabrication, cargo and the compost lifecycle (fabrication.js): buying
// supplies on the market, fabricating a storage box through the work queue,
// dosing it, moving solid waste in, composting and selling.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

// Put the player engineer on shift at hour 0 (where a new game's clock is),
// within normal hours so overwork doesn't slow them down.
async function engineerAlwaysOnShift(page) {
    await page.evaluate(() => {
        const g = window.game;
        g.crewManifest.forEach(m => { m.shifts = [{ startHour: 0, endHour: 8 }]; m.health = 100; });
    });
}

test.describe('fabrication', () => {
    test('market sells supplies on the planet; buying needs the local network', async ({ page }) => {
        await startNewGame(page);

        // A new ship's transceiver reaches nothing, so nothing can be bought yet.
        const blocked = await page.evaluate(() => window.game.fabrication.buyBlocker('basicComponents'));
        expect(blocked).toMatch(/planet/);

        await bringCommsOnline(page);
        await page.evaluate(() => { window.game.credits = 1000; });
        await page.click('#comms-nav-btn');
        await page.evaluate(() => window.game._selectCommsLocation('home'));

        const buyBtn = page.locator('[data-fab-action="buy"][data-key="basicComponents"]');
        await expect(buyBtn).toBeEnabled();
        await buyBtn.click();

        const state = await page.evaluate(() => ({ n: window.game.fabrication.count('basicComponents'), credits: window.game.credits }));
        expect(state.n).toBe(1);
        expect(state.credits).toBe(1000 - 60);
    });

    test('a storage box is fabricated through the work queue, and cancelling refunds components', async ({ page }) => {
        await startNewGame(page);
        await engineerAlwaysOnShift(page);

        const result = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            const noParts = fab.fabricateBlocker('storageBox');
            g.cargo.items.basicComponents = 2;

            const cancelled = fab.queueFabrication('storageBox');
            const afterQueue = fab.count('basicComponents');
            g.repairManager.cancelTask(cancelled.id);
            const afterCancel = fab.count('basicComponents');

            g.repairQueue = []; // the new game's own repairs aren't part of this test
            const task = fab.queueFabrication('storageBox');
            g.repairManager.processQueue(3600 * 3);
            const midway = { boxes: fab.boxes().length, left: task.hoursRemaining };
            g.repairManager.processQueue(3600 * 2);
            return { noParts, afterQueue, afterCancel, midway, boxes: fab.boxes().length, queue: g.repairQueue.length, parts: fab.count('basicComponents') };
        });

        expect(result.noParts).toMatch(/basic component/);
        expect(result.afterQueue).toBe(1);
        expect(result.afterCancel).toBe(2);
        expect(result.midway.boxes).toBe(0);
        expect(result.midway.left).toBeCloseTo(1, 5);
        expect(result.boxes).toBe(1);
        expect(result.queue).toBe(0);
        expect(result.parts).toBe(1);
    });

    test('fabrication shows in the Work Queue and the box adds to ship capacity', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.cargo.items.basicComponents = 1; window.game.updateDisplay(); });

        const before = await page.evaluate(() => window.game._computeShipCapacity().usedVolumeM3);
        await page.click('#repair-queue-btn');
        await page.click('[data-fab-action="fabricate"][data-key="storageBox"]');
        await expect(page.locator('#repair-queue-list .task-card-fabricate')).toHaveCount(1);
        await expect(page.locator('#repair-queue-list .task-card-fabricate .task-title')).toContainText('Storage Box');

        const after = await page.evaluate(() => window.game._computeShipCapacity().usedVolumeM3);
        // The component (0.02 m³) leaves the hold; the box being made (0.08 m³) is reserved.
        expect(after - before).toBeCloseTo(0.06, 5);
    });

    test('fabricating is refused when the box would not fit', async ({ page }) => {
        await startNewGame(page);
        const blocker = await page.evaluate(() => {
            const g = window.game;
            g.cargo.items.basicComponents = 1;
            g.shipClass.defaultSystems.volumeM3 = g._computeShipCapacity().usedVolumeM3 + 0.01;
            return g.fabrication.fabricateBlocker('storageBox');
        });
        expect(blocker).toMatch(/volume/);
    });

    test('compost lifecycle: dose, move solids, seal, compost, sell', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);

        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.cargo.boxes.push({ id: 'box-test', kind: null, fillL: 0, sealed: false, compostHours: 0 });
            g.cargo.items.compostingAgent = 1;
            const black = g.systems.blackWater;
            black.liquidL = 10; black.solidL = 30; g.syncBlackWaterLevel();

            const beforeDose = fab.transferBlocker('box-test');
            fab.dose('box-test');
            const agentLeft = fab.count('compostingAgent');

            const moved = fab.transferSolids('box-test');
            const afterMove = { solidL: black.solidL, current: black.current, fillL: fab.boxes()[0].fillL };

            const status1 = fab.boxStatus(fab.boxes()[0]);
            fab.seal('box-test');
            const status2 = fab.boxStatus(fab.boxes()[0]);
            const mass = fab.boxMassKg(fab.boxes()[0]);

            g.systemUpdate.update(3600 * 24 * 2);      // two days: still composting
            const status3 = fab.boxStatus(fab.boxes()[0]);
            fab.update(3600 * 24 * 5);                 // one huge step past the end
            const box = fab.boxes()[0];
            const status4 = fab.boxStatus(box);
            const hours = box.compostHours;

            const credits = g.credits;
            const price = fab.salePrice(box);
            fab.sell('box-test');
            return { beforeDose, agentLeft, moved, afterMove, status1, status2, status3, status4, hours, mass,
                     gained: g.credits - credits, price, after: { ...fab.boxes()[0] } };
        });

        expect(r.beforeDose).toMatch(/composting agent/);
        expect(r.agentLeft).toBe(0);
        expect(r.moved).toBeCloseTo(30, 5);
        expect(r.afterMove.solidL).toBeCloseTo(0, 5);
        expect(r.afterMove.current).toBeCloseTo(10, 5);
        expect(r.afterMove.fillL).toBeCloseTo(30, 5);
        expect(r.status1).toBe('filling');
        expect(r.status2).toBe('composting');
        expect(r.mass).toBeCloseTo(36, 5);
        expect(r.status3).toBe('composting');
        expect(r.status4).toBe('ready');
        expect(r.hours).toBe(72);
        expect(r.price).toBe(120);
        expect(r.gained).toBe(120);
        expect(r.after).toMatchObject({ kind: null, fillL: 0, sealed: false });
    });

    test('a box seals itself once full, and the Black Water card moves solids into it', async ({ page }) => {
        await startNewGame(page);
        await expect(page.locator('#blackwater-transfer-btn')).toBeDisabled();

        await page.evaluate(() => {
            const g = window.game;
            g.cargo.boxes.push({ id: 'box-a', kind: 'compost', fillL: 45, sealed: false, compostHours: 0 });
            g.systems.blackWater.solidL = 20; g.syncBlackWaterLevel();
            g.updateDisplay();
        });
        await page.click('#blackwater-transfer-btn');

        const r = await page.evaluate(() => ({ box: window.game.cargo.boxes[0], solidL: window.game.systems.blackWater.solidL }));
        expect(r.box.fillL).toBe(50);
        expect(r.box.sealed).toBe(true);
        expect(r.solidL).toBeCloseTo(15, 5);
        await expect(page.locator('#blackwater-transfer-btn')).toBeDisabled();
    });

    test('finished compost can be sold from the Comms & Nav market', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game;
            g.credits = 0;
            g.cargo.boxes.push({ id: 'box-m', kind: 'compost', fillL: 50, sealed: true, compostHours: 72 });
            g.cargo.boxes.push({ id: 'box-c', kind: 'compost', fillL: 20, sealed: true, compostHours: 10 });
        });
        await page.click('#comms-nav-btn');
        await page.evaluate(() => window.game._selectCommsLocation('home'));

        // Only the finished box is offered.
        await expect(page.locator('[data-sell-box-id]')).toHaveCount(1);
        await page.click('[data-fab-action="sell"][data-box-id="box-m"]');

        await expect(page.locator('[data-sell-box-id]')).toHaveCount(0);
        const r = await page.evaluate(() => ({ credits: window.game.credits, box: window.game.cargo.boxes[0] }));
        expect(r.credits).toBe(200);
        expect(r.box).toMatchObject({ kind: null, fillL: 0, sealed: false });
    });

    test('selling needs a planet with the local network in range', async ({ page }) => {
        await startNewGame(page);
        const blocker = await page.evaluate(() => {
            const g = window.game;
            g.cargo.boxes.push({ id: 'box-r', kind: 'compost', fillL: 10, sealed: true, compostHours: 72 });
            return g.fabrication.sellBlocker('box-r');
        });
        expect(blocker).toMatch(/planet/);
    });

    test('Cargo Hold lists supplies and boxes with their actions', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            const g = window.game;
            g.cargo.items.compostingAgent = 1;
            g.cargo.boxes.push({ id: 'box-ui', kind: null, fillL: 0, sealed: false, compostHours: 0 });
        });
        await page.click('#cargo-btn');
        await expect(page.locator('#cargo-screen')).toBeVisible();
        await expect(page.locator('[data-item-key="compostingAgent"] .cargo-count')).toHaveText('1');

        await page.click('[data-fab-action="dose"][data-box-id="box-ui"]');
        await expect(page.locator('.cargo-box[data-box-id="box-ui"] .task-title')).toContainText('taking solid waste');
        await expect(page.locator('[data-fab-action="seal"][data-box-id="box-ui"]')).toBeDisabled();
    });

    test('cargo and fabrication jobs survive a save and load', async ({ page }) => {
        await startNewGame(page);
        const before = await page.evaluate(async () => {
            const g = window.game;
            g.cargo.items.basicComponents = 3;
            g.cargo.items.compostingAgent = 2;
            g.cargo.boxes.push({ id: 'box-p', kind: 'compost', fillL: 12.5, sealed: true, compostHours: 10 });
            g.fabrication.queueFabrication('storageBox');
            await g.saveGame();
            return { cargo: JSON.parse(JSON.stringify(g.cargo)), fab: g.repairQueue.filter(t => t.kind === 'fabricate').map(t => ({ ...t })) };
        });

        const after = await page.evaluate(async () => {
            const g = window.game;
            g.cargo = Fabrication.defaultCargo();
            g.repairQueue = [];
            await GameState.loadServer(g, g.saveId);
            return { cargo: g.cargo, fab: g.repairQueue.filter(t => t.kind === 'fabricate') };
        });

        expect(after.cargo).toEqual(before.cargo);
        expect(after.fab.map(t => ({ id: t.id, recipeKey: t.recipeKey, totalHours: t.totalHours })))
            .toEqual(before.fab.map(t => ({ id: t.id, recipeKey: t.recipeKey, totalHours: t.totalHours })));
    });

    test('a save from before fabrication restores an empty hold', async ({ page }) => {
        await startNewGame(page);
        const cargo = await page.evaluate(() => {
            const g = window.game;
            const world = GameState.snapshot(g);
            const ships = GameState.shipInstanceSnapshot(g);
            delete ships.ships[0].cargo;
            g.cargo.items.basicComponents = 5;
            GameState.restore(g, world, ships);
            return g.cargo;
        });
        expect(cargo).toEqual({ items: { basicComponents: 0, compostingAgent: 0 }, boxes: [] });
    });
});
