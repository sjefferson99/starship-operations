// E2E coverage for: the power budget (nothing electrical runs without power),
// the transceiver and what its range reveals, the local market and water
// maker, shift fatigue, and black-water overflow / dump fines. Like the other
// specs, drives real game logic through window.game rather than re-implementing it.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

// Freezes the 1-second game timer so only the ticks a test runs explicitly happen.
const freeze = page => page.evaluate(() => window.game._stopTimer());

test.describe('power budget', () => {
    test('a powered module produces nothing with a flat battery and no generator', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            g.systems.o2.repairPct = 100; g.systems.o2.active = true; g.systems.o2.pct = 18;
            g.systems.power.current = 0;  g.systems.power.active = false;
            g.systemUpdate.update(3600);
            g.updateDisplay();
            const dead = { gen: g.systems.o2.generationLhr, fraction: g.systems.power.powerFraction };

            g.systems.power.current = 500;
            g.systems.o2.repairPct  = 100; // undo the hour of wear from being switched on above
            g.systemUpdate.update(60);
            return { dead, live: { gen: g.systems.o2.generationLhr, fraction: g.systems.power.powerFraction } };
        });

        expect(result.dead).toEqual({ gen: 0, fraction: 0 });
        expect(result.live.fraction).toBe(1);
        expect(result.live.gen).toBeCloseTo(22.5, 5);
    });

    test('the dashboard flags an unpowered module as NO POWER', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await page.evaluate(() => {
            const g = window.game;
            g.systems.co2.active = true;
            g.systems.power.current = 0;
            g.systemUpdate.update(60);
            g.updateDisplay();
        });
        await expect(page.locator('#co2-status')).toContainText('NO POWER');
        await expect(page.locator('#power-shortfall')).toContainText('NO POWER');
    });

    test('one huge tick cannot run a module for longer than the battery lasts', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            g.systems.o2.repairPct = 100; g.systems.o2.active = true; g.systems.o2.pct = 18;
            g.systems.power.current = 2.1; // enough for a tenth of an hour of the 21 W generator
            g.systemUpdate.update(3600);
            return { gen: g.systems.o2.generationLhr, fraction: g.systems.power.powerFraction, left: g.systems.power.current };
        });

        expect(result.fraction).toBeCloseTo(0.1, 5);
        expect(result.gen).toBeCloseTo(2.25, 5);
        expect(result.left).toBeCloseTo(0, 5);
    });
});

test.describe('transceiver', () => {
    test('a new ship reaches nothing; range then reveals the local network first, then the rest', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const reach = pct => page.evaluate(repairPct => {
            const g = window.game;
            g.systems.transceiver.repairPct = repairPct;
            g.systemUpdate.update(1);
            return {
                range: g.commsNav.rangeLy(),
                local: g.commsNav.hasLocalDetails(),
                visible: g.commsNav.visibleLocations().map(l => l.kind),
            };
        }, pct);

        // Switched off (the starting state): no range at all, but you still know where you are.
        expect(await reach(25)).toEqual({ range: 0, local: false, visible: ['home'] });

        await page.click('#transceiver-toggle');
        const worn = await reach(25);
        expect(worn.range).toBeCloseTo(0.125, 5);
        expect(worn.local).toBe(false);
        expect(worn.visible).toEqual(['home']);

        // Just past the local-network threshold, still short of anything further out.
        const partial = await reach(36);
        expect(partial.range).toBeCloseTo(0.2592, 4);
        expect(partial.local).toBe(true);
        expect(partial.visible).toEqual(['home']);

        // Fully repaired: rated range covers all three starting contacts, and no more.
        const full = await reach(100);
        expect(full.range).toBeCloseTo(2, 5);
        expect(full.visible.sort()).toEqual(['home', 'location', 'signal']);
    });

    test('it stops reaching anything when the power runs out', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);

        const visible = await page.evaluate(() => {
            const g = window.game;
            g.systems.power.current = 0;
            g.systemUpdate.update(60);
            return g.commsNav.visibleLocations().length;
        });
        expect(visible).toBe(1);
    });

    test('Comms & Nav explains that the local network is out of range until it is repaired', async ({ page }) => {
        await startNewGame(page);
        await page.click('#comms-nav-btn');
        await expect(page.locator('.comms-location-card')).toHaveCount(1);
        await expect(page.locator('#comms-details-pane')).toContainText('Local network out of range');
        await expect(page.locator('.market-card')).toHaveCount(0);
    });
});

test.describe('market and water maker', () => {
    test('water makers are salvage priced 100-200 by condition, and the same seed gives the same stock', async ({ page }) => {
        await startNewGame(page);

        const { makers, again } = await page.evaluate(() => {
            const g = window.game;
            const makers = g.market.filter(l => l.moduleKey === 'waterMaker');
            g.commsNav.generate(g.commsSeed);
            return { makers, again: g.market.filter(l => l.moduleKey === 'waterMaker') };
        });

        expect(makers).toHaveLength(3);
        for (const m of makers) {
            expect(m.price).toBeGreaterThanOrEqual(100);
            expect(m.price).toBeLessThanOrEqual(200);
            expect(m.repairPct).toBeLessThan(50); // all pretty broken
        }
        const byCondition = [...makers].sort((a, b) => a.repairPct - b.repairPct);
        expect(byCondition.map(m => m.price)).toEqual([...byCondition.map(m => m.price)].sort((a, b) => a - b));
        expect(again).toEqual(makers);
    });

    test('buying a water maker fits it in its sold condition and charges the price', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);

        await expect(page.locator('#watermaker-missing')).toBeVisible();
        await page.click('#comms-nav-btn');
        await expect(page.locator('.market-card')).toHaveCount(7);

        const listing = await page.evaluate(() => window.game.market.find(l => l.moduleKey === 'waterMaker'));
        await page.click(`.market-buy-btn[data-listing-id="${listing.id}"]`);

        const state = await page.evaluate(() => ({
            credits: window.game.credits,
            maker: window.game.systems.waterMaker,
            stock: window.game.market.length,
        }));
        expect(state.credits).toBe(1000 - listing.price);
        expect(state.maker).toMatchObject({ installed: true, repairPct: listing.repairPct, active: false });
        expect(state.stock).toBe(6);

        // A second one can't be bought while the first is fitted and intact.
        await expect(page.locator('.market-card')).toHaveCount(6);
        await expect(page.locator('.market-buy-btn:not([disabled])')).toHaveCount(0);

        await page.click('#comms-nav-close-btn');
        await expect(page.locator('#watermaker-fitted')).toBeVisible();
        await expect(page.locator('#watermaker-repair-btn')).toBeVisible();
    });

    test('spare modules can only be bought to replace a destroyed one', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const spare = g.market.find(l => l.moduleKey === 'o2');
            const before = g.commsNav.purchaseBlocker(spare);
            g.systems.o2.destroyed = true;
            const after = g.commsNav.purchaseBlocker(spare);
            const bought = g.commsNav.purchase(spare.id);
            return { before, after, bought, o2: g.systems.o2, pct: spare.repairPct };
        });
        expect(result.before).toContain('Already fitted');
        expect(result.after).toBeNull();
        expect(result.bought).toBe(true);
        expect(result.o2).toMatchObject({ destroyed: false, repairPct: result.pct });
    });

    test('nothing can be bought without the local network in range, or without the credits', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const listing = g.market.find(l => l.moduleKey === 'waterMaker');
            const offline = g.commsNav.purchaseBlocker(listing);
            g.systems.transceiver.repairPct = 100; g.systems.transceiver.active = true;
            g.systemUpdate.update(1);
            g.credits = listing.price - 1;
            return { offline, broke: g.commsNav.purchaseBlocker(listing), bought: g.commsNav.purchase(listing.id) };
        });
        expect(result.offline).toContain('on the planet');
        expect(result.broke).toBe('Not enough credits');
        expect(result.bought).toBe(false);
    });

    test('a running water maker tops up fresh water, reclaiming black water first — and needs power', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const wm = g.systems.waterMaker, fresh = g.systems.freshWater, black = g.systems.blackWater;
            Object.assign(wm, { installed: true, repairPct: 100, active: true });
            g.systems.power.current = 800;
            black.liquidL = 20;
            const freshBefore = fresh.current;

            g.systemUpdate.update(3600); // one hour: uses 100/24 L, makes 6 L
            const powered = { out: wm.outputLhr, source: wm.source, gained: fresh.current - freshBefore,
                              blackLiquid: black.liquidL, draw: wm.drawW };

            g.systems.power.current = 0;
            g.systemUpdate.update(3600);
            return { powered, unpowered: wm.outputLhr };
        });

        expect(result.powered.out).toBeCloseTo(6, 5);
        expect(result.powered.source).toBe('blackWater');
        expect(result.powered.gained).toBeCloseTo(6 - 100 / 24, 5);
        // 20 L + this hour's 3.75 L of new liquid waste − 6 L reclaimed
        expect(result.powered.blackLiquid).toBeCloseTo(20 + (100 / 24) * 0.9 - 6, 5);
        expect(result.powered.draw).toBeCloseTo(30, 5);
        expect(result.unpowered).toBe(0);
    });

    test('new modules, market stock and black-water exposure survive save and reload', async ({ page }) => {
        const name = await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);

        const before = await page.evaluate(async () => {
            const g = window.game;
            g.commsNav.purchase(g.market.find(l => l.moduleKey === 'waterMaker').id);
            g.systems.blackWater.exposureHours = 1.5;
            await g.saveGame();
            const { active, repairPct, installed } = g.systems.transceiver;
            return {
                transceiver: { active, repairPct, installed },
                maker: { installed: g.systems.waterMaker.installed, repairPct: g.systems.waterMaker.repairPct },
                market: g.market, credits: g.credits, exposure: g.systems.blackWater.exposureHours,
            };
        });

        page.once('dialog', d => d.accept());
        await page.keyboard.press('Escape');
        await page.click('#main-menu-btn');
        await page.click('#load-game-btn');
        await page.locator('.save-card').filter({ hasText: name }).locator('.save-load-btn').click();
        await page.waitForSelector('#game-container', { state: 'visible' });
        await freeze(page);

        const after = await page.evaluate(() => {
            const g = window.game;
            const { active, repairPct, installed } = g.systems.transceiver;
            return {
                transceiver: { active, repairPct, installed },
                maker: { installed: g.systems.waterMaker.installed, repairPct: g.systems.waterMaker.repairPct },
                market: g.market, credits: g.credits, exposure: g.systems.blackWater.exposureHours,
            };
        });
        expect(after).toEqual(before);
    });
});

test.describe('shift fatigue', () => {
    // Runs CrewManager for `days` of game time on a single shift of `hours`, in
    // 1000-second steps (the largest tick the game ever takes).
    const work = (page, hours, days) => page.evaluate(({ hours, days }) => {
        const g = window.game;
        const me = g.crewManifest[0];
        me.health = 100; me.dead = false; me.varianceFactor = 1;
        me.shifts = [{ startHour: 0, endHour: hours }];
        for (let t = 0; t < days * 86400; t += 1000) g.crewManager.update(1000);
        return { health: me.health, dead: me.dead, cap: g.crewManager.fatigueHealthCap(me), slow: g.crewManager.fatigueWorkFactor(me) };
    }, { hours, days });

    test('8 hours is free, 12 only slows work, and longer days cost health faster than linearly', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        expect(await work(page, 8, 10)).toMatchObject({ health: 100, dead: false, slow: 1 });

        const twelve = await work(page, 12, 10);
        expect(twelve.health).toBe(100);
        expect(twelve.slow).toBeCloseTo(1.2, 5);

        const sixteen = await work(page, 16, 10);
        const twenty  = await work(page, 20, 10);
        expect(sixteen.health).toBeCloseTo(sixteen.cap, 3);
        expect(sixteen.health).toBeGreaterThan(75);
        // Sustainable — but at a heavy cost: settles deep in the "critical" band.
        expect(twenty.dead).toBe(false);
        expect(twenty.health).toBeCloseTo(twenty.cap, 3);
        expect(twenty.health).toBeGreaterThan(40);
        expect(twenty.health).toBeLessThan(50);
        // Each extra hour costs more than the last.
        expect(sixteen.health - twenty.health).toBeGreaterThan(100 - sixteen.health);
    });

    test('working around the clock kills in a few days', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        expect((await work(page, 24, 2)).dead).toBe(false);
        expect((await work(page, 24, 3.1)).dead).toBe(true);
    });

    test('overlapping shifts are only counted once, and the crew screen flags long hours', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const hours = await page.evaluate(() => {
            const g = window.game;
            g.crewManifest[0].shifts = [{ startHour: 0, endHour: 10 }, { startHour: 6, endHour: 14 }];
            return g.crewManager.dutyHours(g.crewManifest[0]);
        });
        expect(hours).toBe(14);

        await page.click('#crew-stat');
        await expect(page.locator('.crew-duty')).toContainText('On duty 14h/day');
        await expect(page.locator('.crew-duty')).toContainText('overworked');
    });
});

test.describe('idle crew on a long roster', () => {
    // Midday, on shift. `hours` is the length of the single shift starting at 08:00.
    const setRoster = (page, hours, queueRepair) => page.evaluate(({ hours, queueRepair }) => {
        const g = window.game;
        g.gameTime = 12 * 3600;
        g.crewManifest[0].shifts = [{ startHour: 8, endHour: 8 + hours }];
        g.repairQueue = [];
        if (queueRepair) g.repairManager.startRepair('power');
        g.updateDisplay();
    }, { hours, queueRepair });

    test('speaks up only when rostered over 8 hours, on shift, with nothing to do', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const note = page.locator('#crew-idle-note');

        await setRoster(page, 8, false);  // idle, but a normal day
        await expect(note).toBeHidden();

        await setRoster(page, 12, true);  // long day, but busy
        await expect(note).toBeHidden();

        await setRoster(page, 12, false); // long day and idle
        await expect(note).toBeVisible();
        await expect(page.locator('#crew-idle-text')).toContainText('Crew 1');
        await expect(page.locator('#crew-idle-text')).toContainText('rostered 12 hours a day');

        // Off shift there is nobody to complain.
        await page.evaluate(() => { window.game.gameTime = 2 * 3600; window.game.updateDisplay(); });
        await expect(note).toBeHidden();
    });

    test('can be dismissed, comes back after the situation has cleared, and opens the crew screen', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const note = page.locator('#crew-idle-note');

        await setRoster(page, 12, false);
        await page.click('#crew-idle-dismiss');
        await expect(note).toBeHidden();
        await page.evaluate(() => window.game.updateDisplay());
        await expect(note).toBeHidden(); // stays dismissed while nothing has changed

        await setRoster(page, 12, true);  // given work…
        await setRoster(page, 12, false); // …which then runs out
        await expect(note).toBeVisible();

        await page.click('#crew-idle-text');
        await expect(page.locator('#crew-screen')).toBeVisible();
    });
});

test.describe('black water', () => {
    test('a full tank hurts the crew immediately, and harder the longer it is left', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const black = g.systems.blackWater;
            const me = g.crewManifest[0];
            me.varianceFactor = 1;
            Math.random = () => 0.999; // no infection rolls — isolate the steady drain

            black.liquidL = 100; black.solidL = 0;
            g.systemUpdate.update(60);
            const first = { exposure: black.exposureHours, health: me.health,
                            rate: g.crewManager.healthImpactBreakdown().find(i => i.label.startsWith('Sewage')).ratePctPerHr };

            for (let i = 0; i < 6; i++) g.systemUpdate.update(3600);
            const later = g.crewManager.healthImpactBreakdown().find(i => i.label.startsWith('Sewage')).ratePctPerHr;
            return { first, later };
        });

        expect(result.first.exposure).toBeGreaterThan(0);
        expect(result.first.health).toBeLessThan(100);
        expect(result.first.rate).toBeGreaterThanOrEqual(1);
        expect(result.later).toBeGreaterThan(result.first.rate + 2);
    });

    test('infection becomes more likely with exposure and lands as a lump of damage', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const me = g.crewManifest[0];
            me.varianceFactor = 1;
            g.systems.blackWater.exposureHours = 1;
            const early = g.crewManager.infectionChancePerHr();
            g.systems.blackWater.exposureHours = 8;
            const late = g.crewManager.infectionChancePerHr();

            Math.random = () => 0; // the roll always hits
            me.health = 100;
            g.crewManager.update(1);
            return { early, late, health: me.health };
        });

        expect(result.late).toBeGreaterThan(result.early);
        expect(result.health).toBeLessThan(86);
    });

    test('dumping relieves the tank and is fined 100 credits every time', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await page.evaluate(() => {
            const g = window.game;
            g.systems.blackWater.liquidL = 100;
            g.systemUpdate.update(3600);
            g.updateDisplay();
        });
        await expect(page.locator('#blackwater-exposure')).toContainText('crew exposed');

        let message = '';
        page.once('dialog', d => { message = d.message(); d.accept('50'); });
        await page.click('#blackwater-dump-btn');
        expect(message).toContain('fined 100 credits');

        page.once('dialog', d => d.accept('100'));
        await page.click('#blackwater-dump-btn');

        const state = await page.evaluate(() => ({
            credits: window.game.credits,
            level: window.game.systems.blackWater.level,
            exposure: window.game.systems.blackWater.exposureHours,
        }));
        expect(state).toEqual({ credits: 800, level: 0, exposure: 0 });
        await expect(page.locator('#blackwater-exposure-row')).toBeHidden();
    });
});
