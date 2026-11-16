// E2E coverage for sound.js. Audio output itself can't be asserted, so these
// check the decisions: which sound is requested for which action or state
// change (SoundManager.log), and how loud the hum is asked to be (humLevels()).
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

const log      = page => page.evaluate(() => window.sound.log.slice());
const clearLog = page => page.evaluate(() => { window.sound.log.length = 0; });
// One state comparison, on demand, instead of waiting for the 400 ms poll.
const poll     = page => page.evaluate(() => window.sound._poll());
const freeze   = page => page.evaluate(() => window.game._stopTimer());

test.describe('sound effects', () => {
    test('an audio context starts on the first click, and no page errors come from it', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(String(err)));
        await startNewGame(page);

        const state = await page.evaluate(() => ({ hasCtx: !!window.sound.ctx, hum: !!window.sound.humGenerator }));
        expect(state).toEqual({ hasCtx: true, hum: true });
        expect(errors).toEqual([]);
    });

    test('buttons click; switches, closing and Comms & Nav each have their own sound', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await clearLog(page);

        await page.click('#speed-10x');
        await page.click('#o2-toggle');   // off → on
        await page.click('#o2-toggle');   // on → off
        await page.click('#comms-nav-btn');
        await page.click('#comms-nav-close-btn');

        expect(await log(page)).toEqual(['click', 'switchOn', 'switchOff', 'comms', 'close']);
    });

    test('the hum follows the generator and gets louder with each other running system', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const levels = await page.evaluate(() => {
            const g = window.game, s = g.systems, out = [];
            const read = () => out.push(window.sound.humLevels());
            read();                                   // everything off
            s.power.active = true;       read();      // generator only
            s.o2.active = true;          read();      // + O2 generator
            s.co2.active = true;         read();      // + CO2 scrubber
            s.power.powerFraction = 0;   read();      // no power: those systems fall silent
            s.fuel.current = 0;          read();      // no fuel: generator stops too
            s.fuel.current = 10; s.power.powerFraction = 1; g.gamePaused = true; read(); // paused: silence
            g.gamePaused = false;
            return out;
        });

        expect(levels[0]).toEqual({ generator: 0, systems: 0 });
        expect(levels[1].generator).toBeGreaterThan(0);
        expect(levels[1].systems).toBe(0);
        expect(levels[2].systems).toBeGreaterThan(0);
        expect(levels[3].systems).toBeGreaterThan(levels[2].systems);
        expect(levels[4].systems).toBe(0);
        expect(levels[5]).toEqual({ generator: 0, systems: 0 });
        expect(levels[6]).toEqual({ generator: 0, systems: 0 });
    });

    test('a status getting worse chimes once — softer for a warning — and not on arrival', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await poll(page);            // first look at the new game: sets the baseline
        await clearLog(page);

        // A new ship already has several warnings; none of them sounded.
        await poll(page);
        expect(await log(page)).toEqual([]);

        await page.evaluate(() => { window.game.systems.o2.status = 'Warning'; });
        await poll(page);
        expect(await log(page)).toEqual(['warning']);

        // Straight on to critical within the rate limit: held back rather than stacked up.
        await page.evaluate(() => { window.game.systems.o2.status = 'Critical'; });
        await poll(page);
        expect(await log(page)).toEqual(['warning']);

        await page.evaluate(() => { window.sound._lastAlertAt = 0; window.game.systems.co2.status = 'Critical'; });
        await poll(page);
        expect(await log(page)).toEqual(['warning', 'critical']);

        // Recovering is silent.
        await page.evaluate(() => { window.sound._lastAlertAt = 0; window.game.systems.o2.status = 'Normal'; });
        await poll(page);
        expect(await log(page)).toEqual(['warning', 'critical']);
    });

    test('repairs finishing, a module destroyed, vents, a purchase and a dump are all heard', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await poll(page);
        await clearLog(page);

        const step = async change => { await page.evaluate(change); await poll(page); };

        await step(() => { window.game.systems.power.repairPct = 100; });
        await step(() => { window.game.systems.co2.destroyed = true; });
        await step(() => { window.game.ventsOpen = true; });
        await step(() => { window.game.ventsOpen = false; });
        await step(() => {
            const g = window.game;
            g.systems.transceiver.repairPct = 100; g.systems.transceiver.active = true;
            g.systemUpdate.update(1);
            window.sound._prev = window.sound._snapshot(); // re-baseline: the setup above isn't the event under test
            g.commsNav.purchase(g.market.find(l => l.moduleKey === 'waterMaker').id);
        });
        await step(() => {
            const g = window.game;
            g.systems.blackWater.liquidL = 40; g.systems.blackWater.current = 40;
            window.sound._prev = window.sound._snapshot();
            g.systems.blackWater.liquidL = 0; g.systems.blackWater.current = 0; g.credits -= 100;
        });

        expect(await log(page)).toEqual(['repaired', 'destroyed', 'ventOpen', 'ventClose', 'purchase', 'flush', 'fine']);
    });

    test('the Sound pill mutes everything and remembers the choice', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await expect(page.locator('#sound-toggle')).toHaveText('Sound: On');
        await page.click('#sound-toggle');
        await expect(page.locator('#sound-toggle')).toHaveText('Sound: Off');
        await clearLog(page);

        await page.click('#speed-10x');
        await page.click('#o2-toggle');
        expect(await log(page)).toEqual([]);
        expect(await page.evaluate(() => localStorage.getItem('starshipOps.soundOff'))).toBe('1');

        await page.reload();
        await expect(page.locator('#sound-toggle')).toHaveText('Sound: Off');
        expect(await page.evaluate(() => window.sound.enabled)).toBe(false);
    });
});
