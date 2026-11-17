// Food rations (kept in storage boxes, eaten every tick, the source of the
// black water tank's solid waste) and machine storage boxes (one stored
// module each: repaired in the work queue, swapped with the fitted one, or
// sold) — fabrication.js, with the eating in system_update.js.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

const freeze = page => page.evaluate(() => window.game._stopTimer());

async function engineerAlwaysOnShift(page) {
    await page.evaluate(() => {
        const g = window.game;
        g.crewManifest.forEach(m => { m.shifts = [{ startHour: 0, endHour: 8 }]; m.health = 100; });
    });
}

test.describe('food', () => {
    test('a new ship has five days of rations in a storage box, shown on the Food Stores card', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const fab = window.game.fabrication;
            return { boxes: fab.boxes().map(b => ({ kind: b.kind, size: b.size, fillL: b.fillL })), rations: fab.rationsAboard() };
        });
        expect(r.boxes).toEqual([{ kind: 'food', size: 'standard', fillL: 15 }]);
        expect(r.rations).toBe(15);
        await expect(page.locator('#food-rations')).toHaveText('15.0');
        await expect(page.locator('#food-boxes')).toHaveText('1 box');
        await expect(page.locator('#food-rate')).toHaveText('−3.0 rations/day');
        await expect(page.locator('#food-runtime')).toHaveText('5.0 days');
        await expect(page.locator('#food-room')).toHaveText('35 rations');
    });

    test('the crew eat three rations a day each, and what they eat becomes solid waste', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.systems.blackWater.solidL = 0;
            g.systemUpdate.update(3600 * 24); // one day in one tick
            return { rations: fab.rationsAboard(), solid: g.systems.blackWater.solidL, status: g.systems.food.status };
        });
        expect(r.rations).toBeCloseTo(12, 5);
        expect(r.solid).toBeCloseTo(4.5, 5);
        expect(r.status).toBe('Normal');
    });

    test('food runs low, then out: the starvation clock runs, then hurts after three days, and stops once there is food', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.crewManager.update = () => {}; // keep the crew alive (and eating) through days without water
            fab.boxes()[0].fillL = 6; // two days
            g.systemUpdate.update(60);
            const low = g.systems.food.status;

            // One huge tick: eats the last rations in the first 2 days, then 1 day hungry.
            g.systemUpdate.update(3600 * 24 * 3);
            const out = { status: g.systems.food.status, starved: g.systems.food.starvedHours,
                          boxKind: fab.boxes()[0].kind, solids: g.systems.blackWater.solidL };
            const earlyHarm = g.crewManager.healthImpactBreakdown().map(i => i.label);

            g.systemUpdate.update(3600 * 24 * 3);
            const lateHarm = g.crewManager.healthImpactBreakdown().map(i => i.label);

            fab._storeRations(5);
            g.systemUpdate.update(60);
            return { low, out, earlyHarm, lateHarm, fedAgain: g.systems.food.starvedHours };
        });
        expect(r.low).toBe('Warning');
        expect(r.out.status).toBe('Critical');
        expect(r.out.starved).toBeCloseTo(24, 1); // less the minute eaten before
        expect(r.out.boxKind).toBe(null); // eaten empty, so free for anything again
        expect(r.earlyHarm.some(l => /Starvation/.test(l))).toBe(false);
        expect(r.lateHarm.some(l => /Starvation/.test(l))).toBe(true);
        expect(r.fedAgain).toBe(0);
    });

    test('rations are bought by the case into food boxes, then empty boxes, and refused with no room', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        expect(await page.evaluate(() => window.game.fabrication.buyFoodBlocker())).toMatch(/planet/);

        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game;
            g.credits = 1000;
            g.cargo.boxes[0].fillL = 45;
            g.cargo.boxes.push({ id: 'box-compost', size: 'standard', kind: 'compost', fillL: 3, sealed: false, compostHours: 0, module: null });
            g.cargo.boxes.push({ id: 'box-empty',   size: 'standard', kind: null, fillL: 0, sealed: false, compostHours: 0, module: null });
        });
        await page.click('#comms-nav-btn');
        await page.evaluate(() => window.game._selectCommsLocation('home'));
        await page.click('[data-fab-action="buyFood"]');

        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            const after = fab.boxes().map(b => ({ id: b.id, kind: b.kind, fillL: b.fillL }));
            // Fill every box: then there is nowhere to put another case.
            fab._storeRations(fab.foodRoom());
            g.updateDisplay();
            return { after, credits: g.credits, full: fab.buyFoodBlocker() };
        });
        expect(r.after[0]).toMatchObject({ kind: 'food', fillL: 50 });
        expect(r.after[1]).toMatchObject({ id: 'box-compost', kind: 'compost', fillL: 3 }); // never mixed with food
        expect(r.after[2]).toMatchObject({ id: 'box-empty', kind: 'food', fillL: 5 });
        expect(r.credits).toBe(1000 - 30);
        expect(r.full).toMatch(/storage box/);
        await expect(page.locator('[data-fab-action="buyFood"]')).toBeDisabled();
    });

    test('food and its starvation clock survive save and load; an old save without food gets starter rations', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(async () => {
            const g = window.game;
            g.cargo.boxes[0].fillL = 7.25;
            g.systems.food.starvedHours = 5;
            await g.saveGame();
            g.cargo.boxes = [];
            g.systems.food.starvedHours = 0;
            await GameState.loadServer(g, g.saveId);
            const loaded = { boxes: g.cargo.boxes.map(b => ({ kind: b.kind, fillL: b.fillL })), starved: g.systems.food.starvedHours };

            const world = GameState.snapshot(g);
            const ships = GameState.shipInstanceSnapshot(g);
            delete ships.ships[0].systemState.food;
            ships.ships[0].cargo.boxes = [];
            GameState.restore(g, world, ships);
            return { loaded, legacy: g.cargo.boxes.map(b => ({ kind: b.kind, fillL: b.fillL })) };
        });
        expect(r.loaded).toEqual({ boxes: [{ kind: 'food', fillL: 7.25 }], starved: 5 });
        expect(r.legacy).toEqual([{ kind: 'food', fillL: 15 }]);
    });
});

test.describe('machine storage boxes', () => {
    test('take two components and longer to fabricate than a storage box, and are bigger', async ({ page }) => {
        await startNewGame(page);
        await engineerAlwaysOnShift(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.repairQueue = [];
            g.cargo.items.basicComponents = 1;
            const tooFew = fab.fabricateBlocker('machineBox');
            g.cargo.items.basicComponents = 2;
            const task = fab.queueFabrication('machineBox');
            g.repairManager.processQueue(3600 * 9);
            const after9 = fab.machineBoxes().length;
            g.repairManager.processQueue(3600 * 1);
            const box = fab.machineBoxes()[0];
            return { tooFew, hours: task.totalHours, parts: fab.count('basicComponents'), after9,
                     made: fab.machineBoxes().length, label: fab.boxLabel(box), volume: fab.boxVolumeM3(box) };
        });
        expect(r.tooFew).toMatch(/2 basic components/);
        expect(r.hours).toBe(10);
        expect(r.parts).toBe(0);
        expect(r.after9).toBe(0);
        expect(r.made).toBe(1);
        expect(r.label).toBe('Machine Box 1');
        expect(r.volume).toBeGreaterThan(0.7); // holds even the generator
    });

    test('buy & store a module, repair it in the queue, then sell it for a profit', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await engineerAlwaysOnShift(page);
        await page.evaluate(() => {
            const g = window.game;
            g.credits = 1000;
            g.repairQueue = [];
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0, module: null });
        });
        await page.click('#comms-nav-btn');
        await page.evaluate(() => window.game._selectCommsLocation('home'));

        // The transceiver is fitted and working, so it can only be bought to store.
        const listingId = await page.evaluate(() => window.game.market.find(l => l.moduleKey === 'transceiver').id);
        await expect(page.locator(`.market-buy-btn[data-listing-id="${listingId}"]`)).toBeDisabled();
        await page.click(`.market-store-btn[data-listing-id="${listingId}"]`);

        const bought = await page.evaluate(id => {
            const g = window.game, fab = g.fabrication;
            return { stored: fab.storedModule('mbox'), fittedPct: g.systems.transceiver.repairPct,
                     gone: !g.market.some(l => l.id === id), credits: g.credits };
        }, listingId);
        expect(bought.stored).toMatchObject({ moduleKey: 'transceiver', destroyed: false });
        expect(bought.fittedPct).toBeCloseTo(100, 3);
        expect(bought.gone).toBe(true);
        const paid = 1000 - bought.credits;

        const repaired = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication, rm = g.repairManager;
            const unit = 'box:mbox';
            const before = fab.moduleSaleValue(fab.storedModule('mbox'));
            const offered = rm.storedKeys();
            // The stored unit's own stages: start above 20% so no salvage gamble.
            fab.storedModule('mbox').repairPct = 25;
            rm.startRepair(unit, 100);
            const task = g.repairQueue[0];
            g.repairManager.processQueue(3600 * 200);
            g.systems.transceiver.active = false;
            rm.decay(3600 * 100); // stored modules don't wear
            return { offered, taskKey: task.systemKey, before, module: fab.storedModule('mbox'),
                     fitted: g.systems.transceiver.repairPct, value: fab.moduleSaleValue(fab.storedModule('mbox')), queue: g.repairQueue.length };
        });
        expect(repaired.offered).toEqual(['box:mbox']);
        expect(repaired.taskKey).toBe('box:mbox');
        expect(repaired.module.repairPct).toBe(100);
        expect(repaired.fitted).toBeGreaterThan(99); // the fitted one is untouched (bar a moment's wear)
        expect(repaired.queue).toBe(0);
        expect(repaired.value).toBe(400);

        await page.click('[data-fab-action="sellModule"][data-box-id="mbox"]');
        const sold = await page.evaluate(() => ({ credits: window.game.credits, module: window.game.fabrication.storedModule('mbox') }));
        expect(sold.module).toBe(null);
        expect(sold.credits - (1000 - paid)).toBe(400);
        expect(400).toBeGreaterThan(paid);

        const titles = await page.evaluate(() => window.game.notifications.list.map(n => n.title));
        expect(titles.some(t => /^Bought Salvaged Transceiver/.test(t))).toBe(true);
        expect(titles).toContain('Sold Transceiver');
    });

    test('a stored module swaps with the fitted one, and queued repairs follow their unit', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication, rm = g.repairManager;
            g.repairQueue = [];
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0,
                                 module: { moduleKey: 'o2', tier: 1, repairPct: 90, juryRigged: false, destroyed: false } });
            g.systems.o2.repairPct = 30;
            g.systems.o2.active = true;
            const fittedTask = rm.startRepair('o2', 100);
            g.notifications._prev = g.notifications._state();
            g.updateDisplay();
            const before = g.notifications.list.length;

            fab.swap('mbox');
            g.updateDisplay();
            return {
                fitted: { pct: g.systems.o2.repairPct, active: g.systems.o2.active },
                stored: fab.storedModule('mbox'),
                taskKey: fittedTask.systemKey,
                newTitles: g.notifications.list.slice(0, g.notifications.list.length - before).map(n => n.title),
            };
        });
        expect(r.fitted).toEqual({ pct: 90, active: false });
        expect(r.stored).toMatchObject({ moduleKey: 'o2', repairPct: 30 });
        expect(r.taskKey).toBe('box:mbox');
        expect(r.newTitles).toEqual(['O₂ Generator fitted from Machine Box 1']);
    });

    test('selling floods the market: the next of that type fetches less, recovering over time, and this is saved', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await freeze(page);
        const r = await page.evaluate(async () => {
            const g = window.game, fab = g.fabrication;
            const store = id => g.cargo.boxes.push({ id, size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0,
                module: { moduleKey: 'waterMaker', tier: 1, repairPct: 100, juryRigged: false, destroyed: false } });
            store('m1'); store('m2'); store('m3');
            const first  = fab.sellModule('m1');
            const second = fab.sellModule('m2');
            const otherType = fab.moduleSaleValue({ moduleKey: 'o2', repairPct: 100 });
            await g.saveGame();
            g.moduleResale = {};
            await GameState.loadServer(g, g.saveId);
            const afterLoad = fab.moduleSaleValue(fab.storedModule('m3'));
            fab.update(fab.MODULE_RESALE_RECOVERY_DAYS * 86400); // one sale's worth wears off
            const halfway = fab.moduleSaleValue(fab.storedModule('m3'));
            fab.update(fab.MODULE_RESALE_RECOVERY_DAYS * 86400 * 5);
            return { first, second, otherType, afterLoad, halfway, recovered: fab.moduleSaleValue(fab.storedModule('m3')), left: g.moduleResale };
        });
        expect(r.first).toBe(400);
        expect(r.second).toBe(320);   // −20% after one recent sale
        expect(r.otherType).toBe(400); // other module types unaffected
        expect(r.afterLoad).toBe(256); // two recent sales, kept across save and load
        expect(r.halfway).toBe(320);
        expect(r.recovered).toBe(400);
        expect(r.left).toEqual({});
    });

    test('a wrecked stored module cannot be fitted; buying to store needs an empty machine box', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.credits = 1000;
            const listing = g.market.find(l => l.moduleKey === 'co2');
            const noBox = g.commsNav.purchaseBlocker(listing, 'store');
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0,
                                 module: { moduleKey: 'power', tier: 1, repairPct: 0, juryRigged: false, destroyed: true } });
            const fullBox = g.commsNav.purchaseBlocker(listing, 'store');
            return { noBox, fullBox, swap: fab.swapBlocker('mbox'), scrap: fab.moduleSaleValue(fab.storedModule('mbox')),
                     dose: fab.doseBlocker('mbox') };
        });
        expect(r.noBox).toMatch(/machine storage box/);
        expect(r.fullBox).toMatch(/machine storage box/);
        expect(r.swap).toMatch(/Wrecked/);
        expect(r.scrap).toBe(15);
        expect(r.dose).toMatch(/equipment/);
    });

    test('machine boxes and their modules survive save and load, and show in the Cargo Hold', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(async () => {
            const g = window.game;
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0,
                                 module: { moduleKey: 'waterMaker', tier: 1, repairPct: 37, juryRigged: true, destroyed: false } });
            g.repairManager.startRepair('box:mbox', 50);
            const before = JSON.parse(JSON.stringify(g.cargo.boxes));
            await g.saveGame();
            g.cargo.boxes = [];
            g.repairQueue = [];
            await GameState.loadServer(g, g.saveId);
            return { before, after: g.cargo.boxes, task: g.repairQueue.find(t => t.systemKey === 'box:mbox')?.targetPct };
        });
        expect(r.after).toEqual(r.before);
        expect(r.task).toBe(50);

        await page.click('#cargo-btn');
        const row = page.locator('.cargo-box[data-box-id="mbox"]');
        await expect(row.locator('.task-title')).toContainText('Water Maker (37%, jury-rigged)');
        await expect(row.locator('.task-meta')).toContainText('repair queued');
        await expect(row.locator('[data-fab-action="swap"]')).toHaveText('Fit'); // no water maker fitted yet
        await expect(row.locator('[data-fab-action="sellModule"]')).toBeDisabled(); // not trading
    });
});
