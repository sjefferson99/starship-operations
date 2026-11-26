// Coverage for a batch of quality-of-life changes: leaving for the main menu
// through the game's own dialog, the 10000× speed and "Pause on notification",
// breaking a wrecked module down for parts, drones landing where the ship was
// (and waiting there for her), and the story page on first reaching the port.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

const freeze = page => page.evaluate(() => window.game._stopTimer());

async function run(page, hours, step = 600) {
    await page.evaluate(({ hours, step }) => {
        const g = window.game;
        for (let t = 0; t < hours * 3600; t += step) { g.gameTime += step; g.systemUpdate.update(step); }
        g.updateDisplay();
    }, { hours, step });
}

// Working thrusters, fuel, and the ship's clock stopped.
async function readyToFly(page) {
    await page.evaluate(() => {
        const g = window.game;
        Object.assign(g.systems.thrusters, { installed: true, destroyed: false, repairPct: 100 });
        g.systems.fuel.current = 60;
    });
}

test.describe('main menu', () => {
    test('with play since the last save, the game asks in its own dialog; Save & Quit saves first', async ({ page }) => {
        await startNewGame(page);
        await page.keyboard.press('Escape');
        await page.click('#main-menu-btn');
        await expect(page.locator('#quit-confirm')).toBeVisible();

        // Cancel goes back to the pause menu.
        await page.click('#quit-cancel-btn');
        await expect(page.locator('#quit-confirm')).toBeHidden();
        await expect(page.locator('#pause-menu')).toBeVisible();

        await page.evaluate(() => { window.__saves = 0; const real = GameState.saveServer; GameState.saveServer = async g => { window.__saves++; return real(g); }; });
        await page.click('#main-menu-btn');
        await page.click('#quit-save-btn');
        await page.waitForSelector('#launch-screen', { state: 'visible' });
        expect(await page.evaluate(() => window.__saves)).toBe(1);
    });

    test('saved from the pause menu, Main Menu goes straight out', async ({ page }) => {
        await startNewGame(page);
        await page.keyboard.press('Escape');
        await page.click('#save-btn');
        await expect.poll(() => page.evaluate(() => window.game._savedWhilePaused)).toBe(true);
        await page.click('#main-menu-btn');
        await page.waitForSelector('#launch-screen', { state: 'visible' });
        await expect(page.locator('#quit-confirm')).toBeHidden();
    });

    test('the launch screen has no Quit Game button', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#new-game-btn')).toBeVisible();
        await expect(page.locator('#quit-btn')).toHaveCount(0);
    });
});

test.describe('speed and notifications', () => {
    test('10000× is a speed', async ({ page }) => {
        await startNewGame(page);
        await page.click('#speed-10000x');
        expect(await page.evaluate(() => window.game.gameSpeed)).toBe(10000);
        await expect(page.locator('#speed-10000x')).toHaveClass(/speed-active/);
    });

    test('"1× on notification" drops the speed back to 1× when a tick lists something new', async ({ page }) => {
        await startNewGame(page);
        await page.check('#slow-on-news-toggle');
        await page.click('#speed-1000x');
        await page.evaluate(() => {
            const n = window.game.notifications;
            const before = n.addedCount;
            n.add({ title: 'Something happened' });
            if (n.addedCount > before) n.slowIfWanted(); // as the tick does
        });
        expect(await page.evaluate(() => window.game.gameSpeed)).toBe(1);
        await expect(page.locator('#speed-1x')).toHaveClass(/speed-active/);

        // Off: news leaves the speed alone.
        await page.uncheck('#slow-on-news-toggle');
        await page.click('#speed-100x');
        expect(await page.evaluate(() => { const n = window.game.notifications; n.add({ title: 'More' }); n.slowIfWanted(); return window.game.gameSpeed; })).toBe(100);
    });
});

test.describe('breaking down a wrecked module', () => {
    test('a wrecked stored module is broken down in the Work Queue into a few parts (maybe none)', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const r = await page.evaluate(() => {
            const g = window.game, fab = g.fabrication;
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0, module: null });
            fab.storeModule({ moduleKey: 'power', tier: 1, repairPct: 60 });
            const working = fab.breakDownBlocker('box:mbox');
            fab._box('mbox').module.destroyed = true;
            const before = { basic: fab.count('basicComponents'), precision: fab.count('precisionComponents') };
            const task = fab.queueBreakDown('box:mbox');
            const again = fab.breakDownBlocker('box:mbox');
            const sell  = fab.sellModuleBlocker('mbox');
            const waiting = fab._box('mbox').module !== null; // nothing happens until the job is done
            fab.completeTask(task);
            return {
                working, again, sell, waiting, hours: task.totalHours, empty: fab._box('mbox').module === null,
                basic: fab.count('basicComponents') - before.basic,
                precision: fab.count('precisionComponents') - before.precision,
                note: g.notifications.list[0].title,
            };
        });
        expect(r.working).toMatch(/Only a wrecked unit/);
        expect(r.again).toMatch(/Already in the work queue/);
        expect(r.sell).toMatch(/Being broken down/);
        expect(r.waiting).toBe(true);
        expect(r.hours).toBe(6);
        expect(r.empty).toBe(true);
        expect(r.basic).toBeGreaterThanOrEqual(0);
        expect(r.basic).toBeLessThanOrEqual(4);
        expect(r.precision).toBeGreaterThanOrEqual(0);
        expect(r.precision).toBeLessThanOrEqual(1);
        expect(r.note).toMatch(/Wrecked Power Generator broken down/);
    });

    test('a fitted wreck is broken down in place from its card, leaving the slot empty', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => {
            const g = window.game;
            Object.assign(g.systems.o2, { destroyed: true, repairPct: 0, active: false });
            g.updateDisplay();
        });
        const btn = page.locator('#card-o2 [data-fab-action="breakDown"][data-key="o2"]');
        await expect(btn).toBeEnabled();
        await btn.click();
        const r = await page.evaluate(() => {
            const g = window.game, task = g.repairQueue.find(t => t.kind === 'strip' && t.recipeKey === 'o2');
            g.fabrication.completeTask(task);
            g.updateDisplay();
            return { o2: { ...g.systems.o2 }, toggle: document.getElementById('o2-toggle').disabled,
                     label: document.getElementById('o2-repair-pct').textContent,
                     fitted: g.notifications.list.some(n => /O₂ Generator fitted/.test(n.title)) };
        });
        expect(r.o2).toMatchObject({ installed: false, destroyed: false, active: false });
        expect(r.toggle).toBe(true);
        expect(r.label).toBe('NOT FITTED');
        expect(r.fitted).toBe(false);
    });

    test('the Cargo Hold offers Break Down for Parts on a wrecked unit', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => {
            const g = window.game;
            g.cargo.boxes.push({ id: 'mbox', size: 'machine', kind: null, fillL: 0, sealed: false, compostHours: 0, module: null });
            g.fabrication.storeModule({ moduleKey: 'o2', tier: 1, repairPct: 0, destroyed: true });
            g.updateDisplay();
        });
        await page.click('#cargo-btn');
        const btn = page.locator('[data-box-id="mbox"] [data-fab-action="breakDown"]');
        await expect(btn).toBeEnabled();
        await btn.click();
        expect(await page.evaluate(() => window.game.repairQueue.some(t => t.kind === 'strip' && t.recipeKey === 'box:mbox'))).toBe(true);
    });
});

test.describe('drones and the ship apart', () => {
    test('a drone lands where the ship was and waits; she flies back to collect it', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await readyToFly(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            lg.buyDrone();
            lg._settleHome(g.drones[0]); // over from the port, aboard
            g.fabrication.buy('compostingAgent'); // waits at the port
            const d = g.drones[0];
            lg.planAdd(d.id, g.portHold[0].id, 1);
            return { launched: lg.launch(d.id), base: d.base };
        });
        expect(r).toEqual({ launched: true, base: 'yard' });

        // It loads at the port and heads back; meanwhile she flies off without it.
        await run(page, 1.3);
        expect(await page.evaluate(() => window.game.drones[0].state)).toBe('returning');
        expect(await page.evaluate(() => window.game.logistics.fly('port'))).toBe(true);
        await run(page, 2);
        const waiting = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, d = g.drones[0];
            return {
                berth: g.berth, state: d.state, left: lg.isLeftBehind(d), cargo: d.cargoIn.length,
                launch: lg.launchBlocker(d), dock: lg.stowBlocker(d), repair: g.repairManager.canRepair(lg.unitKey(d)),
                agent: g.fabrication.count('compostingAgent'),
            };
        });
        expect(waiting.berth).toBe('port');
        expect(waiting.state).toBe('parked');
        expect(waiting.left).toBe(true);
        expect(waiting.cargo).toBe(1); // still on the drone
        expect(waiting.agent).toBe(0);
        expect(waiting.launch).toMatch(/Waiting at Harlow's Salvage/);
        expect(waiting.dock).toMatch(/Waiting at Harlow's Salvage/);
        expect(waiting.repair).toBe(false);

        await page.evaluate(() => window.game.logistics.fly('yard'));
        await run(page, 1);
        const collected = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, d = g.drones[0];
            return { berth: g.berth, state: d.state, left: lg.isLeftBehind(d), agent: g.fabrication.count('compostingAgent'),
                     note: g.notifications.list.some(n => /Picked up Transfer Drone 1/.test(n.title)) };
        });
        expect(collected).toEqual({ berth: 'yard', state: 'stowed', left: false, agent: 1, note: true });
    });

    test('a drone left parked outside stays behind when she flies', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await readyToFly(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            g.credits = 2000;
            lg.buyDrone();
            lg._settleHome(g.drones[0]);
            lg.setDroneBerth(g.drones[0].id, 'parked');
            lg.fly('port');
            return { base: g.drones[0].base, left: lg.isLeftBehind(g.drones[0]) };
        });
        expect(r.base).toBe('yard');
        expect(r.left).toBe(true);
    });

    test('drone energy follows its load: empty legs cost less than loaded ones', async ({ page }) => {
        await startNewGame(page);
        const r = await page.evaluate(() => {
            const lg = window.game.logistics;
            return { empty: lg.droneLegWh(0), half: lg.droneLegWh(17.5), full: lg.droneLegWh(35), worst: lg.roundTripWh() };
        });
        expect(r.full).toBeCloseTo(600, 5);           // 120 km at 5 Wh/km, fully loaded
        expect(r.empty).toBeCloseTo(600 * 22 / 57, 5); // just the drone's own 22 kg
        expect(r.half).toBeCloseTo((r.empty + r.full) / 2, 5);
        expect(r.worst).toBeCloseTo(1200, 5);
    });

    test('ship fuel for a hop scales with her mass', async ({ page }) => {
        await startNewGame(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics;
            const cap = g._computeShipCapacity();
            const light = lg.hopFuelL();
            g.systems.freshWater.current = g.systems.freshWater.capacity; // heavier
            return { light, heavy: lg.hopFuelL(), massKg: cap.totalMassKg, maxKg: cap.maxMassKg };
        });
        // 20 L is the hop at her maximum laden mass.
        expect(r.light).toBeCloseTo(20 * r.massKg / r.maxKg, 1);
        expect(r.heavy).toBeGreaterThan(r.light);
    });
});

test.describe('port arrival story', () => {
    test('first landing at Port Carrow shows its story page once, holding the clock', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => localStorage.removeItem('starshipOps.storiesOff'));
        await freeze(page);
        await readyToFly(page);
        await page.evaluate(() => window.game.logistics.fly('port'));
        await run(page, 1);
        await expect(page.locator('#story-modal')).toBeVisible();
        await expect(page.locator('#story-header')).toContainText('PORT CARROW');
        expect(await page.evaluate(() => window.game._storyOpen)).toBe(true);
        await page.click('#story-continue-btn');
        await expect(page.locator('#story-modal')).toBeHidden();

        // Not again on a second visit.
        await page.evaluate(() => window.game.logistics.fly('yard'));
        await run(page, 1);
        await page.evaluate(() => window.game.logistics.fly('port'));
        await run(page, 1);
        await expect(page.locator('#story-modal')).toBeHidden();
    });
});

test.describe('feedback round two', () => {
    test('Comms & Nav opens from the header too', async ({ page }) => {
        await startNewGame(page);
        await page.click('#comms-nav-header-btn');
        await expect(page.locator('#comms-nav-screen')).toBeVisible();
    });

    test('fuel bought at the port is listed (and chimed) as a purchase', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game;
            g.berth = 'port';
            g.updateDisplay();
            const before = g.systems.fuel.current;
            g.logisticsAction('buyFuel');
            return { added: g.systems.fuel.current - before, note: g.notifications.list[0]?.detail ?? '' };
        });
        expect(r.added).toBeCloseTo(5, 5);
        expect(r.note).toMatch(/5 L of fuel/);
    });

    test('a drone sale of compost says how much of the box one run takes', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        const r = await page.evaluate(() => {
            const g = window.game, lg = g.logistics, fab = g.fabrication;
            g.credits = 2000;
            lg.buyDrone(); lg._settleHome(g.drones[0]);
            const box = fab.boxes().find(b => !b.kind);
            Object.assign(box, { kind: 'compost', fillL: 50, sealed: true, compostHours: fab.COMPOST_HOURS });
            lg.planOutAdd(g.drones[0].id, box.id);
            return { going: lg.planOutCompostLitres(g.drones[0])[box.id], label: g._compostSellLabel(box) };
        });
        expect(r.going).toBeCloseTo(35, 5);
        expect(r.label).toMatch(/Send 35 of 50 L by Drone/);
    });

    test('with the vents shut, life support that is off is flagged', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => window.game.updateDisplay());
        await expect(page.locator('#o2-toggle')).toHaveClass(/needs-attention/);
        await expect(page.locator('#life-support-note')).toBeVisible();
        await page.click('#vent-toggle'); // open
        await expect(page.locator('#o2-toggle')).not.toHaveClass(/needs-attention/);
        await expect(page.locator('#life-support-note')).toBeHidden();
    });

    test('the header stays put while the dashboard scrolls', async ({ page }) => {
        await startNewGame(page);
        const r = await page.evaluate(() => {
            const main = document.querySelector('.game-main');
            const headerTop = document.querySelector('.game-header').getBoundingClientRect().top;
            main.scrollTop = 400;
            return { scrolls: main.scrollHeight > main.clientHeight, moved: main.scrollTop > 0, page: window.scrollY,
                     headerTop, headerAfter: document.querySelector('.game-header').getBoundingClientRect().top };
        });
        expect(r.scrolls).toBe(true);
        expect(r.moved).toBe(true);
        expect(r.page).toBe(0);
        expect(r.headerAfter).toBe(r.headerTop);
    });
});
