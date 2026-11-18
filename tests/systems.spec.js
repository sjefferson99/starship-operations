// E2E coverage for: the power budget (nothing electrical runs without power),
// the transceiver and what its range reveals, the local market and water
// maker, shift fatigue, and black-water overflow / dump fines. Like the other
// specs, drives real game logic through window.game rather than re-implementing it.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline, atPort } = require('./helpers.js');

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
        expect(worn.range).toBeCloseTo(0.15, 5);
        expect(worn.local).toBe(false);
        expect(worn.visible).toEqual(['home']);

        // Just past the local-network threshold (0.25 ly), still short of anything further out (0.3 ly minimum).
        const partial = await reach(36);
        expect(partial.range).toBeCloseTo(0.26, 5);
        expect(partial.local).toBe(true);
        expect(partial.visible).toEqual(['home']);

        // One repair stage up (50%): the local network for certain, and only contacts that really are that close.
        const half = await reach(50);
        expect(half.range).toBeCloseTo(0.4, 5);
        expect(half.local).toBe(true);

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
        await expect(page.locator('.market-card[data-listing-id]')).toHaveCount(0);
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

    test('buying a water maker at the port fits it in its sold condition and charges the price', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await atPort(page);

        await expect(page.locator('#watermaker-missing')).toBeVisible();
        await page.click('#comms-nav-btn');
        await expect(page.locator('.market-card[data-listing-id]')).toHaveCount(7);

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
        await expect(page.locator('.market-card[data-listing-id]')).toHaveCount(6);
        await expect(page.locator('.market-buy-btn:not([disabled])')).toHaveCount(0);

        await page.click('#comms-nav-close-btn');
        await expect(page.locator('#watermaker-fitted')).toBeVisible();
        await expect(page.locator('#watermaker-repair-btn')).toBeVisible();
    });

    test('the market list keeps its scroll position while the game ticks, and across a purchase', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await atPort(page);
        await page.click('#comms-nav-btn');

        const services = page.locator('.comms-details-services');
        await services.evaluate(el => { el.scrollTop = 120; });
        await page.waitForTimeout(2200); // two real game ticks, each refreshing the open screen
        expect(await services.evaluate(el => el.scrollTop)).toBe(120);

        // Buying changes the list (and the credits line) — a real re-render, scroll still kept.
        // (Bought through the game rather than by clicking, since clicking the top row would itself scroll the list.)
        await page.evaluate(() => window.game.buyMarketItem(window.game.market.find(l => l.moduleKey === 'waterMaker').id));
        await expect(page.locator('.market-card[data-listing-id]')).toHaveCount(6);
        expect(await services.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    });

    test('spare modules can only be bought to replace a destroyed one', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await bringCommsOnline(page);
        await atPort(page);

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
        expect(result.offline).toContain('out of range');
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
            g.updateDisplay();
            const powered = { out: wm.outputLhr, source: wm.source, gained: fresh.current - freshBefore,
                              blackLiquid: black.liquidL, residue: black.residueL, draw: wm.drawW, fill: black.fillRateLhr,
                              split: document.getElementById('watermaker-split-black-pct').textContent,
                              shown: document.getElementById('blackwater-rate').textContent,
                              reclaimShown: document.getElementById('blackwater-reclaim').textContent };

            g.systems.power.current = 0;
            g.systemUpdate.update(3600);
            return { powered, unpowered: wm.outputLhr };
        });

        expect(result.powered.out).toBeCloseTo(6, 5);
        expect(result.powered.source).toBe('blackWater');
        expect(result.powered.gained).toBeCloseTo(6 - 100 / 24, 5);
        expect(result.powered.split).toBe('100%');
        // Every litre of free liquid it processes comes back: 20 L + this hour's 4.167 L of use
        // (all of it, with the vents closed) − 6 L. With no solids, none of the liquid is held back.
        expect(result.powered.blackLiquid).toBeCloseTo(20 + 100 / 24 - 6, 5);
        expect(result.powered.residue).toBeCloseTo(0, 5);
        expect(result.powered.draw).toBeCloseTo(30, 5);
        // The dashboard's fill rate is net of reclamation: 4.167 L/hr of liquid waste plus the
        // solids from three rations a day (1.5 L each), − the 6 L/hr that left as fresh water.
        expect(result.powered.fill).toBeCloseTo(100 / 24 + 4.5 / 24 - 6, 5);
        expect(result.powered.shown).toBe(`−${(-result.powered.fill).toFixed(3)} L/hr`);
        expect(result.powered.reclaimShown).toBe('−6.000 L/hr');
        expect(result.unpowered).toBe(0);
    });

    test('with no liquid waste left it condenses from air at lower power, and the tank says only solids remain', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const result = await page.evaluate(() => {
            const g = window.game;
            const wm = g.systems.waterMaker, black = g.systems.blackWater;
            Object.assign(wm, { installed: true, repairPct: 100, active: true });
            g.systems.power.current = 800;
            black.liquidL = 0; black.solidL = 10;

            g.systemUpdate.update(3600);
            g.updateDisplay();
            return {
                out: wm.outputLhr, source: wm.source, draw: wm.drawW,
                liquid: black.liquidL, solid: black.solidL, reclaim: black.reclaimRateLhr, residue: black.residueL,
                blackPct: document.getElementById('watermaker-split-black-pct').textContent,
                airPct: document.getElementById('watermaker-split-air-pct').textContent,
            };
        });

        // Still makes its full 6 L/hr. Of this hour's 4.167 L of liquid waste, 2 L soaks into
        // the 10 L of solids (20% of their volume) and can't be drawn out; the free 2.167 L is
        // all reclaimed, and the air makes up the rest.
        expect(result.out).toBeCloseTo(6, 5);
        expect(result.reclaim).toBeCloseTo(100 / 24 - 2, 5);
        expect(result.residue).toBeCloseTo(2, 5);
        expect(result.liquid).toBeCloseTo(0, 5);
        expect(result.solid).toBeCloseTo(10, 5); // untouched (and no meal fell in this hour)
        expect([result.blackPct, result.airPct]).toEqual(['36%', '64%']);
        // Reclaimed share at full power, condensed share at 40%: (2.167 + 3.833 × 0.4) / 6 × 30 W.
        expect(result.draw).toBeCloseTo(((100 / 24 - 2) + (6 - (100 / 24 - 2)) * 0.4) / 6 * 30, 5);

        const note = page.locator('#blackwater-solids-note');
        await expect(note).toBeVisible();
        await expect(note).toContainText('All the free liquid has been reclaimed');
        await expect(note).toContainText('12.0 L is solid matter and the liquid soaked into it');

        // Moving the solids out frees the liquid they held, ready to be reclaimed.
        const freed = await page.evaluate(() => {
            const g = window.game, b = g.systems.blackWater;
            b.solidL = 0; g.syncBlackWaterLevel();
            return { liquid: b.liquidL, residue: b.residueL, current: b.current };
        });
        expect(freed.liquid).toBeCloseTo(2, 5);
        expect(freed.residue).toBe(0);
        expect(freed.current).toBeCloseTo(2, 5);

        // Nothing but air to work with (no crew use, no liquid): the whole output is the cheap kind.
        const airOnly = await page.evaluate(() => {
            const g = window.game;
            g.crew = 0; g.crewManifest.forEach(m => { m.dead = true; });
            g.systems.blackWater.liquidL = 0;
            g.systemUpdate._computePowerBudget(3600);
            g.systemUpdate._updateWater(3600);
            g.systemUpdate._updatePowerAndFuel(3600);
            return { source: g.systems.waterMaker.source, draw: g.systems.waterMaker.drawW };
        });
        expect(airOnly.source).toBe('atmosphere');
        expect(airOnly.draw).toBeCloseTo(12, 5);
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

test.describe('coming off water rationing', () => {
    test('is free within the first day; after that it needs 50 L in the tank, and the card says so', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const btn = page.locator('#water-ration-toggle');
        await page.click('#vent-toggle'); // or 30 sealed hours of CO₂ would end the game first

        await expect(page.locator('#freshwater-preview')).toBeHidden(); // only shown while rationing
        await expect(page.locator('#freshwater-preview-use')).toBeVisible(); // the full-rate figure is always there
        await expect(page.locator('#freshwater-preview-use')).toHaveText('−4.167 L/hr');
        await btn.click();
        await page.evaluate(() => { window.game.systemUpdate.update(2 * 3600); window.game.updateDisplay(); });
        await expect(page.locator('#freshwater-reset-row')).toBeHidden();

        // No water maker yet: full use against nothing coming in.
        await expect(page.locator('#freshwater-preview-use')).toHaveText('−4.167 L/hr');
        await expect(page.locator('#freshwater-preview-maker')).toHaveText('none fitted');
        await expect(page.locator('#freshwater-preview-net')).toHaveText('−4.167 L/hr');
        await expect(page.locator('#freshwater-preview-verdict')).toContainText('Not sustainable — the tank would run dry in 11h 30m');
        await btn.click(); // off again, no charge
        expect(await page.evaluate(() => window.game.systems.freshWater.rationing)).toBe(false);

        // A day and a bit on rations: 50 L start − 2h normal − 30h rationed leaves too little to rehydrate.
        await btn.click();
        await page.evaluate(() => { const g = window.game; for (let i = 0; i < 30; i++) g.systemUpdate.update(3600); g.updateDisplay(); });
        await expect(btn).toBeDisabled();
        await expect(page.locator('#freshwater-reset')).toContainText('needs 50 L in the tank');
        await expect(page.locator('#freshwater-reset')).toContainText('L short');
        expect(await btn.evaluate(el => getComputedStyle(el).cursor)).toBe('not-allowed'); // visibly unavailable

        // Tank topped up past the cost — but the black water tank has no room for it once used.
        const before = await page.evaluate(() => {
            const g = window.game, b = g.systems.blackWater;
            g.systems.freshWater.current = 120;
            b.liquidL = 90; b.solidL = 0; b.residueL = 0; g.syncBlackWaterLevel();
            g.updateDisplay();
            return 120;
        });
        await expect(btn).toBeDisabled();
        // Vents open: 90% of the 50 L ends up as black water.
        await expect(page.locator('#freshwater-reset')).toContainText('needs 45 L free in the black water tank');
        // Room made: available again, and using it draws the 50 L.
        await page.evaluate(() => { const g = window.game, b = g.systems.blackWater; b.liquidL = 10; g.syncBlackWaterLevel(); g.updateDisplay(); });
        await expect(btn).toBeEnabled();
        await expect(page.locator('#freshwater-reset')).toHaveText('uses 50 L to rehydrate');
        // The run-dry estimate counts what's left after that 50 L draw: 70 L at 4.167 L/hr.
        await expect(page.locator('#freshwater-preview-verdict')).toContainText('run dry in 16h 48m');

        // With a working, powered water maker the same preview shows it is sustainable.
        await page.evaluate(() => {
            const g = window.game;
            Object.assign(g.systems.waterMaker, { installed: true, repairPct: 100, active: true });
            g.systems.power.current = 800;
            g.systemUpdate.update(60);
            g.updateDisplay();
        });
        await expect(page.locator('#freshwater-preview-maker')).toHaveText('+6.000 L/hr');
        await expect(page.locator('#freshwater-preview-net')).toHaveText('+1.833 L/hr');
        await expect(page.locator('#freshwater-preview-verdict')).toContainText('Sustainable');
        const blackBefore = await page.evaluate(() => window.game.systems.blackWater.current);
        await btn.click();
        const after = await page.evaluate(() => ({ rationing: window.game.systems.freshWater.rationing, current: window.game.systems.freshWater.current,
                                                   black: window.game.systems.blackWater.current }));
        expect(after.rationing).toBe(false);
        expect(after.black).toBeCloseTo(blackBefore + 45, 5);
        expect(after.current).toBeCloseTo(before - 50 + 60 * (6 - 25 / 24) / 3600, 4); // the 50 L draw, plus that one minute of making vs rationed use
        await expect(page.locator('#freshwater-preview')).toBeHidden();
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

        // A few hours more than the 3 days at the full rate, while the body adjusts to the new roster.
        expect((await work(page, 24, 2)).dead).toBe(false);
        expect((await work(page, 24, 3.5)).dead).toBe(true);
    });

    test('a roster change settles in over about a day, so flipping shifts back and forth gains little', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const r = await page.evaluate(() => {
            const g = window.game, cm = g.crewManager, me = g.crewManifest[0];
            me.varianceFactor = 1;
            const run = hours => { for (let t = 0; t < hours * 3600; t += 1000) cm.update(Math.min(1000, hours * 3600 - t)); };

            // Settled on 20h/day, worn down to that roster's ceiling.
            me.shifts = [{ startHour: 0, endHour: 20 }]; me.restedDutyHours = 20; me.health = cm.fatigueHealthCap(me);
            const worn = me.health;

            // Back to 8h: nothing changes at once ...
            me.shifts = [{ startHour: 8, endHour: 16 }];
            const capAtOnce = cm.fatigueHealthCap(me);
            const summary = cm.dutySummary(me).text;
            run(1);
            const afterHour = me.health;
            run(23);
            const afterDay = { health: me.health, rested: me.restedDutyHours };

            // ... and an hour on a gentle roster in the middle of a long one buys back very little.
            me.shifts = [{ startHour: 0, endHour: 20 }]; me.restedDutyHours = 20; me.health = worn;
            run(2);
            me.shifts = [{ startHour: 8, endHour: 16 }];
            run(1);
            me.shifts = [{ startHour: 0, endHour: 20 }];
            const flipped = me.health;

            return { worn, capAtOnce, summary, afterHour, afterDay, flipped };
        });

        expect(r.capAtOnce).toBeCloseTo(r.worn, 5);
        expect(r.summary).toContain('still adjusting from 20h');
        expect(r.afterHour - r.worn).toBeLessThan(5);
        expect(r.afterDay.rested).toBeLessThan(8.5);
        expect(r.afterDay.health).toBeGreaterThan(90);
        // At most an hour's slow recovery (100%/day) — not the old 15%/hr rebound.
        expect(r.flipped - r.worn).toBeLessThan(5);
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
            g.rng.next = () => 0.999; // no infection rolls — isolate the steady drain

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

            g.rng.next = () => 0; // the roll always hits
            me.health = 100;
            g.crewManager.update(1);
            return { early, late, health: me.health };
        });

        expect(result.late).toBeGreaterThan(result.early);
        expect(result.health).toBeLessThan(86);
    });

    test('an overflow spills into the cabin and stays until cleaned up, which takes fresh water and tank room', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        // A full tank and an hour's use (vents closed: all 4.167 L of it goes to black water).
        const spilled = await page.evaluate(() => {
            const g = window.game, b = g.systems.blackWater;
            b.liquidL = 60; b.solidL = 30; b.residueL = 10;
            g.systemUpdate.update(3600);
            g.updateDisplay();
            return { spill: g.systemUpdate.spilledL(), current: b.current, exposure: b.exposureHours, fresh: g.systems.freshWater.current };
        });
        expect(spilled.spill).toBeCloseTo(100 / 24, 5);
        expect(spilled.current).toBeCloseTo(100, 5);
        expect(spilled.exposure).toBeGreaterThan(0);
        await expect(page.locator('#blackwater-exposure')).toContainText('crew exposed');
        await expect(page.locator('#blackwater-exposure')).toContainText('Cleaning up uses 2.1 L of fresh water and needs 6.3 L free in the tank');

        // No room in the tank to put it back.
        const clean = page.locator('#blackwater-cleanup-btn');
        await expect(clean).toBeVisible();
        await expect(clean).toBeDisabled();
        await expect(clean).toHaveAttribute('title', /tank is full/);

        // A dump empties the tank, but the spill is still on the floor.
        await page.click('#blackwater-dump-btn');
        await expect(page.locator('#blackwater-exposure-row')).toBeVisible();
        await expect(clean).toBeEnabled();
        await clean.click();
        const after = await page.evaluate(() => {
            const g = window.game, b = g.systems.blackWater;
            g.systemUpdate.update(1);
            return { spill: g.systemUpdate.spilledL(), liquid: b.liquidL, exposure: b.exposureHours, fresh: g.systems.freshWater.current };
        });
        expect(after.spill).toBe(0);
        // The spill and the half as much again of fresh water used to clean it are in the tank.
        expect(after.liquid).toBeCloseTo((100 / 24) * 1.5 + 1 / 3600 * 100 / 24, 4);
        expect(after.fresh).toBeCloseTo(spilled.fresh - (100 / 24) * 0.5 - 1 / 3600 * 100 / 24, 4);
        expect(after.exposure).toBe(0);
        await page.evaluate(() => window.game.updateDisplay());
        await expect(page.locator('#blackwater-exposure-row')).toBeHidden();
        await expect(clean).toBeHidden();
    });

    test('dumping empties the whole tank without asking, and is fined 100 credits every time', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await page.evaluate(() => {
            const g = window.game;
            g.systems.blackWater.liquidL  = 60;
            g.systems.blackWater.solidL   = 30;
            g.systems.blackWater.residueL = 10;
            g.syncBlackWaterLevel();
            g.updateDisplay();
        });

        let asked = false;
        page.on('dialog', d => { asked = true; d.dismiss(); });
        await page.click('#blackwater-dump-btn');
        expect(asked).toBe(false);
        expect(await page.evaluate(() => {
            const b = window.game.systems.blackWater;
            return [b.liquidL, b.solidL, b.residueL, b.level];
        })).toEqual([0, 0, 0, 0]);

        await page.evaluate(() => { window.game.systems.blackWater.liquidL = 20; window.game.syncBlackWaterLevel(); window.game.updateDisplay(); });
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
