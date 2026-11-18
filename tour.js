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
                       <p>Right now you're at the back of <strong>Harlow's Salvage</strong>, a yard 120 km out from Port Carrow, on a planet with a breathable atmosphere — which gives you a free ride on life support.</p>
                       <p>Everything bought and sold changes hands at the port. Nothing gets delivered out here, so until she can fly there herself, goods travel by <strong>transfer drone</strong>.</p>`,
            },
            {
                title: 'Her drives are scrap',
                target: '#group-logistics',
                body: `<p>You knew when you bought her: the <strong>atmospheric thrusters</strong> and the <strong>ion drive</strong> are both wrecked. Not worth repairing — but worth <strong>stripping for parts</strong>, which gives you components to build with.</p>
                       <p>Stripped parts go in a storage box. <strong>Storage Box 2 is empty — keep it that way for the parts.</strong> Don't start composting in it, or there'll be nowhere to put them.</p>
                       <p>The plan: buy a drone and have it bring a water maker first, strip the drives, build a drone dock to charge it, then build new thrusters and fly her into the port.</p>`,
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
                title: 'Food',
                target: '#card-food',
                body: `<p>You have five days of <strong>food rations</strong> in a storage box. Each crew member eats three a day.</p>
                       <p>When they run low, buy more on the market — they need a storage box with room, and from the yard a drone has to fetch them. Run out and nothing happens for three days, then hunger starts to wear the crew down.</p>
                       <p><strong>Rationing</strong> halves each meal. The crew work a little slower while underfed, and after a week it starts to wear on their health — far gentler than going without.</p>
                       <p>What's eaten ends up as solid waste in the black water tank.</p>`,
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
                title: 'The Work Queue',
                target: '#repair-queue-btn',
                hint: 'Click “Work Queue”.',
                done: g => isOpen(g.taskQueueScreen),
                body: `<p>That repair is now a task in the Work Queue. Engineers work through it from the top — repairs, and anything you ask them to fabricate. It's also the second place you can order repairs from.</p>`,
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
                title: 'Black water has spilled',
                target: '#card-blackwater',
                when: g => (g.systems.blackWater.exposureHours ?? 0) > 0,
                body: `<p>The waste tank was full, and what it couldn't take has spilled into the cabin. This hurts crew health <strong>immediately</strong>, the damage climbs every hour it's left, and so does the chance of a serious infection.</p>
                       <p>Press <strong>Clean Up Spill</strong> on the Black Water card. The spill goes back into the tank, along with half as much again of fresh water used to clean it up, so the tank needs room for both. Make room by running the water maker or moving solids to a compost box; dumping the tank is the last resort.</p>`,
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
                id: 'food-out',
                title: 'Out of food',
                target: '#card-food',
                when: g => g.fabrication.rationsAboard() <= 0 && (g.systems.food.starvedHours ?? 0) > 0,
                body: `<p>There's no food aboard. The crew can go about <strong>three days</strong> without it; after that hunger wears their health down, and ten days later it is fatal.</p>
                       <p>Buy rations on the market in Comms &amp; Nav. They need an empty storage box, or a food box with room.</p>`,
            },
            {
                id: 'food-low',
                title: 'Food is running low',
                target: '#card-food',
                when: g => g.systems.food.status === 'Warning' && g.fabrication.rationsAboard() > 0,
                body: `<p>Less than three days of rations left. Buy more on the planet's market (Comms &amp; Nav) — a case is 10 rations. Rationing food on the Food Stores card makes what's left last twice as long, at the cost of slower work.</p>
                       <p>Rations are stored in storage boxes: they fill food boxes first, then empty ones. If every box is in use, fabricate another from the Work Queue.</p>`,
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
                body: `<p>Click <strong>Open Comms &amp; Nav</strong> here on the Transceiver card and select your current location to see what's for sale.</p>
                       <p>Buy a <strong>transfer drone</strong> first: from the yard, nothing you buy reaches the ship without one. It flies itself over, charged — but with only enough charge for <strong>one round trip</strong> until you build it a dock.</p>
                       <p>So order its first load at the same time: a <strong>water maker</strong> (salvage, 100–200 credits by condition — one below 20% is cheapest, but repairing it is a gamble that can destroy it), one <strong>composting agent</strong> and a case of <strong>food</strong>. That's 35 kg — exactly one drone load.</p>`,
            },
            {
                id: 'drone-arrived',
                title: 'Your drone is here — plan its first run',
                target: '#card-drone',
                when: g => g.logistics.drones().some(d => g.logistics.isHome(d)) && !g.droneDocks && g.systems.waterMaker.installed === false,
                body: `<p>It carries 35 kg a run to and from Port Carrow, about two and a half hours there and back. What you buy waits at the port until a run brings it: press <strong>Plan Run</strong> to choose what comes back, then <strong>Send to Port</strong>.</p>
                       <p>Make this run count — it's the only one the drone has charge for until there's a dock. Plan the <strong>water maker</strong>, the <strong>composting agent</strong> and the <strong>food</strong>: a full 35 kg. If you haven't ordered them yet, do that first in Comms &amp; Nav.</p>`,
            },
            {
                id: 'strip-drives',
                title: 'Strip the drives for parts',
                target: '#card-thrusters',
                when: g => {
                    const t = g.systems.thrusters;
                    return t.installed !== false && t.destroyed && !g.droneDocks
                        && !g.repairQueue.some(task => task.kind === 'strip')
                        // While the first run is out, or once the water maker's repair is in hand — never ahead of it.
                        && (g.logistics.drones().some(d => !g.logistics.isHome(d))
                            || (g.systems.waterMaker.installed !== false && (queued(g, 'waterMaker') || pct(g.systems.waterMaker) >= 50)));
                },
                body: `<p>The wrecked atmospheric thrusters give up 2 precision and 3 basic components into the empty Storage Box 2 — everything the next two builds need. Press <strong>Strip for Parts</strong>; it takes 8 crew-hours in the Work Queue, so put it <strong>after</strong> the water maker's repair.</p>`,
            },
            {
                id: 'drives-stripped',
                title: 'A compost box and a drone dock',
                target: '#repair-queue-btn',
                when: g => g.fabrication.count('precisionComponents') >= 1 && !g.droneDocks && !g.repairQueue.some(t => t.recipeKey === 'droneDock'),
                body: `<p>The stripped parts make two things in the Work Queue. A <strong>Storage Box</strong> (1 basic component) — dose it with the composting agent and it takes the solid waste the water maker can't. And a <strong>Drone Dock</strong> (1 precision + 2 basic) — dock the drone on it from the Transfer Drones card.</p>
                       <p>A dock only charges from <strong>spare generator power</strong>: whatever the generator can make beyond what the ship is using. Until the generator is repaired, there's none.</p>
                       <p>Normally you shouldn't charge from the ship's battery — the systems keeping the crew alive need it. But this early on the ship draws very little, and getting the drone flying again matters more, so this is the exception: switch on the drone's <strong>charge from battery</strong> override. It never takes the battery below 20%. Switch it off again once the generator is running.</p>`,
            },
            {
                id: 'drone-low',
                title: 'The drone needs charging',
                target: '#card-drone',
                when: g => g.logistics.drones().some(d => g.logistics.isHome(d) && (d.chargeWh ?? 0) < g.logistics.roundTripWh()),
                body: `<p>A drone won't set out without charge for the whole round trip, and it can only charge on a <strong>drone dock</strong> — build one from stripped parts if you haven't. A dock fills it from spare generator power, so it charges faster the more the generator can spare. With no generator running yet, use the drone's <strong>charge from battery</strong> override, and switch it off once the generator is up.</p>`,
            },
            {
                id: 'settled',
                title: 'Breathing room',
                target: null,
                when: g => g.droneDocks > 0 && g.systems.waterMaker.active && !g.systems.waterMaker.destroyed
                    && g.fabrication.boxes().some(b => b.kind === 'compost'),
                body: `<p>Water is being made, black water is being reclaimed, solid waste has a compost box and the drone can recharge. The ship can look after itself for a while.</p>
                       <p>Now's the time to fix things up properly: finish repairs, keep an eye on food, and start trading — compost and repaired salvage sell at the port — towards new thrusters.</p>`,
            },
            {
                id: 'thrusters-plan',
                title: 'New thrusters',
                target: '#card-thrusters',
                when: g => g.droneDocks > 0 && g.systems.thrusters.installed === false && !g.repairQueue.some(t => t.recipeKey === 'thrusters'),
                body: `<p>New atmospheric thrusters take 10 precision and 12 basic components and three days in the Work Queue. Precision components cost 150 credits at the port, so you'll need to trade first — repair salvage and sell it, sell compost.</p>
                       <p>The hop to Port Carrow burns 20 L of fuel. Fuel isn't cheap and a drone carries 35 L a run, so get some in before you go. At the port everything comes straight aboard.</p>`,
            },
            {
                id: 'thrusters-ready',
                title: 'She can fly',
                target: '#card-thrusters',
                when: g => g.systems.thrusters.installed !== false && !g.systems.thrusters.destroyed && !g.logistics.atPort() && !g.logistics.isFlying(),
                body: `<p>The thrusters are fitted. With 20 L of fuel aboard and the drone stowed or docked, <strong>Fly to Port Carrow</strong>.</p>`,
            },
            {
                id: 'at-port',
                title: 'Port Carrow',
                target: '#header-location',
                when: g => g.logistics.atPort(),
                body: `<p>Berthed at the port: what you buy comes straight aboard and what you sell is paid for on the spot. Anything still waiting in the port hold is loaded now.</p>`,
            },
            {
                id: 'watermaker-bought',
                title: 'Water maker fitted',
                target: '#card-watermaker',
                when: g => { const w = g.systems.waterMaker; return w.installed && !w.destroyed && pct(w) < 50 && !queued(g, 'waterMaker'); },
                body: `<p>It's aboard, in the state you bought it. Queue its repair from this card and move it to the <strong>top of the Work Queue</strong>: until it runs, nothing is emptying the black water tank.</p>
                       <p>Once it's reclaiming, the tank stays under control while you strip the drives and build a compost box and a drone dock.</p>`,
            },
            {
                id: 'watermaker-ready',
                title: 'Water maker repaired',
                target: '#card-watermaker',
                when: g => { const w = g.systems.waterMaker; return w.installed && !w.destroyed && pct(w) >= 50 && !w.active && !queued(g, 'waterMaker'); },
                body: `<p>Switch it on. It reclaims black water into fresh water — which also keeps the waste tank down — and on a planet it tops up from the outside air. Black water always goes first; the card shows the split.</p>
                       <p>It's the hungriest thing aboard — 30 W while reclaiming waste, less while condensing from air — so without the generator running it will flatten the battery in a few hours. You can come off rationing once the tank can cover it: after a day on short rations that takes a one-off 50 L per person to rehydrate, and it all ends up in the black water tank, so the button stays greyed out until there's that much fresh water and room in the black water tank for it.</p>`,
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
                       <p>The local market sells salvaged replacements: <strong>Buy &amp; Fit</strong> puts one straight in. With a machine storage box you can also keep a spare aboard and swap it in from the Cargo Hold.</p>`,
            },
            {
                // Shown once things have gone badly wrong — the moment going back is worth knowing about.
                // The Timeline is on the pause menu, which isn't on screen, so there's nothing to spotlight.
                id: 'timeline',
                title: 'You can go back',
                target: null,
                when: g => !!find(g, isDestroyed) || g.crewManifest.some(m => m.dead || m.health < g.crewManager.UNCONSCIOUS_THRESHOLD),
                body: `<p>If this has gone worse than you'd like, you don't have to live with it. Press <strong>Escape</strong> to pause, then open the <strong>Timeline</strong>.</p>
                       <p>It keeps a checkpoint every game hour, plus every save. Pick one to go back to and play on from there — the line you leave is kept too, so you can always return to it.</p>`,
            },
            {
                id: 'solids-box',
                title: 'Solid waste has nowhere to go',
                target: '#cargo-btn',
                when: g => g.systems.blackWater.solidL >= 20 && !g.fabrication.boxes().some(b => b.kind === 'compost'),
                body: `<p>Everything the crew eat ends up as solid waste in the black water tank, and the water maker can't touch it, so it only builds up. Compost it instead, and sell it.</p>
                       <p>You need a storage box of its own — your food is in one, and keep Storage Box 2 for stripped parts. Fabricate a storage box in the Work Queue (one basic component — stripping the drives gives you some), dose it with <strong>composting agent</strong>, then move solids into it from the Black Water card.</p>`,
            },
            {
                id: 'compost-ready',
                title: 'Compost is ready',
                target: '#cargo-btn',
                when: g => g.fabrication.boxes().some(b => g.fabrication.boxStatus(b) === 'ready'),
                body: `<p>A storage box has finished composting. Sell it from the <strong>Cargo Hold</strong>, or the market in Comms &amp; Nav, with the local network in range — the box is then empty and ready to use again.</p>
                       <p>From the yard it goes by drone, 35 L a run, and is paid for when the drone lands at the port.</p>`,
            },
            {
                id: 'machine-box',
                title: 'A machine storage box',
                target: '#cargo-btn',
                when: g => g.fabrication.machineBoxes().some(b => !b.module),
                body: `<p>A machine box holds one module — switched off, not wearing, and without needing a slot on the dashboard.</p>
                       <p>Use <strong>Buy &amp; Store</strong> on the market to put a salvaged module in it. Keep it as a spare and swap it in from the <strong>Cargo Hold</strong>, or repair it in the Work Queue and sell it: a fully repaired module fetches up to 750 credits, several times what the salvage costs — a damaged one fetches little, so the repair is where the money is. Each sale floods the market a little, so the next of the same kind fetches a bit less for a few days.</p>`,
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
                       <p>Fine for a short push; cut the hours back afterwards and they recover — a new roster takes about a day to settle in, either way.</p>`,
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
                body: `<p>After a day on short rations your health has started to slip. Coming off rationing now costs a one-off 50 L per person to rehydrate — until the tank holds that much, and the black water tank has room for it once it's used, the button stays greyed out and the card shows how far short you are.</p>
                       <p>So the way out is a working water maker, not the switch.</p>`,
            },
            {
                id: 'black-filling',
                title: 'Black water tank is filling',
                target: '#card-blackwater',
                when: g => g.systems.blackWater.level >= 70,
                body: `<p>Used water ends up here. If the tank fills completely it overflows into the cabin and makes the crew ill.</p>
                       <p>A running water maker reclaims the liquid, but there's a limit to how much it can recover: it can't touch the solid matter, or the liquid soaked into it, so the tank still slowly fills. Move the solids to a compost box — the liquid they held is then freed for the water maker to reclaim.</p>`,
            },
            {
                id: 'space-low',
                title: 'Running out of room',
                target: '#ship-capacity-btn',
                when: g => {
                    const cap = g._computeShipCapacity();
                    const cargoKg = cap.maxMassKg - cap.unladenMassKg;
                    return cap.totalVolumeM3 > 0 && cargoKg > 0
                        && (cap.freeVolumeM3 < cap.totalVolumeM3 * 0.15 || cap.freeMassKg < cargoKg * 0.15);
                },
                body: `<p>The ship is nearly full — by volume, or by the mass it's allowed to carry. Once there's no room, buying supplies and fabricating boxes are refused.</p>
                       <p><strong>Ship Capacity</strong> shows what's taking up the space. Selling finished compost or stored equipment, or using up supplies, frees some.</p>`,
            },
            {
                id: 'notifications',
                title: 'Notifications',
                target: '#notifications-pill',
                when: g => g.notifications.list.length > 0,
                body: `<p>Something just happened aboard. Every warning, finished repair, purchase, sale and fine is listed under <strong>Notifications</strong>, with the ship time it happened — so nothing is missed while time runs fast.</p>
                       <p>The number is how many are listed, and the pill turns amber or red while a warning or something critical is among them. Click it to read them; delete one with its <strong>×</strong>, or <strong>Clear all</strong>.</p>`,
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
