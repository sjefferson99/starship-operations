// Guided tutorial + contextual tips, sharing one spotlight card.
//
// The TOUR runs on a player's first New Game (replayable from the header's
// "Tour" button). Each step spotlights a real dashboard element and either
// waits for the player to actually perform the action (`done`) or offers a
// plain Next button. It covers what can be done in the first minute.
//
// TIPS cover everything that only becomes relevant later (a repair finishing
// hours on, the tank filling, a module wearing out). Each fires once per save,
// the first time its `when` condition is true, checked once per game tick.
//
// Neither ever changes gameplay state beyond opening/closing overlay screens —
// every change is the player's own click on the real control, so there is no
// separate "tutorial mode" to drift out of sync with the game.

class Tour {
    constructor(game) {
        this.game   = game;
        this.active = false;  // the linear tour is running
        this.tip    = null;   // the contextual tip currently on screen, if any
        this.index  = 0;
        this._poll  = null;
        this._scrolledForStep = false;
        this._actionStep      = false;

        this.SEEN_KEY     = 'starshipOps.tourSeen';
        this.TIPS_OFF_KEY = 'starshipOps.tipsOff';
        this.TIPS_SEEN_PREFIX = 'starshipOps.tipsSeen.'; // + save id

        this.layerEl     = document.getElementById('tour-layer');
        this.spotlightEl = document.getElementById('tour-spotlight');
        this.cardEl      = document.getElementById('tour-card');
        this.countEl     = document.getElementById('tour-step-count');
        this.titleEl     = document.getElementById('tour-title');
        this.bodyEl      = document.getElementById('tour-body');
        this.hintEl      = document.getElementById('tour-hint');
        this.nextBtn     = document.getElementById('tour-next-btn');
        this.skipStepBtn = document.getElementById('tour-skip-step-btn');
        this.skipBtn     = document.getElementById('tour-skip-btn');

        this.nextBtn.addEventListener('click',     () => (this.tip ? this._dismissTip() : this.next()));
        this.skipStepBtn.addEventListener('click', () => this.next());
        this.skipBtn.addEventListener('click',     () => {
            if (this.tip) { this.setTipsEnabled(false); this._dismissTip(); } else { this.finish(); }
        });

        this.steps = this._buildSteps();
        this.tips  = this._buildTips();
    }

    // Step shape: { title, body (static HTML), target? (CSS selector to spotlight),
    //   hint? (what to click), done? (game => bool — auto-advances when true),
    //   enter? (game => void — runs once when the step is shown) }
    _buildSteps() {
        const isOpen = el => Overlay.isOpen(el);
        const openQueue = g => { if (!isOpen(g.taskQueueScreen)) g.toggleTaskQueueScreen(); };
        const closeQueue = g => { if (isOpen(g.taskQueueScreen)) g.toggleTaskQueueScreen(); };
        const closeCrew  = g => { if (isOpen(g.crewScreen)) g._closeCrewScreen(); };

        return [
            {
                title: 'Welcome aboard, Captain',
                body: `<p>The <strong>Stray Light</strong> is yours — and she's in rough shape. This short tour
                       walks you through keeping yourself alive and getting the first repairs under way.</p>
                       <p>Most steps ask you to click the real control, so by the end the ship will actually be in better order.</p>`,
            },
            {
                title: 'Where you are',
                target: '#header-location',
                body: `<p>Your current location and what kind of place it is are always shown here.</p>
                       <p>Right now you're parked on a <strong>planet</strong> with a breathable atmosphere — which gives you a free ride on life support, and is the only place you can buy parts.</p>`,
            },
            {
                title: 'Open the vents',
                target: '.environment-panel',
                hint: 'Click “Open Vents”.',
                done: g => g.ventsOpen,
                body: `<p>With the cabin sealed, you slowly use up oxygen and build up CO₂ — and the O₂ generator and CO₂ scrubber are both badly worn.</p>
                       <p>While you're on a planet you can skip all that: open the vents and outside air does the job for free. No need to run, or repair, either unit until you leave.</p>`,
            },
            {
                title: 'Ration the water',
                target: '#card-freshwater',
                hint: 'Click “Enable Rationing”.',
                done: g => g.systems.freshWater.rationing,
                body: `<p>You have 50 L of fresh water and nothing aboard that makes more. At normal use that's about 12 hours.</p>
                       <p>Rationing cuts use to a quarter, stretching it to about two days. It's harmless for the first 24 hours, then slowly wears on your health — so it only buys time to get a <strong>water maker</strong>.</p>`,
            },
            {
                title: 'No power, no systems',
                target: '#card-power',
                body: `<p>Everything electrical — oxygen, scrubbing, comms, a water maker — runs off this battery. <strong>If it hits zero, they all stop</strong>, whatever their switches say.</p>
                       <p>You have 100 Wh, and the generator that recharges it is too worn to be much use. Spend it carefully until that's fixed.</p>`,
            },
            {
                title: 'Repair the transceiver first',
                target: '#card-transceiver .repair-panel',
                hint: 'Click “50%” next to “Repair to”.',
                // Also satisfied if the player just orders the repair outright.
                done: g => g._repairTargets.transceiver === 50 || g.repairQueue.some(t => t.systemKey === 'transceiver'),
                body: `<p>Parts come from the local market, and the market is reached by radio — but at 25% repair this transceiver can't even reach the planet's own network.</p>
                       <p>Repairs come in <strong>stages</strong>. Nothing gets a little better as work goes on: a module stays as it is until a stage is finished, then steps up to that level. The worse the damage, the longer each step takes.</p>
                       <p><strong>Repair to</strong> picks where the job stops. A full repair is the default, but <strong>50%</strong> takes less than half the time and is already enough to reach the market — pick that, and finish the job later.</p>`,
            },
            {
                title: 'Order the repair',
                target: '#card-transceiver .repair-panel',
                hint: 'Click the “Repair to 50%” button.',
                done: g => g.repairQueue.some(t => t.systemKey === 'transceiver'),
                body: `<p>The button now shows the job you've chosen and how long it will take. The line under the chips shows what you get for it: the transceiver's output now, and after the repair.</p>
                       <p>The quickest way to order a repair is this button on the system's own card.</p>`,
            },
            {
                title: 'The Repair Queue',
                target: '#repair-queue-btn',
                hint: 'Click “Repair Queue”.',
                done: g => isOpen(g.taskQueueScreen),
                body: `<p>That repair is now a task in the Repair Queue. The queue is also the second place you can order repairs from.</p>`,
            },
            {
                title: 'Queue the generator next',
                target: '#repair-available-list',
                hint: 'Click “Add to Queue” on the Power Generator.',
                enter: openQueue,
                done: g => g.repairQueue.some(t => t.systemKey === 'power'),
                body: `<p><strong>Available Repairs</strong> lists every module that needs work, so you can queue jobs without hunting for the right card.</p>
                       <p>The transceiver sips power, but a water maker won't — line the generator up behind it.</p>`,
            },
            {
                title: 'Queue order is priority',
                target: '#repair-queue-list',
                enter: openQueue,
                body: `<p>Tasks are worked from the top down, <strong>one task per engineer on duty</strong>. You're the only engineer, so only the top task progresses — the rest wait.</p>
                       <p>Drag a task to reorder it. Moving one down pauses it without losing its progress — and stages already finished stay finished. Each task's <strong>Repair to</strong> target can be changed here too.</p>`,
            },
            {
                title: 'On shift, off shift',
                target: '#repair-crew-status',
                enter: openQueue,
                body: `<p>Repairs only progress while an engineer is <strong>on shift</strong>. It's just after midnight and your first shift starts at 09:00, so right now nobody is on duty and nothing is being fixed.</p>
                       <p>This line always shows who's on duty and when the next shift change is.</p>`,
            },
            {
                title: 'Your crew',
                target: '#crew-stat',
                hint: 'Click “Crew”.',
                enter: closeQueue,
                done: g => isOpen(g.crewScreen),
                body: `<p>Shifts are set per crew member. The crew counter also changes colour when someone's health is suffering.</p>`,
            },
            {
                title: 'Setting shifts',
                target: '#crew-list',
                enter: g => { closeQueue(g); if (!isOpen(g.crewScreen)) g._openCrewScreen(); },
                body: `<p>Try it: <strong>Edit Shifts → + Add shift → Save</strong> adds a 00:00–04:00 shift, putting you on duty right now so the transceiver repair starts immediately.</p>
                       <p>Hours have a price. <strong>8 a day is free</strong>; up to <strong>12</strong> you just work a little slower. Beyond that your health is ground down faster with every extra hour — 20-hour days can be endured but leave you a wreck, and working round the clock will kill you in a few days.</p>`,
            },
            {
                title: 'Passing the time',
                target: '.speed-controls',
                enter: closeCrew,
                body: `<p>Time has been standing still during this tour, and stops again whenever a tip is on screen. Once it's running, repairs take hours of ship time: use the speed buttons to fast-forward, and drop back to 1× when something needs attention.</p>
                       <p>From here, <strong>tips</strong> will point out what to do as things happen — next up, switching the transceiver on once it's fixed. <strong>Esc</strong> pauses and saves; the <strong>Tour</strong> button replays this.</p>`,
            },
        ];
    }

    // Tip shape: { id, title, body (static HTML), when (game => bool),
    //   target (CSS selector, or game => selector) }
    // Listed in priority order — when several are due, the first one shows first.
    _buildTips() {
        const cardOf = { o2: '#card-o2', co2: '#card-co2', power: '#card-power', transceiver: '#card-transceiver', waterMaker: '#card-watermaker' };
        const fitted = g => g.repairManager.repairableKeys().map(key => ({ key, sys: g.systems[key] }));
        const find   = (g, test) => fitted(g).find(({ key, sys }) => test(sys, key));
        const cardFor = test => g => cardOf[find(g, test)?.key] ?? null;
        const queued = (g, key) => g.repairQueue.some(t => t.systemKey === key);
        const pct    = sys => sys.repairPct ?? 100;

        const isDestroyed  = sys => sys.destroyed;
        const isGamble     = sys => !sys.destroyed && pct(sys) < 20;
        const isJuryRigged = sys => sys.juryRigged && !sys.destroyed;
        const isSliding    = sys => !sys.destroyed && pct(sys) < 50 && pct(sys) >= 40;
        const isRunning    = (sys, key) => sys.active && key !== 'transceiver';

        return [
            {
                id: 'no-power',
                title: 'Out of power',
                target: '#card-power',
                when: g => (g.systems.power.powerFraction ?? 1) < 1 && (g.systems.power.demandW ?? 0) > 0,
                body: `<p>The battery can't supply what's switched on, so those systems have slowed or stopped — look for <strong>NO POWER</strong> on their cards.</p>
                       <p>Switch off what you can spare, and get the generator repaired, fuelled and running to recharge.</p>`,
            },
            {
                id: 'black-full',
                title: 'Black water is overflowing',
                target: '#card-blackwater',
                when: g => (g.systems.blackWater.exposureHours ?? 0) > 0,
                body: `<p>The waste tank is full and backing up into the cabin. This hurts crew health <strong>immediately</strong>, the damage climbs every hour it's left, and so does the chance of a serious infection.</p>
                       <p>Dump it now — the 100 credit fine is the cheap option.</p>`,
            },
            {
                id: 'water-empty',
                title: 'Out of fresh water',
                target: '#card-freshwater',
                when: g => g.systems.freshWater.current <= 0,
                body: `<p>The fresh water tank is empty. You have about <strong>24 hours</strong> before dehydration sets in, and a day after that it is fatal.</p>
                       <p>You need a working water maker: buy one in Comms &amp; Nav, repair it, and keep it powered.</p>`,
            },
            {
                id: 'transceiver-fixed',
                title: 'Transceiver repaired',
                target: '#card-transceiver',
                when: g => {
                    const t = g.systems.transceiver;
                    const reach = g.repairManager.efficiencyFor('transceiver') * (t.ratedRangeLy ?? 2);
                    return !t.destroyed && !t.active && reach >= g.commsNav.LOCAL_DETAILS_RANGE_LY;
                },
                body: `<p>It's now good enough to reach the local network. Switch it on with <strong>Enable Transceiver</strong> — it draws very little power and barely wears, so it can stay on.</p>
                       <p>Range grows with each repair stage: the planet's own network first, then contacts further out.</p>`,
            },
            {
                id: 'comms-online',
                title: 'The local market is in range',
                target: '#comms-nav-btn',
                when: g => g.commsNav.hasLocalDetails() && g.systems.waterMaker.installed === false,
                body: `<p>Click <strong>Open Comms &amp; Nav</strong> here on the Transceiver card and select your current location to see what's for sale. You can only buy while you're on the planet.</p>
                       <p>You need a <strong>water maker</strong>. They're all salvage: 100–200 credits depending on condition. One below 20% is cheapest, but repairing it is a gamble that can destroy it.</p>`,
            },
            {
                id: 'watermaker-bought',
                title: 'Water maker fitted',
                target: '#card-watermaker',
                when: g => { const w = g.systems.waterMaker; return w.installed && !w.destroyed && pct(w) < 50 && !queued(g, 'waterMaker'); },
                body: `<p>It's aboard, in the state you bought it. Queue its repair from this card — and check the Repair Queue order, since it will wait behind anything above it.</p>`,
            },
            {
                id: 'watermaker-ready',
                title: 'Water maker repaired',
                target: '#card-watermaker',
                when: g => { const w = g.systems.waterMaker; return w.installed && !w.destroyed && pct(w) >= 50 && !w.active && !queued(g, 'waterMaker'); },
                body: `<p>Switch it on. It reclaims black water into fresh water — which also keeps the waste tank down — and on a planet it tops up from the outside air.</p>
                       <p>It's the hungriest thing aboard — 30 W while reclaiming waste, less while condensing from air — so without the generator running it will flatten the battery in a few hours. You can come off rationing once the tank can cover it: after a day on short rations that takes a one-off 50 L per person to rehydrate, so the button stays greyed out until there's that much in the tank.</p>`,
            },
            {
                id: 'generator-fixed',
                title: 'Generator repaired',
                target: '#card-power',
                when: g => { const p = g.systems.power; return !p.destroyed && pct(p) >= 50 && !p.active && !queued(g, 'power'); },
                body: `<p>Switch it on to recharge the battery. It burns fuel while it runs, and throttles back by itself once the battery reaches the <strong>Maintain at</strong> level.</p>`,
            },
            {
                id: 'destroyed',
                title: 'Module destroyed',
                target: cardFor(isDestroyed),
                when: g => !!find(g, isDestroyed),
                body: `<p>That repair failed and the module is beyond saving. It can't be switched on or repaired again.</p>
                       <p>The local market sells salvaged replacements — a destroyed module is the one case where you can buy a spare.</p>`,
            },
            {
                id: 'gamble',
                title: 'Too far gone for a normal repair',
                target: cardFor(isGamble),
                when: g => !!find(g, isGamble),
                body: `<p>Below 20% the first repair stage is a salvage job. It only gets the module back to 20%, leaves it jury-rigged — and has a <strong>1 in 5 chance of destroying it</strong> outright.</p>
                       <p>Catch modules before they fall this far.</p>`,
            },
            {
                id: 'jury-rigged',
                title: 'Jury-rigged',
                target: cardFor(isJuryRigged),
                when: g => !!find(g, isJuryRigged),
                body: `<p>The salvage held, but it's a bodge: this module wears ten times faster than normal while it's switched on. Finishing the next repair stage replaces the bodged parts and clears it.</p>`,
            },
            {
                id: 'sliding',
                title: 'This repair just got bigger',
                target: cardFor(isSliding),
                when: g => !!find(g, isSliding),
                body: `<p>This module has slipped down a repair stage. Each stage lower takes longer to climb back out of, and output drops with it — below 50% it gives less than 40% of its rating.</p>
                       <p>A short repair now is cheaper than a long one later.</p>`,
            },
            {
                id: 'running',
                title: 'Running a module wears it out',
                target: cardFor(isRunning),
                when: g => !!find(g, isRunning),
                body: `<p>A module only wears while it's switched on, so anything you don't need is best left off.</p>
                       <p><strong>Maintain at</strong> sets a target: the unit throttles back once it's reached, which saves power too.</p>`,
            },
            {
                id: 'overworked',
                title: 'Overworked',
                target: '#crew-stat',
                when: g => g.crewManifest.some(m => !m.dead && g.crewManager.dutyHours(m) > g.crewManager.FATIGUE_OK_HOURS),
                body: `<p>Someone is scheduled for more than 12 hours a day. Their health is being worn down toward a ceiling that drops sharply with each extra hour, and poor health makes them slower in turn.</p>
                       <p>Fine for a short push; cut the hours back afterwards and they recover.</p>`,
            },
            {
                id: 'crew-unconscious',
                title: 'Crew member down',
                target: '#crew-stat',
                when: g => g.crewManifest.some(m => !m.dead && m.health < g.crewManager.UNCONSCIOUS_THRESHOLD),
                body: `<p>Below 20% health a crew member is unconscious and can't work — so repairs stop too. At 0% they die, and there is no bringing them back.</p>
                       <p>Open Crew to see exactly what is hurting them.</p>`,
            },
            {
                id: 'crew-health',
                title: 'Crew health is dropping',
                target: '#crew-stat',
                when: g => g.crewManifest.some(m => !m.dead && m.health < g.crewManager.WARNING_THRESHOLD),
                body: `<p>The crew counter turns amber, then red, as health falls. Open <strong>Crew</strong>: “Active Health Impacts” lists every cause and how fast it's hurting.</p>
                       <p>Unwell crew work slower, so problems compound. Health recovers once the causes are fixed.</p>`,
            },
            {
                id: 'ration-strain',
                title: 'Rationing is taking its toll',
                target: '#card-freshwater',
                when: g => { const f = g.systems.freshWater; return f.rationing && (f.rationHours ?? 0) >= g.crewManager.WATER_RATION_GRACE_HOURS; },
                body: `<p>After a day on short rations your health has started to slip. Coming off rationing now costs a one-off 50 L per person to rehydrate — until the tank holds that much, the button stays greyed out and the card shows how far short you are.</p>
                       <p>So the way out is a working water maker, not the switch.</p>`,
            },
            {
                id: 'black-filling',
                title: 'Black water tank is filling',
                target: '#card-blackwater',
                when: g => g.systems.blackWater.level >= 70,
                body: `<p>Used water ends up here. If the tank fills completely it overflows into the cabin and makes the crew ill.</p>
                       <p><strong>Dump to Space</strong> empties it, but every dump is detected and fined 100 credits. A running water maker reclaims the liquid instead — though not the solid matter, which slowly builds up until it's dumped.</p>`,
            },
        ];
    }

    // ── Preferences (per browser) ───────────────────────────────────────────

    _get(key) { try { return localStorage.getItem(key); } catch { return null; } }
    _set(key, value) {
        try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); }
        catch { /* storage blocked — the preference just doesn't stick */ }
    }

    setTipsEnabled(on) { this._set(this.TIPS_OFF_KEY, on ? null : '1'); }
    tipsEnabled()      { return this._get(this.TIPS_OFF_KEY) !== '1'; }

    // Which tips this save has already shown — kept per save so a new game gets them afresh.
    _seenTips() {
        try { return JSON.parse(this._get(this.TIPS_SEEN_PREFIX + this.game.saveId) ?? '[]'); } catch { return []; }
    }
    _markTipSeen(id) {
        const seen = this._seenTips();
        if (!seen.includes(id)) this._set(this.TIPS_SEEN_PREFIX + this.game.saveId, JSON.stringify([...seen, id]));
    }

    // While a tour step or a tip is on screen the game clock stands still
    // (main.js checks this each tick), so nothing happens behind the card and
    // there's no hurry to read it. Unlike the pause menu this doesn't block
    // the controls — action steps need them.
    holdsTime() {
        return this.active || !!this.tip;
    }

    // ── Tour lifecycle ──────────────────────────────────────────────────────

    // Called from startNewGame(): first-time players get the tour automatically.
    maybeAutoStart() {
        if (this._get(this.SEEN_KEY) !== '1') this.start();
    }

    start() {
        this.tip    = null;
        this.active = true;
        this._startPolling();
        this._show(0);
    }

    // Completed or skipped — either way the player has seen it, so don't auto-show again.
    finish() {
        this._set(this.SEEN_KEY, '1');
        this.stop();
    }

    // Tear down without recording anything as seen (e.g. the player quit to the menu).
    stop() {
        this.active = false;
        this.tip    = null;
        clearInterval(this._poll);
        this._poll = null;
        this.layerEl.style.display = 'none';
    }

    next() {
        if (!this.active) return;
        if (this.index >= this.steps.length - 1) { this.finish(); return; }
        this._show(this.index + 1);
    }

    // Polled rather than event-driven: the dashboard re-renders imperatively
    // every tick (and overlay lists rebuild their DOM), so the target is
    // re-queried and re-measured each time instead of holding a stale node.
    _startPolling() {
        this.layerEl.style.display = 'block';
        clearInterval(this._poll);
        this._poll = setInterval(() => this._tick(), 150);
    }

    // ── Tips ────────────────────────────────────────────────────────────────

    // Called once per game tick from main.js. Shows the first due, unseen tip —
    // but never over the tour, another tip, or an open overlay screen (the
    // tip's target would be underneath it).
    checkTips() {
        const g = this.game;
        if (this.active || this.tip || !g.gameActive || g.gamePaused || !this.tipsEnabled()) return;
        if (document.querySelector('.overlay-screen[style*="flex"]')) return;

        const seen = this._seenTips();
        const due  = this.tips.find(t => !seen.includes(t.id) && t.when(g));
        if (!due) return;

        this._markTipSeen(due.id);
        this.tip = due;
        this._scrolledForStep = false;
        this._actionStep      = false;

        this.countEl.textContent = 'Tip · time paused';
        this.titleEl.textContent = due.title;
        this.bodyEl.innerHTML    = due.body; // static strings from _buildTips(), never player data
        this.hintEl.style.display      = 'none';
        this.skipStepBtn.style.display = 'none';
        this.nextBtn.style.display     = '';
        this.nextBtn.textContent       = 'Got it';
        this.skipBtn.style.display     = '';
        this.skipBtn.textContent       = 'Turn off tips';

        this._startPolling();
        this._layout();
    }

    _dismissTip() {
        this.stop();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _show(index) {
        this.index = index;
        const step = this.steps[index];
        this._scrolledForStep = false;

        if (step.enter) step.enter(this.game);

        // An action step the player has already satisfied (replaying the tour on
        // an established ship) degrades to a plain "Next" step instead of
        // flashing past.
        this._actionStep = !!step.done && !step.done(this.game);

        this.countEl.textContent = `Step ${index + 1} of ${this.steps.length} · time paused`;
        this.titleEl.textContent = step.title;
        this.bodyEl.innerHTML    = step.body; // static strings from _buildSteps(), never player data

        const isLast = index === this.steps.length - 1;
        this.hintEl.textContent        = this._actionStep ? step.hint : (step.done ? 'Already done ✓' : '');
        this.hintEl.style.display      = this.hintEl.textContent ? '' : 'none';
        this.nextBtn.style.display     = this._actionStep ? 'none' : '';
        this.nextBtn.textContent       = isLast ? 'Finish' : 'Next';
        this.skipStepBtn.style.display = this._actionStep ? '' : 'none';
        this.skipBtn.style.display     = isLast ? 'none' : '';
        this.skipBtn.textContent       = 'Skip tour';

        this._layout();
    }

    _current() {
        return this.tip ?? this.steps[this.index];
    }

    _tick() {
        if (!this.active && !this.tip) return;
        const g = this.game;
        if (!g.gameActive) { this.stop(); return; }

        // Hide under the pause menu — the controls being pointed at are inert while paused.
        this.layerEl.style.display = g.gamePaused ? 'none' : 'block';
        if (g.gamePaused) return;

        if (this.active && this._actionStep && this.steps[this.index].done(g)) { this.next(); return; }
        this._layout();
    }

    _layout() {
        const item     = this._current();
        const selector = typeof item.target === 'function' ? item.target(this.game) : item.target;
        const target   = selector ? document.querySelector(selector) : null;
        const shown    = target && target.getClientRects().length > 0;
        const vw = window.innerWidth, vh = window.innerHeight;
        const card = this.cardEl.getBoundingClientRect();
        const gap = 14, margin = 12;

        if (!shown) {
            // No target (or it isn't on screen yet): dim everything, centre the card.
            Object.assign(this.spotlightEl.style, { left: vw / 2 + 'px', top: vh / 2 + 'px', width: '0px', height: '0px' });
            this.cardEl.style.left = Math.max(margin, (vw - card.width) / 2) + 'px';
            this.cardEl.style.top  = Math.max(margin, (vh - card.height) / 2) + 'px';
            return;
        }

        if (!this._scrolledForStep) {
            this._scrolledForStep = true;
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
        }

        const pad = 6;
        const r = target.getBoundingClientRect();
        const box = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
        Object.assign(this.spotlightEl.style, {
            left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px',
        });

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const centredLeft = clamp(box.left + box.width / 2 - card.width / 2, margin, vw - card.width - margin);
        const centredTop  = clamp(box.top + box.height / 2 - card.height / 2, margin, vh - card.height - margin);
        const right = box.left + box.width, bottom = box.top + box.height;

        // Prefer below, then above, then either side; last resort overlaps the
        // target's lower edge (only when the target fills most of the viewport).
        let left = centredLeft, top;
        if (bottom + gap + card.height <= vh - margin) {
            top = bottom + gap;
        } else if (box.top - gap - card.height >= margin) {
            top = box.top - gap - card.height;
        } else if (right + gap + card.width <= vw - margin) {
            left = right + gap; top = centredTop;
        } else if (box.left - gap - card.width >= margin) {
            left = box.left - gap - card.width; top = centredTop;
        } else {
            top = vh - card.height - margin;
        }

        this.cardEl.style.left = left + 'px';
        this.cardEl.style.top  = top + 'px';
    }
}
