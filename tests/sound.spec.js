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

    test('the Sounds panel turns everything off and remembers the choice', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await expect(page.locator('#sound-toggle')).toHaveText('Sounds');
        await page.click('#sound-toggle');
        await expect(page.locator('#sound-screen')).toBeVisible();
        await page.click('#sound-enabled-toggle');
        await expect(page.locator('#sound-enabled-status')).toHaveText('Sounds: OFF');
        await expect(page.locator('#sound-level-ui')).toBeDisabled();
        await page.click('#sound-screen-close-btn');
        await expect(page.locator('#sound-toggle')).toHaveText('Sounds: Off');
        await clearLog(page);

        await page.click('#speed-10x');
        await page.click('#o2-toggle');
        expect(await log(page)).toEqual([]);

        await page.reload();
        await expect(page.locator('#sound-toggle')).toHaveText('Sounds: Off');
        expect(await page.evaluate(() => window.sound.enabled)).toBe(false);
    });

    test('each channel has its own level, with headroom above the default, and the levels persist', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.click('#sound-toggle');

        // Overall volume plus the four channels, all starting at their defaults.
        await expect(page.locator('.sound-row')).toHaveCount(5);
        await expect(page.locator('.sound-row-name')).toHaveText(['Overall volume', 'Buttons', 'Effects', 'Alerts', 'Systems hum']);
        await expect(page.locator('#sound-value-master')).toHaveText('50%');
        for (const key of ['ui', 'effect', 'alert', 'hum']) await expect(page.locator(`#sound-value-${key}`)).toHaveText('40%');

        const gains = () => page.evaluate(() => ({
            ui: window.sound.channelGain('ui'), effect: window.sound.channelGain('effect'),
            alert: window.sound.channelGain('alert'), hum: window.sound.channelGain('hum'),
        }));
        const before = await gains();

        // Hum up to maximum, alerts off; the others are untouched — they really are separate.
        await page.locator('#sound-level-hum').fill('100');
        await page.locator('#sound-level-alert').fill('0');
        await expect(page.locator('#sound-value-hum')).toHaveText('100%');
        const after = await gains();
        expect(after.hum).toBeCloseTo(before.hum * 2.5, 5);
        expect(after.alert).toBe(0);
        expect(after.ui).toBe(before.ui);
        expect(after.effect).toBe(before.effect);

        // Which channel each sound belongs to.
        expect(await page.evaluate(() => ['click', 'switchOn', 'comms', 'ventOpen', 'repaired', 'warning', 'critical'].map(n => window.sound.channelOf(n))))
            .toEqual(['ui', 'ui', 'effect', 'effect', 'effect', 'alert', 'alert']);

        // Test buttons play a sample of their own channel (and not a button click on top).
        await clearLog(page);
        await page.click('.sound-test-btn[data-channel="effect"]');
        await page.click('.sound-test-btn[data-channel="ui"]');
        expect(await log(page)).toEqual(['comms', 'click']);

        await page.reload();
        expect(await page.evaluate(() => ({ hum: window.sound.settings.hum, alert: window.sound.settings.alert, ui: window.sound.settings.ui })))
            .toEqual({ hum: 1, alert: 0, ui: 0.4 });

        // Reset puts everything back.
        await page.evaluate(() => window.sound.resetSettings());
        expect(await page.evaluate(() => window.sound.settings)).toEqual({ enabled: true, master: 0.5, ui: 0.4, effect: 0.4, alert: 0.4, hum: 0.4 });
    });

    test('an older on/off-only preference is still honoured', async ({ page }) => {
        await page.addInitScript(() => {
            if (!localStorage.getItem('starshipOps.soundSettings.v2')) localStorage.setItem('starshipOps.soundOff', '1');
        });
        await page.goto('/');
        expect(await page.evaluate(() => window.sound.enabled)).toBe(false);
    });

    test('levels saved by the first version of the panel are dropped, keeping only on/off', async ({ page }) => {
        await page.addInitScript(() => {
            if (!localStorage.getItem('starshipOps.soundSettings.v2')) {
                localStorage.setItem('starshipOps.soundSettings', JSON.stringify({ enabled: false, master: 1, ui: 0.2, effect: 0.4, alert: 0.6, hum: 0.2 }));
            }
        });
        await page.goto('/');
        expect(await page.evaluate(() => window.sound.settings)).toEqual({ enabled: false, master: 0.5, ui: 0.4, effect: 0.4, alert: 0.4, hum: 0.4 });
    });

    test('the default mix is the tuned one', async ({ page }) => {
        await page.goto('/');
        const mix = await page.evaluate(() => {
            const s = window.sound;
            return { master: s._masterGain(), ui: s.channelGain('ui'), effect: s.channelGain('effect'), alert: s.channelGain('alert'), hum: s.channelGain('hum') };
        });
        const expected = { master: 1, ui: 1.6, effect: 2.8, alert: 3.6, hum: 0.5 };
        Object.keys(expected).forEach(key => expect(mix[key]).toBeCloseTo(expected[key], 6));
    });
});
