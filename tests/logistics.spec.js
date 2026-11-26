// Logistics (logistics.js): the ship starts in Harlow's yard with both drives
// wrecked. Transfer drones carry what's bought from Port Carrow and what's sold
// to it; the wrecked drives are stripped for parts; a drone dock charges a
// drone from spare generator power; new atmospheric thrusters fly her to the port.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

const freeze = page => page.evaluate(() => window.game._stopTimer());

async function engineerAlwaysOnShift(page) {
    await page.evaluate(() => {
        const g = window.game;
        g.crewManifest.forEach(m => { m.shifts = [{ startHour: 0, endHour: 8 }]; m.health = 100; });
        g.repairQueue = []; // the new game's own repairs aren't part of these tests
    });
}

// Runs the simulation forward `hours` in small steps, advancing the clock as the tick loop does.
async function run(page, hours, step = 600) {
    await page.evaluate(({ hours, step }) => {
        const g = window.game;
        for (let t = 0; t < hours * 3600; t += step) { g.gameTime += step; g.systemUpdate.update(step); }
        g.updateDisplay();
    }, { hours, step });
}

test.describe('starting out at the yard', () => {
    test('a new ship is at Harlow\'s yard with both drives wrecked and no drone', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game;
            return { berth: g.berth, drones: g.drones.length, thrusters: g.systems.thrusters, ion: g.systems.ionDrive,
                     bg: document.body.dataset.bg };
        });
        expect(r).toMatchObject({ berth: 'yard', drones: 0, bg: 'city' });
        expect(r.thrusters).toMatchObject({ installed: true, destroyed: true });
        expect(r.ion).toMatchObject({ installed: true, destroyed: true });
        await expect(page.locator('#thrusters-badge')).toHaveText('WRECKED');
        await expect(page.locator('#iondrive-badge')).toHaveText('WRECKED');
        await expect(page.locator('#drone-badge')).toHaveText('NONE');
        await expect(page.locator('[data-logi-action="strip"][data-key="thrusters"]')).toBeEnabled();
    });

    test('nothing can be ordered from the yard until there is a drone', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game;
            return {
                item: g.fabrication.buyBlocker('basicComponents'),
                food: g.fabrication.buyFoodBlocker(),
                fuel: g.logistics.buyFuelBlocker(),
                module: g.commsNav.purchaseBlocker(g.market.find(l => l.moduleKey === 'waterMaker')),
                drone: g.logistics.buyDroneBlocker(),
            };
        });
        for (const key of ['item', 'food', 'fuel', 'module']) expect(r[key]).toMatch(/transfer drone first/);
        expect(r.drone).toBeNull();
    });
});

test.describe('transfer drones', () => {
    test('a bought drone flies itself over, charged, and is stowed aboard without a dock', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await page.click('#comms-nav-btn');
        await page.evaluate(() => window.game._selectCommsLocation('home'));
        await page.click('[data-logi-action="buyDrone"]');

        const bought = await page.evaluate(() => ({ credits: window.game.credits, drone: { ...window.game.drones[0] } }));
        expect(bought.credits).toBe(700);
        expect(bought.drone).toMatchObject({ state: 'arriving', chargeWh: 1500, repairPct: 100 });
        expect(bought.drone.hoursLeft).toBeCloseTo(1.2, 5);

        await page.click('#comms-nav-close-btn');
        await run(page, 1.25);
        const home = await page.evaluate(() => ({ drone: { ...window.game.drones[0] }, titles: window.game.notifications.list.map(n => n.title) }));
        // Flying itself over costs nothing: it arrives as it was sold.
        expect(home.drone).toMatchObject({ state: 'stowed', chargeWh: 1500, repairPct: 100 });
        expect(home.titles).toContain('Transfer Drone 1 has arrived');
        await expect(page.locator('#drone-badge')).toHaveText('READY');
        // Nothing is planned yet, so there's no reason to send it.
        const send = page.locator('.drone-row [data-logi-action="launch"]');
        await expect(send).toBeDisabled();
        await expect(send).toHaveAttribute('title', /Plan Run/);
        await expect(page.locator('.drone-row [data-logi-action="park"]')).toHaveText('Park Outside');
        await expect(page.locator('.drone-row [data-logi-action="park"]')).toHaveAttribute('title', /can't charge/);
    });

    test('an order waits at the port until a drone run brings it, and the run costs charge and wear', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            const listing = g.market.find(l => l.moduleKey === 'waterMaker');
            g.commsNav.purchase(listing.id);
            g.fabrication.buy('compostingAgent');
            g.fabrication.buyFood();
            g.fabrication.buy('basicComponents');
            g.fabrication.buy('basicComponents');
            const drone = g.drones[0];
            const [maker, agent, food, parts] = g.portHold;
            const unplanned = lg.launchBlocker(drone);
            // The first load the tips suggest: water maker, composting agent and a case of food — 35 kg.
            const planned = [lg.planAdd(drone.id, maker.id, 1), lg.planAdd(drone.id, agent.id, 1), lg.planAdd(drone.id, food.id, 'max')];
            const overweight = lg.planAddBlocker(drone, parts.id, 1);
            return { listing, hold: g.portHold.map(e => lg.entryLabel(e)), fitted: g.systems.waterMaker.installed,
                     rations: g.fabrication.rationsAboard(),
                     unplanned, planned, overweight, planKg: lg.planMassKg(drone), launched: lg.launch(drone.id) };
        });
        // Repeat orders of the same thing are one line.
        expect(r.hold[0]).toBe(`Water Maker (${Math.round(r.listing.repairPct)}%)`);
        expect(r.hold[3]).toBe('2 × Basic Components');
        expect(r.fitted).toBe(false);
        expect(r.unplanned).toMatch(/Nothing planned/);
        expect(r.planned).toEqual([true, true, true]);
        expect(r.overweight).toMatch(/35 kg limit/);
        expect(r.planKg).toBe(35);
        expect(r.launched).toBe(true);

        await run(page, 1.0);
        expect(await page.evaluate(() => window.game.drones[0].state)).toBe('outbound');
        await run(page, 1.5);
        const back = await page.evaluate(() => {
            const g = window.game;
            return { drone: { ...g.drones[0] }, hold: g.portHold.length, maker: { ...g.systems.waterMaker },
                     basic: g.fabrication.count('basicComponents'), agent: g.fabrication.count('compostingAgent'),
                     rations: g.fabrication.rationsAboard() };
        });
        // Only what was planned came back: the components wait at the port.
        expect(back.maker).toMatchObject({ installed: true, repairPct: r.listing.repairPct });
        expect(back.basic).toBe(0);
        expect(back.agent).toBe(1);
        expect(back.rations).toBe(r.rations + 10);
        expect(back.hold).toBe(1);
        expect(back.drone.state).toBe('stowed');
        // 5 Wh/km is the drone fully loaded (22 kg + 35 kg): out empty at 22/57 of
        // that, back with the full 35 kg at all of it.
        expect(back.drone.chargeWh).toBeCloseTo(1500 - 120 * 5 * 22 / 57 - 120 * 5, 3);
        expect(back.drone.repairPct).toBeCloseTo(100 - 240 * 0.02, 3); // 0.02% a km
        expect(back.drone.plan).toEqual([]);
        expect(await page.evaluate(() => window.game.logistics.launchBlocker(window.game.drones[0], { forSale: true }))).toMatch(/Needs 832 Wh/); // a full sale out, back empty
    });

    test('a drone carries at most 35 kg: heavy modules wait for the port, and a planned share of an order goes', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 5000;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            g.systems.power.destroyed = true; // so a generator could be bought to fit
            const generator = g.commsNav.purchaseBlocker(g.market.find(l => l.moduleKey === 'power'));
            for (let i = 0; i < 8; i++) lg.buyFuel(); // 40 L
            const fits = lg.planMaxFit(g.drones[0], g.portHold[0].id);
            lg.planAdd(g.drones[0].id, g.portHold[0].id, 'max');
            lg.launch(g.drones[0].id);
            g.gameTime += 3600 * 3; g.systemUpdate.update(3600 * 3); // one huge tick: the whole round trip
            return { generator, fits, fuel: g.systems.fuel.current, hold: g.portHold.map(e => ({ ...e })), state: g.drones[0].state };
        });
        expect(r.generator).toMatch(/Too heavy for a drone \(65 kg/);
        expect(r.fits).toBe(35);
        expect(r.state).toBe('stowed');
        expect(r.fuel).toBeCloseTo(10 + 35, 3); // a new ship's 10 L, plus 35 L
        expect(r.hold).toMatchObject([{ kind: 'fuel', litres: 5 }]);
    });

    test('selling from the yard sends it by drone, up to 35 L of compost a run, paid for at the port', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            g.credits = 0;
            g.cargo.boxes.push({ id: 'box-c', size: 'standard', kind: 'compost', fillL: 40, sealed: true, compostHours: 72, module: null, parts: null });
            g.updateDisplay();
        });
        await page.click('#cargo-btn');
        const sell = page.locator('[data-fab-action="sell"][data-box-id="box-c"]');
        await expect(sell).toContainText('Send 35 of 40 L by Drone'); // one run takes 35 kg of it
        await sell.click();

        const away = await page.evaluate(() => ({ box: window.game.cargo.boxes.find(b => b.id === 'box-c').fillL, out: window.game.drones[0].cargoOut, credits: window.game.credits }));
        expect(away.box).toBeCloseTo(5, 5);
        expect(away.out).toEqual([{ kind: 'compost', litres: 35 }]);
        expect(away.credits).toBe(0);

        await run(page, 1.3);
        const paid = await page.evaluate(() => ({ credits: window.game.credits, titles: window.game.notifications.list.map(n => n.title) }));
        expect(paid.credits).toBe(35 * 4);
        expect(paid.titles).toContain('Sold at Port Carrow');
    });

    test('a drone can be repaired in the work queue while it is home', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await engineerAlwaysOnShift(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, rm = g.repairManager;
            lg.buyDrone();
            const drone = g.drones[0];
            drone.repairPct = 30;
            const away = rm.canRepair(lg.unitKey(drone)); // still flying over
            lg._settleHome(drone);
            const task = rm.startRepair(lg.unitKey(drone), 100);
            const blocked = lg.launchBlocker(drone);
            rm.processQueue(3600 * 20);
            return { away, label: g._repairSystemLabel(task.systemKey), blocked, pct: drone.repairPct, queue: g.repairQueue.length };
        });
        expect(r.away).toBe(false);
        expect(r.label).toBe('Transfer Drone 1');
        expect(r.blocked).toBe('Being repaired');
        expect(r.pct).toBe(100);
        expect(r.queue).toBe(0);
    });
});

test.describe('planning what goes out', () => {
    test('sending a stored module out frees its machine box for the one coming back, on the same run', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            g.credits = 5000;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            const box = fab._emptyBox('machine');
            box.module = { moduleKey: 'transceiver', tier: 1, repairPct: 100, juryRigged: false, destroyed: false };
            fab.boxes().push(box);
            g.commsNav.purchase(g.market.find(l => l.moduleKey === 'waterMaker').id, 'store');
            g.updateDisplay();
        });
        await page.click('.drone-row [data-logi-action="planRun"]');
        const screen = page.locator('#drone-run-screen');
        const holdId = await page.evaluate(() => window.game.portHold[0].id);
        const boxId  = await page.evaluate(() => window.game.fabrication.machineBoxes()[0].id);
        const bringBack = screen.locator(`[data-hold-id="${holdId}"] [data-logi-action="planAdd"]`);

        // The only machine box is full: the water maker can't come back yet.
        await expect(bringBack).toBeDisabled();
        await expect(bringBack).toHaveAttribute('title', /No empty machine storage box/);

        // Send the stored transceiver to sell: its box is then free for the water maker.
        await screen.locator(`[data-out-box-id="${boxId}"] [data-logi-action="planOutAdd"]`).click();
        await expect(screen.locator('.drone-run-out-weight-label')).toContainText('6 kg of 35 kg');
        await expect(bringBack).toBeEnabled();
        await bringBack.click();
        await expect(screen.locator('.drone-run-weight-label')).toContainText('24 kg of 35 kg');
        await screen.locator('.drone-run-footer [data-logi-action="launch"]').click();
        await expect(screen).toBeHidden();

        const away = await page.evaluate(() => ({ box: window.game.fabrication.machineBoxes()[0].module, out: window.game.drones[0].cargoOut.map(e => e.moduleKey) }));
        expect(away.box).toBeNull();
        expect(away.out).toEqual(['transceiver']);

        const back = await page.evaluate(() => {
            const g = window.game, credits = g.credits;
            g.gameTime += 3600 * 3; g.systemUpdate.update(3600 * 3);
            return { stored: g.fabrication.machineBoxes()[0].module?.moduleKey, earned: g.credits - credits,
                     hold: g.portHold.length, planOut: g.drones[0].planOut };
        });
        expect(back.stored).toBe('waterMaker');
        expect(back.earned).toBeGreaterThan(0);
        expect(back.hold).toBe(0);
        expect(back.planOut).toEqual([]);
    });

    test('an outbound plan survives a save and load', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(async () => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            const box = fab._emptyBox('machine');
            box.module = { moduleKey: 'transceiver', tier: 1, repairPct: 60, juryRigged: false, destroyed: false };
            fab.boxes().push(box);
            lg.planOutAdd(g.drones[0].id, box.id);
            await g.saveGame();
            lg.reset();
            await GameState.loadServer(g, g.saveId);
            return g.drones[0].planOut;
        });
        expect(r).toEqual([{ kind: 'module', boxId: expect.any(String) }]);
    });
});

test.describe('salvage restocking', () => {
    test('drone-sized salvage comes in at the port three times a day, up to a cap of each kind', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game, cn = g.commsNav;
            const count = key => g.market.filter(l => l.moduleKey === key).length;
            g.market = g.market.filter(l => l.moduleKey !== 'waterMaker' && l.moduleKey !== 'transceiver');
            const titles = () => g.notifications.list.map(n => n.title);
            // From midnight to 02:59 nothing comes in; 03:00 brings one.
            g.gameTime = 2 * 3600 + 3599; cn.update(2 * 3600 + 3599);
            const before = count('waterMaker') + count('transceiver');
            g.gameTime += 1; cn.update(1);
            const first = { water: count('waterMaker'), trans: count('transceiver'), note: titles().includes('New salvage at the port') };
            // A long stretch fills both kinds to their cap and stops there.
            g.gameTime += 10 * 86400; cn.update(10 * 86400);
            const listing = g.market.find(l => l.moduleKey === 'transceiver');
            return { before, first, water: count('waterMaker'), trans: count('transceiver'), listing };
        });
        expect(r.before).toBe(0);
        expect(r.first).toEqual({ water: 1, trans: 0, note: true });
        expect(r.water).toBe(3);
        expect(r.trans).toBe(3);
        expect(r.listing.repairPct).toBeGreaterThanOrEqual(8);
        expect(r.listing.repairPct).toBeLessThanOrEqual(45);
        expect(r.listing.price).toBeGreaterThanOrEqual(100);
    });
});

test.describe('planning a run', () => {
    test('Plan Run shows what is waiting and the weight, refuses what would not fit, and sends the drone', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            for (let i = 0; i < 8; i++) g.fabrication.buy('basicComponents'); // 8 × 5 kg
            lg.buyFuel();                                                       // 5 L
            g.updateDisplay();
        });
        await page.click('.drone-row [data-logi-action="planRun"]');
        const screen = page.locator('#drone-run-screen');
        await expect(screen).toBeVisible();
        await expect(page.locator('#drone-run-title')).toHaveText('Transfer Drone 1 — Plan Run');
        await expect(screen.locator('.drone-run-weight-label')).toContainText('0 kg of 35 kg');
        await expect(screen.locator('.drone-run-footer [data-logi-action="launch"]')).toBeDisabled();

        // All the components that fit: 7 of the 8.
        const parts = await page.evaluate(() => window.game.portHold[0].id);
        await screen.locator(`[data-hold-id="${parts}"] [data-logi-action="planAdd"][data-qty="max"]`).click();
        await expect(screen.locator('.drone-run-weight-label')).toContainText('35 kg of 35 kg');
        await expect(screen.locator('#drone-run-planned')).toContainText('7 × Basic Components');
        await expect(screen.locator(`[data-hold-id="${parts}"] .task-title`)).toContainText('1 × Basic Components');

        // Full: fuel can't be added, and says why.
        const fuel = await page.evaluate(() => window.game.portHold[1].id);
        const addFuel = screen.locator(`[data-hold-id="${fuel}"] [data-logi-action="planAdd"][data-qty="1"]`);
        await expect(addFuel).toBeDisabled();
        await expect(addFuel).toHaveAttribute('title', /35 kg limit/);

        // Take one component off; then a litre of fuel fits.
        await screen.locator(`[data-plan-hold-id="${parts}"] [data-logi-action="planRemove"][data-qty="1"]`).click();
        await expect(screen.locator('.drone-run-weight-label')).toContainText('30 kg of 35 kg');
        await addFuel.click();
        await expect(screen.locator('.drone-run-weight-label')).toContainText('31 kg of 35 kg');

        await screen.locator('.drone-run-footer [data-logi-action="launch"]').click();
        await expect(screen).toBeHidden();
        const r = await page.evaluate(() => {
            const g = window.game;
            g.gameTime += 3600 * 3; g.systemUpdate.update(3600 * 3);
            return { basic: g.fabrication.count('basicComponents'), fuel: g.systems.fuel.current,
                     hold: g.portHold.map(e => g.logistics.entryLabel(e)) };
        });
        expect(r.basic).toBe(6);
        expect(r.fuel).toBeCloseTo(11, 5);
        expect(r.hold).toEqual(['2 × Basic Components', '4 L fuel']);
    });

    test('a plan never takes more than is waiting, across drones', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            lg.buyDrone(); lg._settleHome(g.drones[1]);
            g.fabrication.buy('precisionComponents');
            g.fabrication.buy('precisionComponents');
            const id = g.portHold[0].id;
            lg.planAdd(g.drones[0].id, id, 'max');
            return { first: lg.plan(g.drones[0]), second: lg.planAddBlocker(g.drones[1], id, 1), free: lg.availableQty(id) };
        });
        expect(r.first).toEqual([{ holdId: expect.any(String), qty: 2 }]);
        expect(r.second).toBe('Nothing more of that waiting');
        expect(r.free).toBe(0);
    });

    test('modules can be ordered ahead of a machine box, but nothing is planned that there is nowhere aboard to put', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            g.credits = 5000;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            const drone = g.drones[0];
            // From the yard a module can be ordered to store before there's any machine box:
            // it waits at the port, and Plan Run won't bring it back until there's a box for it.
            const [a, b] = g.market.filter(l => fab.moduleMassKg({ moduleKey: l.moduleKey, tier: 1 }) <= lg.droneSpec('payloadKg'));
            const first = g.commsNav.purchase(a.id, 'store');
            const moduleId = g.portHold[0].id;
            const noBox = lg.planAddBlocker(drone, moduleId, 1);
            // One box: a second module can still be ordered, but only one planned.
            fab.boxes().push(fab._emptyBox('machine'));
            const second = g.commsNav.purchase(b.id, 'store');
            const boxFree = lg.planAddBlocker(drone, moduleId, 1);
            lg.planAdd(drone.id, moduleId, 1);
            const secondPlan = lg.roomAboardFor(g.portHold[1]); // the one box is taken by the first
            lg.planClear(drone.id);
            g.portHold = g.portHold.filter(e => e.kind !== 'module');

            // Parts: Storage Box 2 holds 12 basic components (4 L each); fill all but 2 of it.
            fab.storeParts('basicComponents', 10);
            for (let i = 0; i < 4; i++) fab.buy('basicComponents');
            const partsId = g.portHold[0].id;
            const fits = lg.planMaxFit(drone, partsId);
            lg.planAdd(drone.id, partsId, 'max');
            const more = lg.planAddBlocker(drone, partsId, 1);
            return { first, second, noBox, boxFree, secondPlan, fits, more };
        });
        expect(r.first).toBe(true);
        expect(r.noBox).toMatch(/No empty machine storage box/);
        expect(r.second).toBe(true);
        expect(r.boxFree).toBeNull();
        expect(r.secondPlan).toBe(0);
        expect(r.fits).toBe(2);
        expect(r.more).toMatch(/No room left in the storage boxes/);
    });
});

test.describe('stripping the drives, the dock and the thrusters', () => {
    test('stripping a wrecked drive needs an empty box, takes crew hours, and fills a parts box', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await engineerAlwaysOnShift(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            const boxes = g.cargo.boxes;
            g.cargo.boxes = [boxes[0]]; // only the food box: nowhere for the parts
            const noBox = lg.stripBlocker('thrusters');
            g.cargo.boxes = boxes;
            const t1 = lg.queueStrip('thrusters');
            const t2 = lg.queueStrip('ionDrive');
            const again = lg.stripBlocker('thrusters');
            g.repairManager.processQueue(3600 * 7);
            const midway = g.systems.thrusters.installed;
            for (let h = 0; h < 13; h++) g.repairManager.processQueue(3600); // both done (one engineer, one after the other)
            return { noBox, again, hours: [t1.totalHours, t2.totalHours], midway,
                     thrusters: { ...g.systems.thrusters }, ion: { ...g.systems.ionDrive },
                     precision: fab.count('precisionComponents'), basic: fab.count('basicComponents'),
                     box: { kind: fab.boxes()[1].kind, fillL: fab.boxes()[1].fillL },
                     titles: g.notifications.list.map(n => n.title) };
        });
        expect(r.noBox).toMatch(/empty storage box/);
        expect(r.again).toBe('Already in the work queue');
        expect(r.hours).toEqual([8, 12]);
        expect(r.midway).toBe(true);
        expect(r.thrusters).toMatchObject({ installed: false, destroyed: false });
        expect(r.ion).toMatchObject({ installed: false, destroyed: false });
        expect(r.precision).toBe(5);
        expect(r.basic).toBe(7);
        // Storage Box 2, the empty one a new ship has: 5 × 2 L + 7 × 4 L.
        expect(r.box).toEqual({ kind: 'parts', fillL: 38 });
        expect(r.titles).toContain('Atmospheric Thrusters stripped for parts');
        await page.evaluate(() => window.game.updateDisplay());
        await expect(page.locator('#thrusters-badge')).toHaveText('NOT FITTED');
    });

    test('a drone dock charges a docked drone from spare generator power only, never the battery', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await engineerAlwaysOnShift(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication, s = g.systems;
            fab.storeParts('precisionComponents', 1);
            fab.storeParts('basicComponents', 2);
            const task = fab.queueFabrication('droneDock');
            g.repairManager.processQueue(3600 * 24);
            const docks = g.droneDocks;

            lg.buyDrone();
            const drone = g.drones[0];
            lg._settleHome(drone); // a free dock: straight onto it
            drone.chargeWh = 0;

            // Generator off: nothing charges it, and the battery isn't touched for it.
            s.power.active = false; s.power.current = 500;
            s.transceiver.active = false; // nothing else drawing on the battery
            g.systemUpdate.update(3600);
            const off = { charge: drone.chargeWh, battery: s.power.current };

            // Generator running and repaired: the dock takes what the ship isn't using, up to 120 W.
            s.power.active = true; s.power.repairPct = 100; s.fuel.current = 50;
            g.systemUpdate.update(3600);
            const on = { charge: drone.chargeWh, dockW: s.power.dockW };
            return { hours: task.totalHours, docks, state: drone.state, off, on };
        });
        expect(r.hours).toBe(24);
        expect(r.docks).toBe(1);
        expect(r.state).toBe('docked');
        expect(r.off.charge).toBe(0);
        expect(r.off.battery).toBeCloseTo(500, 5);
        expect(r.on.dockW).toBeCloseTo(120, 5);
        expect(r.on.charge).toBeCloseTo(120, 3);
    });

    test('"charge from battery" lets a docked drone charge from the ship battery, down to a 20% floor', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await page.evaluate(() => {
            const g = window.game, lg = g.logistics, s = g.systems;
            g.droneDocks = 1;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            g.drones[0].chargeWh = 0;
            s.power.active = false;            // no generator: no spare power at all
            s.transceiver.active = false;      // nothing else drawing on the battery
            s.power.current = 500;
            g.updateDisplay();
        });
        const btn = page.locator('.drone-row [data-logi-action="batteryCharge"]');
        await expect(btn).toHaveText('Charge from Battery: OFF');
        await btn.click();
        await expect(btn).toHaveText('Charge from Battery: ON');

        const r = await page.evaluate(() => {
            const g = window.game, s = g.systems, drone = g.drones[0];
            g.systemUpdate.update(3600);
            const hour1 = { charge: drone.chargeWh, battery: s.power.current, fromBattery: s.power.dockBatteryW };
            g.systemUpdate.update(3600 * 5); // would take 600 Wh; only 180 are left above the floor
            return { hour1, charge: drone.chargeWh, battery: s.power.current };
        });
        expect(r.hour1.charge).toBeCloseTo(120, 3);
        expect(r.hour1.battery).toBeCloseTo(380, 3);
        expect(r.hour1.fromBattery).toBeCloseTo(120, 3);
        expect(r.battery).toBeCloseTo(200, 3); // 20% of 1000 Wh, kept for the ship
        expect(r.charge).toBeCloseTo(300, 3);
        // At the floor, nothing more is drawn, and the card says why.
        await page.evaluate(() => { window.game.systemUpdate.update(600); window.game.updateDisplay(); });
        await expect(page.locator('.drone-row .drone-meta')).toContainText('20% floor');
    });

    test('new thrusters are built after the wreck is stripped, and fly her to the port', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await engineerAlwaysOnShift(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            fab.storeParts('precisionComponents', 10);
            fab.storeParts('basicComponents', 12, { force: true });
            const wrecked = fab.fabricateBlocker('thrusters');
            g.systems.thrusters.installed = false; g.systems.thrusters.destroyed = false; // as if stripped
            const task = fab.queueFabrication('thrusters');
            g.repairManager.processQueue(3600 * 72);
            const fitted = { ...g.systems.thrusters };

            g.systems.fuel.current = 10;
            const noFuel = lg.flyBlocker('port');
            g.systems.fuel.current = 30;
            const hopFuel = lg.hopFuelL();
            g.ventsOpen = true;
            const vents = lg.flyBlocker('port');
            g.ventsOpen = false;
            lg.buyDrone(); // still flying over: it doesn't stop her going
            const droneOut = lg.flyBlocker('port');
            lg._settleHome(g.drones[0]);
            g.drones[0].state = 'stowed';
            return { wrecked, hours: task.totalHours, fitted, noFuel, hopFuel, vents, droneOut, ready: lg.flyBlocker('port') };
        });
        expect(r.wrecked).toMatch(/Strip the wrecked atmospheric thrusters/);
        expect(r.hours).toBe(72);
        expect(r.fitted).toMatchObject({ installed: true, destroyed: false, repairPct: 100 });
        // 20 L is the hop at her maximum laden mass; she's lighter than that.
        expect(r.hopFuel).toBeGreaterThan(10);
        expect(r.hopFuel).toBeLessThan(20);
        expect(r.noFuel).toBe(`Needs ${r.hopFuel} L of fuel`);
        expect(r.vents).toMatch(/Close the vents/);
        expect(r.droneOut).toBeNull();
        expect(r.ready).toBeNull();

        await page.evaluate(() => {
            const g = window.game;
            g.credits = 1000;
            g.fabrication.buy('compostingAgent'); // waits at the port
            g.updateDisplay();
        });
        await page.click('[data-logi-action="fly"][data-to="port"]');
        const flying = await page.evaluate(() => ({ fuel: window.game.systems.fuel.current, flight: { ...window.game.flight } }));
        // Nothing burnt yet: the fuel goes as she flies.
        expect(flying.fuel).toBeCloseTo(30, 5);
        expect(flying.flight.to).toBe('port');
        expect(flying.flight.fuelL).toBeCloseTo(r.hopFuel, 5);
        expect(await page.evaluate(() => { window.game.toggleVents(); return window.game.ventsOpen; })).toBe(false); // shut in flight
        await expect(page.locator('body')).toHaveAttribute('data-bg', 'flight');
        await expect(page.locator('#location-name')).toHaveText('In flight to Port Carrow');
        expect(await page.evaluate(() => window.game.fabrication.buyBlocker('basicComponents'))).toMatch(/In flight/);

        await run(page, 0.5, 60);
        const landed = await page.evaluate(() => ({
            berth: window.game.berth, flight: window.game.flight, hold: window.game.portHold.length,
            agent: window.game.fabrication.count('compostingAgent'), mode: window.game.logistics.tradeMode(),
        }));
        // At the port, what was waiting comes straight aboard, and trade is direct.
        expect(landed).toEqual({ berth: 'port', flight: null, hold: 0, agent: 1, mode: 'direct' });
        // The whole hop's fuel was burnt on the way, and no more.
        expect(await page.evaluate(() => window.game.systems.fuel.current)).toBeCloseTo(30 - r.hopFuel, 3);
        await expect(page.locator('body')).toHaveAttribute('data-bg', 'port');
        await expect(page.locator('[data-logi-action="fly"][data-to="yard"]')).toBeVisible();
    });
});

test.describe('saving', () => {
    test('berth, flight, docks, drones mid-run and the port hold survive a save and load', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(async () => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            g.droneDocks = 1;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            lg.buyDrone(); lg._settleHome(g.drones[1]);
            g.drones[1].chargeFromBattery = true;
            g.fabrication.buy('precisionComponents');
            lg.buyFuel();
            g.drones[1].cargoIn = [{ kind: 'item', key: 'basicComponents', count: 2 }];
            lg.planAdd(g.drones[1].id, g.portHold[0].id, 1);
            lg.launch(g.drones[0].id, [{ kind: 'compost', litres: 12 }]);
            g.drones[0].hoursLeft = 0.7;
            g.flight = { to: 'port', hoursLeft: 0.1, totalHours: 0.3, fuelL: 14.8 };
            const strip = lg.queueStrip('ionDrive');
            const snap = () => JSON.parse(JSON.stringify({ berth: g.berth, flight: g.flight, docks: g.droneDocks, drones: g.drones, hold: g.portHold }));
            const before = snap();
            await g.saveGame();
            lg.reset();
            g.repairQueue = [];
            await GameState.loadServer(g, g.saveId);
            return { before, after: snap(), strip: g.repairQueue.find(t => t.id === strip.id) };
        });
        expect(r.after).toEqual(r.before);
        expect(r.strip).toMatchObject({ kind: 'strip', recipeKey: 'ionDrive', totalHours: 12 });
    });

    test('a save from before logistics starts at the yard, drives wrecked, no drones', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game;
            const world = GameState.snapshot(g);
            const ships = GameState.shipInstanceSnapshot(g);
            delete ships.ships[0].logistics;
            delete ships.ships[0].systemState.thrusters;
            delete ships.ships[0].systemState.ionDrive;
            g.berth = 'port'; g.droneDocks = 3; g.systems.thrusters.installed = false;
            GameState.restore(g, world, ships);
            return { berth: g.berth, docks: g.droneDocks, drones: g.drones, hold: g.portHold, thrusters: g.systems.thrusters };
        });
        expect(r).toMatchObject({ berth: 'yard', docks: 0, drones: [], hold: [] });
        expect(r.thrusters).toMatchObject({ installed: true, destroyed: true });
    });
});
