// ── Overlay show/hide ──────────────────────────────────────────────────────
// Every modal (the .overlay-screen family, pause menu, seed and intro screens)
// is opened and closed through here. Opening is animated by CSS (display
// none → flex restarts the card-pop animation); closing plays a short fade
// with the Web Animations API and only then sets display:none. While closing
// the overlay ignores the mouse, and isOpen() already reports it as closed, so
// toggles and per-tick "is this screen open?" checks behave as if it were gone.
// Re-opening mid-close cancels the fade.
const Overlay = {
    motionOk() {
        return typeof Element.prototype.animate === 'function'
            && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    },

    isOpen(el) {
        return el.style.display === 'flex' && !el._closeAnims;
    },

    show(el) {
        if (el._closeAnims) {
            const anims = el._closeAnims;
            el._closeAnims = null;
            anims.forEach(a => a.cancel());
        }
        el.style.pointerEvents = '';
        el.style.display = 'flex';
    },

    hide(el) {
        if (el.style.display === 'none' || el._closeAnims) return;
        if (!Overlay.motionOk()) { el.style.display = 'none'; return; }

        const timing = { duration: 160, easing: 'ease-in', fill: 'forwards' };
        const anims = [el.animate([{ opacity: 1 }, { opacity: 0 }], timing)];
        const card = el.firstElementChild;
        if (card) anims.push(card.animate(
            [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.97)' }], timing
        ));
        el._closeAnims = anims;
        el.style.pointerEvents = 'none';

        Promise.all(anims.map(a => a.finished)).then(() => {
            if (el._closeAnims !== anims) return; // re-opened meanwhile
            el._closeAnims = null;
            el.style.display = 'none';
            el.style.pointerEvents = '';
            anims.forEach(a => a.cancel()); // drop the held end state
        }, () => { /* cancelled by show() */ });
    },
};

class StarshipGame {
    constructor() {
        this.gameActive = false;
        this.gamePaused = false;
        this.timer      = null;
        this.autosaveTimer = null;
        this.credits    = 1000;
        this.crew       = 1;
        this.gameTime   = 0;
        this.gameSpeed  = 1;

        // Ship identity (loaded from ship databases)
        this.shipInstanceId   = 'player-ship-1';
        this.shipName         = 'Stray Light';
        this.shipRegistration = 'PDR-4471-K';
        this.shipClass        = null; // populated from ship_classes.json
        this.storyMessages    = null; // populated from story_messages.json

        // Active save slot (set on New Game / Load Game)
        this.saveId   = null;
        this.saveName = null;

        // Environment state
        this.inBreathableAtmosphere = true;
        this.ventsOpen              = false;

        this.systems = this._defaultSystems();

        // Repair state
        this.repairQueue   = [];
        this.moduleSpecs   = null; // populated from data/module_specs.json
        this.crewManifestTemplate = []; // populated from data/crew_manifest.json — read-only base shifts/classes
        this.crewManifest  = [];   // live roster: template + health/shifts/variance/dead (CrewManager)
        this._editingCrewId = null;

        // Comms & Nav: seeded sector roster (current location + discovered points of interest)
        this.commsSeed      = null;
        // Gameplay randomness. Seeded from the sector seed in startNewGame(),
        // and its state is saved and restored with the game (rng.js).
        this.rng            = new GameRng(0);
        this.commsLocations = [];
        this._selectedCommsId = null;
        this._pendingSeed     = null; // chosen on the seed screen, consumed by startNewGame()
        this.market           = [];   // items for sale (CommsNav owns generation + purchase rules)
        this.cargo            = Fabrication.defaultCargo(); // supplies aboard + storage boxes (Fabrication)
        this.moduleResale     = {};   // moduleKey → recent sales, which lower resale prices (Fabrication)
        this._repairTargets   = {};   // systemKey → repair level picked on its "Repair to" chips (UI state only)

        // Every black water dump is detected and fined, no matter where you are.
        this.BLACK_WATER_DUMP_FINE = 100;

        this.launchScreen   = document.getElementById('launch-screen');
        this.gameContainer  = document.getElementById('game-container');
        this.pauseMenu      = document.getElementById('pause-menu');
        this.seedScreen      = document.getElementById('seed-screen');
        this.introModal     = document.getElementById('intro-modal');
        this.taskQueueScreen = document.getElementById('task-queue-screen');
        this.loadScreen      = document.getElementById('load-screen');
        this.crewScreen      = document.getElementById('crew-screen');
        this.commsNavScreen  = document.getElementById('comms-nav-screen');
        this.shipCapacityScreen = document.getElementById('ship-capacity-screen');
        this.cargoScreen        = document.getElementById('cargo-screen');
        this.droneRunScreen     = document.getElementById('drone-run-screen');
        this._planDroneId       = null; // the drone whose run the Plan Run screen is showing
        this.creditsElement = document.getElementById('credits');
        this.timerElement   = document.getElementById('timer');
        this.dayElement     = document.getElementById('day-counter');
        this.crewElement    = document.getElementById('crew');
        this.crewStatElement = document.getElementById('crew-stat');

        this.crewManager    = new CrewManager(this);
        this.commsNav        = new CommsNav(this);
        this.repairManager = new RepairManager(this);
        this.fabrication   = new Fabrication(this);
        this.logistics     = new Logistics(this); // berth, drones, port hold, drives (logistics.js)
        this.logistics.reset();
        this.systemUpdate   = new SystemUpdate(this);
        this.tour           = new Tour(this);
        this.timeline       = new Timeline(this);
        this.notifications  = new Notifications(this);
        this._bindEvents();
        this._loadShipDatabases();
        this.setBackground('space');
        this.updateDisplay();
    }

    // ── Background theme ────────────────────────────────────────────────────
    // 'city' (the planet surface: Harlow's yard, and the menus), 'port' (berthed
    // at Port Carrow), 'flight' (crossing between them) or 'space'.
    setBackground(theme) {
        if (document.body.dataset.bg !== theme) document.body.dataset.bg = theme;
    }

    // In a game, the background follows where the ship is.
    _syncBackground() {
        if (!this.gameActive) return;
        this.setBackground(this.logistics.isFlying() ? 'flight' : this.logistics.atPort() ? 'port' : 'city');
    }

    _defaultSystems() {
        return {
            o2: {
                pct: 21.0, status: 'Normal', active: false,
                count: 1, tier: 1,
                consumptionLhr: 15.0, generationLhr: 0, ventLhr: 0, netLhr: -15.0,
                target: 21.0,
                repairPct: 25, juryRigged: false, destroyed: false,
            },
            co2: {
                pct: 0.04, status: 'Normal', active: false,
                count: 1, tier: 1,
                productionLhr: 12.0, removalLhr: 0, ventLhr: 0, netLhr: 12.0,
                target: 0.04,
                repairPct: 25, juryRigged: false, destroyed: false,
            },
            power: {
                level: 10, status: 'Warning', active: false,
                capacity: 1000, current: 100,
                count: 1, tier: 1,
                genOutputW: 0, o2DrawW: 0, co2DrawW: 0, otherDrawW: 0, netWhr: 0,
                powerFraction: 1, // share of electrical demand actually being met (SystemUpdate._computePowerBudget)
                target: 80.0,
                repairPct: 25, juryRigged: false, destroyed: false,
            },
            // Comms transceiver: range scales with repair level (CommsNav decides what that reveals).
            transceiver: {
                status: 'Warning', active: false,
                count: 1, tier: 1,
                transmitW: 0, rangeLy: 0, drawW: 0,
                repairPct: 25, juryRigged: false, destroyed: false, installed: true,
            },
            // Water maker: not fitted on a new ship — bought from a market, in whatever state it's sold.
            waterMaker: {
                status: 'Normal', active: false,
                count: 1, tier: 1,
                outputLhr: 0, drawW: 0, source: 'none',
                repairPct: 100, juryRigged: false, destroyed: false, installed: false,
            },
            // Drives (logistics.js): both wrecked when you buy her. Stripped for
            // parts they come out (installed false); thrusters are then built new.
            thrusters: {
                status: 'Critical', active: false, count: 1, tier: 1,
                repairPct: 0, juryRigged: false, destroyed: true, installed: true,
            },
            ionDrive: {
                status: 'Critical', active: false, count: 1, tier: 1,
                repairPct: 0, juryRigged: false, destroyed: true, installed: true,
            },
            fuel: {
                level: 10, status: 'Warning',
                capacity: 100, current: 10,
                consumeRateLhr: 0,
            },
            freshWater: {
                level: 10, status: 'Warning',
                capacity: 500, current: 50,
                rationing: false,
                consumeRateLhr: 0,
                depletedHours: 0,
                rationHours: 0,
            },
            blackWater: {
                level: 0, status: 'Normal',
                capacity: 100, current: 0,
                liquidL: 0, solidL: 0,
                residueL: 0, // liquid soaked into the solids, which the water maker can't reclaim (SystemUpdate.settleResidue)
                liquidRateLhr: 0, solidRateLhr: 0, fillRateLhr: 0,
                exposureHours: 0, // how long waste has been spilled in the cabin
                spillLiquidL: 0, spillSolidL: 0, // what the full tank couldn't take, on the cabin floor until cleaned up
            },
            // Food rations live in storage boxes (fabrication.js); this is what
            // the tick works out from them, plus how long the crew have gone hungry.
            food: {
                status: 'Normal',
                rations: 0, eatRatePerDay: 0, daysLeft: Infinity, solidRateLhr: 0,
                starvedHours: 0,
                rationing: false, rationHours: 0, // half a ration a meal; hours underfed, paid back by full meals
            },
        };
    }

    _bindEvents() {
        this._initDashboardLayout();
        document.getElementById('new-game-btn').addEventListener('click',  () => this._promptNewGame());
        document.getElementById('seed-regenerate-btn').addEventListener('click', () => {
            document.getElementById('seed-input').value = this.commsNav.rollSeed();
        });
        document.getElementById('seed-continue-btn').addEventListener('click', () => this._confirmSeedAndShowIntro());
        document.getElementById('intro-continue-btn').addEventListener('click', () => this._startFromIntro());
        document.getElementById('load-game-btn').addEventListener('click', () => this._openLoadScreen());
        document.getElementById('load-screen-close-btn').addEventListener('click', () => this._closeLoadScreen());
        document.getElementById('crew-stat').addEventListener('click',          () => this._openCrewScreen());
        document.getElementById('crew-screen-close-btn').addEventListener('click', () => this._closeCrewScreen());
        document.getElementById('crew-idle-text').addEventListener('click',     () => this._openCrewScreen());
        document.getElementById('crew-idle-dismiss').addEventListener('click',  () => {
            this._crewIdleNoteDismissed = true;
            this._displayCrewIdleNote();
        });
        document.getElementById('comms-nav-btn').addEventListener('click',         () => this._openCommsNavScreen());
        document.getElementById('comms-nav-close-btn').addEventListener('click',   () => this._closeCommsNavScreen());
        document.getElementById('ship-capacity-btn').addEventListener('click',       () => this._openShipCapacityScreen());
        document.getElementById('ship-capacity-close-btn').addEventListener('click', () => this._closeShipCapacityScreen());
        document.getElementById('cargo-btn').addEventListener('click',               () => this._openCargoScreen());
        document.getElementById('cargo-close-btn').addEventListener('click',         () => this._closeCargoScreen());
        document.getElementById('drone-run-close-btn').addEventListener('click',     () => this._closeDroneRunScreen());
        document.getElementById('blackwater-transfer-btn').addEventListener('click', () => {
            const box = this.fabrication.transferTarget();
            if (box) this.fabricationAction('transfer', { boxId: box.id });
        });

        // Remembered so a result message can appear beside the button that caused it.
        document.addEventListener('click', e => {
            const pressed = e.target.closest('button, [role="button"]');
            if (pressed) { this._lastPressed = pressed; this._lastPressedAt = performance.now(); }
        }, true);

        // Fabrication & cargo buttons (Cargo Hold, Work Queue, market supplies)
        // are re-rendered constantly, so one delegated listener handles them.
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-fab-action]');
            if (!btn || btn.disabled) return;
            this.fabricationAction(btn.dataset.fabAction, { boxId: btn.dataset.boxId, key: btn.dataset.key });
        });
        // Propulsion & Logistics buttons (drive cards, drone card, market rows).
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-logi-action]');
            if (!btn || btn.disabled) return;
            this.logisticsAction(btn.dataset.logiAction, {
                key: btn.dataset.key, droneId: btn.dataset.droneId, to: btn.dataset.to,
                holdId: btn.dataset.holdId, qty: btn.dataset.qty, boxId: btn.dataset.boxId,
            });
        });
        // Market rows' "Buy & Store" buttons (into a machine box) — re-rendered like the rest.
        document.addEventListener('click', e => {
            const btn = e.target.closest('.market-store-btn');
            if (!btn || btn.disabled) return;
            this.buyMarketItem(btn.dataset.listingId, 'store');
        });
        document.getElementById('tour-btn').addEventListener('click',                () => { this.tour.setTipsEnabled(true); this.tour.start(); });
        document.getElementById('quit-btn').addEventListener('click',      () => this.quitGame());
        document.getElementById('resume-btn').addEventListener('click',    () => this.togglePause());
        document.getElementById('save-btn').addEventListener('click',      () => this.saveGame());
        document.getElementById('timeline-btn').addEventListener('click',  () => this.timeline.open());
        document.getElementById('export-btn').addEventListener('click',    () => GameState.exportFile(this));
        document.getElementById('main-menu-btn').addEventListener('click', () => this.returnToMainMenu());

        document.getElementById('o2-toggle').addEventListener('click',    () => this.toggleSystem('o2'));
        document.getElementById('co2-toggle').addEventListener('click',   () => this.toggleSystem('co2'));
        document.getElementById('power-toggle').addEventListener('click', () => this.toggleSystem('power'));
        document.getElementById('transceiver-toggle').addEventListener('click', () => this.toggleSystem('transceiver'));
        document.getElementById('watermaker-toggle').addEventListener('click',  () => this.toggleSystem('waterMaker'));

        document.getElementById('o2-repair-btn').addEventListener('click',    () => this.startRepair('o2'));
        document.getElementById('co2-repair-btn').addEventListener('click',   () => this.startRepair('co2'));
        document.getElementById('power-repair-btn').addEventListener('click', () => this.startRepair('power'));
        document.getElementById('transceiver-repair-btn').addEventListener('click', () => this.startRepair('transceiver'));
        document.getElementById('watermaker-repair-btn').addEventListener('click',  () => this.startRepair('waterMaker'));

        document.getElementById('repair-queue-btn').addEventListener('click',     () => this.toggleTaskQueueScreen());

        // "Repair to" chips are re-rendered constantly (cards, Available Repairs,
        // queue rows), so one delegated listener handles them all. A chip with a
        // task id retargets that queued repair; otherwise it picks the level the
        // module's next repair will be ordered to.
        document.addEventListener('click', e => {
            const chip = e.target.closest('.repair-target-chip');
            if (!chip) return;
            const target = Number(chip.dataset.target);
            if (chip.dataset.taskId) this.repairManager.setTaskTarget(chip.dataset.taskId, target);
            else this._repairTargets[chip.dataset.systemKey] = target;
            this.updateDisplay();
        });
        document.getElementById('task-queue-close-btn').addEventListener('click', () => this.toggleTaskQueueScreen());

        document.getElementById('vent-toggle').addEventListener('click',  () => this.toggleVents());

        document.getElementById('water-ration-toggle').addEventListener('click', () => this.toggleWaterRationing());
        document.getElementById('food-ration-toggle').addEventListener('click',  () => this.toggleFoodRationing());
        document.getElementById('blackwater-dump-btn').addEventListener('click', () => this.dumpBlackWater());
        document.getElementById('blackwater-cleanup-btn').addEventListener('click', () => this.cleanUpSpill());

        document.getElementById('o2-target-input').addEventListener('change', e => {
            const v = parseFloat(e.target.value);
            this.systems.o2.target = isNaN(v) ? null : v;
        });
        document.getElementById('co2-target-input').addEventListener('change', e => {
            const v = parseFloat(e.target.value);
            this.systems.co2.target = isNaN(v) ? null : v / 10000; // ppm → %
        });
        document.getElementById('power-target-input').addEventListener('change', e => {
            const v = parseFloat(e.target.value);
            this.systems.power.target = isNaN(v) ? null : v;
        });

        [1, 10, 100, 1000].forEach(s =>
            document.getElementById(`speed-${s}x`).addEventListener('click', () => this.setGameSpeed(s))
        );

        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            // The Timeline sits on top of the pause menu (and of GAME OVER):
            // Escape closes it first.
            if (this.timeline.isOpen()) { this.timeline.close(); return; }
            // So does the Notifications list — without pausing as well.
            if (this.notifications.isOpen()) { this.notifications.close(); return; }
            if (this.gameActive) this.togglePause();
        });
    }

    // ── Ship database loading ───────────────────────────────────────────────

    async _loadShipDatabases() {
        try {
            const [classResp, storyResp, moduleResp, crewResp] = await Promise.all([
                fetch('data/ship_classes.json'),
                fetch('data/story_messages.json'),
                fetch('data/module_specs.json'),
                fetch('data/crew_manifest.json'),
            ]);
            if (classResp.ok) {
                const classDb = await classResp.json();
                this.shipClass = classDb.classes?.find(c => c.id === 'vagrant-mk1') ?? null;
            }
            if (storyResp.ok) {
                this.storyMessages = await storyResp.json();
            }
            if (moduleResp.ok) {
                this.moduleSpecs = await moduleResp.json();
            }
            if (crewResp.ok) {
                const crewDb = await crewResp.json();
                this.crewManifestTemplate = crewDb.crew ?? [];
                this.crewManager.syncRoster();
            }
            this._updateShipIdentityUI();
            this.updateDisplay(); // refresh repair panels now that module_specs.json has landed
        } catch { /* offline / file:// mode — fall back to defaults */ }
    }

    _updateShipIdentityUI() {
        const nameEl  = document.getElementById('ship-name');
        const classEl = document.getElementById('ship-class');
        const regEl   = document.getElementById('ship-reg');
        const imgEl   = document.getElementById('ship-thumb');

        if (nameEl)  nameEl.textContent  = this.shipName;
        if (classEl) classEl.textContent = this.shipClass
            ? `${this.shipClass.name} · ${this.shipClass.manufacturer}`
            : 'Vagrant Mk.I · Pell-Dyne Systems';
        if (regEl)   regEl.textContent   = this.shipRegistration;
        if (imgEl && this.shipClass?.image) imgEl.src = this.shipClass.image;
    }

    // ── Intro screen ────────────────────────────────────────────────────────

    _showIntro() {
        this.launchScreen.style.display = 'none';
        Overlay.show(this.introModal);

        const msg = this.storyMessages?.['new-game'];
        if (msg) this._injectIntroContent(msg);

        const introName  = document.getElementById('intro-ship-name');
        const introClass = document.getElementById('intro-ship-class');
        const introImg   = document.getElementById('intro-ship-img');
        if (introName)  introName.textContent  = this.shipName;
        if (introClass) introClass.textContent = this.shipClass
            ? `${this.shipClass.name} · ${this.shipClass.manufacturer} · Reg. ${this.shipRegistration}`
            : `Vagrant Mk.I · Pell-Dyne Systems · Reg. ${this.shipRegistration}`;
        if (introImg && this.shipClass?.image) introImg.src = this.shipClass.image;
    }

    _injectIntroContent(msg) {
        const headerEl = document.getElementById('intro-header');
        const bodyEl   = document.getElementById('intro-body');
        const contBtn  = document.getElementById('intro-continue-btn');

        if (headerEl && msg.header) {
            headerEl.innerHTML =
                `<div class="intro-year">YEAR ${msg.header.year} — ${msg.header.location}</div>` +
                `<h2 class="intro-title">${msg.header.title}</h2>`;
        }

        if (bodyEl && msg.body) {
            bodyEl.innerHTML = msg.body
                .map(p => `<p${p.class ? ` class="${p.class}"` : ''}>${p.text}</p>`)
                .join('');
        }

        if (contBtn && msg.continueLabel) {
            contBtn.textContent = msg.continueLabel;
        }

        if (msg.background) this.setBackground(msg.background);
    }

    _startFromIntro() {
        Overlay.hide(this.introModal);
        this.startNewGame();
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    // Loops on a native prompt() until a free name is entered or the player cancels.
    async _promptNewGame() {
        let name = prompt('Name your save:');
        while (name !== null) {
            name = name.trim();
            if (!name) { name = prompt('Name your save:'); continue; }
            try {
                const { id } = await GameState.createSave(name);
                this.saveId   = id;
                this.saveName = name;
                this._showSeedScreen();
                return;
            } catch (e) {
                if (e.nameTaken) { name = prompt(e.message + '\nTry a different name:'); continue; }
                alert('Could not create a new save: ' + e.message);
                return;
            }
        }
        // name === null here means the player cancelled — stay on the launch screen.
    }

    _showSeedScreen() {
        document.getElementById('seed-input').value = this.commsNav.rollSeed();
        this.launchScreen.style.display = 'none';
        Overlay.show(this.seedScreen);
    }

    _confirmSeedAndShowIntro() {
        const parsed = parseInt(document.getElementById('seed-input').value, 10);
        this._pendingSeed = Number.isFinite(parsed) && parsed >= 0 ? parsed : this.commsNav.rollSeed();
        Overlay.hide(this.seedScreen);
        this._showIntro();
    }

    startNewGame() {
        this.gameActive             = true;
        this.gamePaused             = false;
        this.gameTime               = 0;
        this.gameSpeed              = 1;
        this.credits                = 1000;
        this.inBreathableAtmosphere = true;
        this.ventsOpen              = false;
        this.systems                = this._defaultSystems();
        this.repairQueue            = [];
        this.cargo                  = Fabrication.defaultCargo();
        this.fabrication.addStarterFood();
        this.fabrication.addStarterBox(); // kept empty for what comes off the wrecked drives
        this.logistics.reset();
        this.moduleResale           = {};
        this._selectedCommsId       = null;
        // One seed drives everything: the sector layout and, on a separate
        // stream, every gameplay roll after it. Seed the RNG before the
        // roster is rolled.
        const seed = this._pendingSeed ?? this.commsNav.rollSeed(); // chosen on the seed screen before the intro
        this._pendingSeed           = null;
        this.rng                    = GameRng.fromSeed(seed);
        this.crewManager.resetRoster();
        this.crew                   = this.crewManager.aliveCount();
        this.commsNav.generate(seed);
        this.notifications.restore([]);

        this._resetPauseMenuUI();
        this._applySpeedUI();
        this._syncTargetInputs();
        this._updateShipIdentityUI();
        this.launchScreen.style.display  = 'none';
        this.gameContainer.style.display = 'block';
        // A new game always opens with every group expanded (a loaded save
        // keeps whatever was last chosen).
        this._collapsedGroups.clear();
        this._saveDashboardLayout();
        this._layoutCards();
        this._playDashboardIntro();
        this._startTimer();
        this._startAutosaveTimer();
        this.updateDisplay();
        this.timeline.resetClock();
        this._saveWithCheckpoint('start'); // persist the freshly-created slot immediately
        this.tour.maybeAutoStart(); // first-time players only — see Tour
    }

    // ── Load screen ─────────────────────────────────────────────────────────

    async _openLoadScreen() {
        this.launchScreen.style.display = 'none';
        Overlay.show(this.loadScreen);
        await this._renderLoadScreen();
    }

    _closeLoadScreen() {
        Overlay.hide(this.loadScreen);
        this.launchScreen.style.display = 'block';
    }

    async _renderLoadScreen() {
        const listEl = document.getElementById('save-list');
        if (!listEl) return;
        listEl.innerHTML = '<li class="task-empty">Loading…</li>'; // clear stale rows from a prior render before re-fetching

        let saves;
        try {
            saves = await GameState.listSaves();
        } catch (e) {
            listEl.innerHTML = '<li class="task-empty">Could not load saves — is server.js running?</li>';
            return;
        }

        if (!saves.length) {
            listEl.innerHTML = '<li class="task-empty">No saved games yet.</li>';
            return;
        }

        listEl.innerHTML = saves.map(s => `
            <li class="save-card" data-save-id="${s.id}">
                <div class="save-info">
                    <div class="save-title">${this._escapeHtml(s.name)}</div>
                    <div class="save-meta">Day ${s.day} &middot; ${s.credits ?? 0} credits &middot; saved ${new Date(s.updatedAt).toLocaleString()}</div>
                </div>
                <div class="save-actions">
                    <button class="save-load-btn" data-save-id="${s.id}">Load</button>
                    <button class="save-delete-btn" data-save-id="${s.id}">Delete</button>
                </div>
            </li>`).join('');

        const byId = new Map(saves.map(s => [String(s.id), s]));
        listEl.querySelectorAll('.save-load-btn').forEach(btn =>
            btn.addEventListener('click', () => this._loadSave(Number(btn.dataset.saveId), byId.get(btn.dataset.saveId)?.name))
        );
        listEl.querySelectorAll('.save-delete-btn').forEach(btn =>
            btn.addEventListener('click', () => this._deleteSave(Number(btn.dataset.saveId)))
        );
    }

    async _deleteSave(id) {
        if (!confirm('Delete this save? This cannot be undone.')) return;
        try {
            await GameState.deleteSave(id);
            this._renderLoadScreen();
        } catch (e) {
            alert('Could not delete save: ' + e.message);
        }
    }

    async _loadSave(saveId, saveName) {
        try {
            await GameState.loadServer(this, saveId);
            this.saveId     = saveId;
            this.saveName   = saveName ?? null;
            this.gameActive = true;
            this.gamePaused = false;
            this._resetPauseMenuUI();
            this._syncBackground();
            this._applySpeedUI();
            this._syncTargetInputs();
            this._updateShipIdentityUI();
            this._closeLoadScreen();
            this.launchScreen.style.display  = 'none';
            this.gameContainer.style.display = 'block';
            this._playDashboardIntro();
            this._startTimer();
            this._startAutosaveTimer();
            this.updateDisplay();
            this.timeline.onGameLoaded();
        } catch (e) { alert('Could not load save: ' + e.message); }
    }

    quitGame() {
        if (confirm('Quit to main menu?')) {
            this._stopTimer();
            this._stopAutosaveTimer();
            this.gameActive = false;
            this.saveId     = null;
            this.saveName   = null;
            this.setBackground('space');
            this.launchScreen.style.display  = 'block';
            this.gameContainer.style.display = 'none';
            Overlay.hide(this.pauseMenu);
        }
    }

    endGame() {
        this._stopTimer();
        this._stopAutosaveTimer();
        this.gameActive = false;
        this.gamePaused = false;

        document.getElementById('resume-btn').style.display = 'none';
        const titleEl = document.getElementById('pause-title');
        titleEl.textContent = 'GAME OVER';
        titleEl.classList.add('game-over-title');
        const subtitleEl = document.getElementById('pause-subtitle');
        subtitleEl.textContent   = 'All crew are dead.';
        subtitleEl.style.display = '';

        Overlay.show(this.pauseMenu);
    }

    // Pause menu can be left mid-"GAME OVER" from a prior session — restore
    // its normal pause appearance before a new/loaded game can show it again.
    _resetPauseMenuUI() {
        document.getElementById('resume-btn').style.display = '';
        const titleEl = document.getElementById('pause-title');
        titleEl.textContent = 'Game Paused';
        titleEl.classList.remove('game-over-title');
        const subtitleEl = document.getElementById('pause-subtitle');
        subtitleEl.textContent   = '';
        subtitleEl.style.display = 'none';
    }

    toggleSystem(name) {
        if (!this.gameActive || this.gamePaused) return;
        if (this.systems[name].destroyed || this.systems[name].installed === false) return;
        this.systems[name].active = !this.systems[name].active;
        this.updateDisplay();
    }

    startRepair(systemKey) {
        if (!this.gameActive || this.gamePaused) return;
        this.repairManager.startRepair(systemKey, this._repairTargets[systemKey]);
        delete this._repairTargets[systemKey];
        this.updateDisplay();
    }

    cancelRepairTask(taskId) {
        this.repairManager.cancelTask(taskId);
        this.updateDisplay();
    }

    reorderRepairQueue(orderedIds) {
        this.repairManager.reorderTasks(orderedIds);
        this.updateDisplay();
    }

    toggleTaskQueueScreen() {
        const isOpen = Overlay.isOpen(this.taskQueueScreen);
        if (isOpen) Overlay.hide(this.taskQueueScreen); else Overlay.show(this.taskQueueScreen);
        if (!isOpen) this._displayRepairQueue();
    }

    toggleVents() {
        if (!this.gameActive || this.gamePaused || !this.inBreathableAtmosphere) return;
        this.ventsOpen = !this.ventsOpen;
        this.updateDisplay();
    }

    // Ration toggle: enabling cuts consumption to the conservative rate but,
    // sustained past a day, starts a slow health drain (CrewManager). Disabling
    // after that grace period has passed rehydrates the crew with one lump
    // draw from the tank rather than gradually — see _canAffordRationReset().
    // Half a ration a meal instead of one. Free either way: the cost is in the
    // crew (slower work, then health after a week), and full meals pay it back.
    toggleFoodRationing() {
        if (!this.gameActive || this.gamePaused) return;
        this.systems.food.rationing = !this.systems.food.rationing;
        this.systemUpdate._updateFood(0); // rates and days left follow at once
        this.updateDisplay();
    }

    toggleWaterRationing() {
        if (!this.gameActive || this.gamePaused) return;
        const fresh = this.systems.freshWater;

        if (fresh.rationing) {
            if (fresh.rationHours >= this.crewManager.WATER_RATION_GRACE_HOURS) {
                if (this._rationResetBlocker()) return; // also greyed out in the UI
                const cost = this._rationResetCostL();
                fresh.current -= cost;
                fresh.level    = (fresh.current / fresh.capacity) * 100;
                // Drunk and washed in: it ends up in the black water tank like any other use.
                this.systems.blackWater.liquidL += cost * this.systemUpdate.blackFromUseFraction();
                this.syncBlackWaterLevel();
            }
            fresh.rationing   = false;
            fresh.rationHours = 0;
        } else {
            fresh.rationing = true;
        }
        this.updateDisplay();
    }

    _rationResetCostL() {
        return this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew;
    }

    // Why coming off rationing (past the grace period) can't happen yet: the
    // tank has to hold the rehydration water, and the black water tank has to
    // have room for it once it's been used.
    _rationResetBlocker() {
        const cost   = this._rationResetCostL();
        const toBlack = cost * this.systemUpdate.blackFromUseFraction();
        const fresh  = this.systems.freshWater;
        if (fresh.current < cost) {
            return `needs ${cost.toFixed(0)} L in the tank (${Math.ceil(cost - fresh.current)} L short)`;
        }
        const room = this.systemUpdate.blackRoomL();
        if (room < toBlack - 1e-9) {
            return `needs ${toBlack.toFixed(0)} L free in the black water tank (${Math.ceil(toBlack - room)} L short)`;
        }
        return null;
    }

    _canAffordRationReset() {
        return !this._rationResetBlocker();
    }

    // Spilled waste: what can be cleaned up now. Each litre goes back into the
    // black water tank along with SPILL_CLEANUP_WATER_PER_L of fresh water used
    // to clean it, so it needs that water and that much room in the tank. As
    // much as can be is cleaned; the rest stays (and keeps exposing the crew).
    cleanUpPlan() {
        const su    = this.systemUpdate;
        const spill = su.spilledL();
        const per   = su.SPILL_CLEANUP_WATER_PER_L;
        const room  = su.blackRoomL();
        const fresh = this.systems.freshWater.current;
        const canL  = Math.max(0, Math.min(spill, room / (1 + per), per > 0 ? fresh / per : spill));
        return { spill, canL, waterL: canL * per, needWaterL: spill * per, needRoomL: spill * (1 + per) };
    }

    cleanUpBlocker() {
        const plan = this.cleanUpPlan();
        if (plan.spill <= 1e-9) return 'Nothing spilled';
        if (plan.canL > 1e-6) return null;
        if (this.systemUpdate.blackRoomL() <= 1e-6) {
            return 'The black water tank is full — make room first (the water maker, moving solids to compost, or a dump)';
        }
        return 'No fresh water to clean up with';
    }

    cleanUpSpill() {
        if (!this.gameActive || this.gamePaused || this.cleanUpBlocker()) return;
        const plan  = this.cleanUpPlan();
        const black = this.systems.blackWater;
        const fresh = this.systems.freshWater;
        const share = plan.canL / plan.spill;
        const liquid = (black.spillLiquidL || 0) * share;
        const solid  = (black.spillSolidL  || 0) * share;
        black.spillLiquidL = Math.max(0, (black.spillLiquidL || 0) - liquid);
        black.spillSolidL  = Math.max(0, (black.spillSolidL  || 0) - solid);
        if (this.systemUpdate.spilledL() < 1e-6) { black.spillLiquidL = 0; black.spillSolidL = 0; }
        fresh.current = Math.max(0, fresh.current - plan.waterL);
        fresh.level   = (fresh.current / fresh.capacity) * 100;
        black.liquidL += liquid + plan.waterL;
        black.solidL  += solid;
        this.syncBlackWaterLevel();
        const left = this.systemUpdate.spilledL();
        this._showSaveStatus(left > 1e-6
            ? `Cleaned up ${plan.canL.toFixed(1)} L — ${left.toFixed(1)} L still spilled`
            : `Spill cleaned up, using ${plan.waterL.toFixed(1)} L of fresh water`,
            left > 1e-6, document.getElementById('blackwater-cleanup-btn'));
        this.updateDisplay();
    }

    // Vent the whole black water tank to space. Nobody dumps half a tank, so
    // there's nothing to ask: everything goes, and the fine is charged.
    dumpBlackWater() {
        if (!this.gameActive || this.gamePaused) return;
        const black = this.systems.blackWater;
        if (black.current <= 0) return;

        black.liquidL  = 0;
        black.solidL   = 0;
        black.residueL = 0;
        this.syncBlackWaterLevel();

        // The fine is charged per dump regardless of size, and can put the account into debt.
        const fine = this.BLACK_WATER_DUMP_FINE;
        this.credits -= fine;
        this._showSaveStatus(`Fined ${fine} credits for dumping waste`, true, document.getElementById('blackwater-dump-btn'));
        this.updateDisplay();
    }

    // Recomputes the black water tank's total and level after liquid/solid
    // changed outside the tick (a dump, solids moved to a storage box). A tank
    // that's no longer full stops backing up, so exposure resets.
    syncBlackWaterLevel() {
        const black = this.systems.blackWater;
        this.systemUpdate.settleResidue(); // solids moved out free the liquid they held
        black.current = black.liquidL + black.solidL + (black.residueL || 0);
        black.level   = (black.current / black.capacity) * 100;
        if (this.systemUpdate.spilledL() <= 1e-9) black.exposureHours = 0;
    }

    // Every fabrication / cargo action the player can take (rules live in Fabrication).
    fabricationAction(action, { boxId, key } = {}) {
        if (!this.gameActive || this.gamePaused) return;
        const fab = this.fabrication;
        const byDrone = this.logistics.tradeMode() === 'drone'; // from the yard: bought goods wait at the port
        const waits = byDrone ? ` — it waits at ${this.logistics.PORT_NAME} for a drone` : '';
        switch (action) {
            case 'buy':
                if (fab.buy(key)) this._showSaveStatus(`Bought 1 ${fab.ITEMS[key].name} for ${fab.ITEMS[key].price} credits${waits}`);
                break;
            case 'emptyBox':
                if (fab.emptyBox(boxId)) this._showSaveStatus('Compost tipped out — the box is empty');
                break;
            case 'fabricate':
                if (fab.queueFabrication(key)) this._showSaveStatus(`${fab.RECIPES[key].name} added to the work queue`);
                break;
            case 'dose':
                fab.dose(boxId);
                break;
            case 'transfer': {
                const moved = fab.transferSolids(boxId);
                if (moved > 0) this._showSaveStatus(`Moved ${moved.toFixed(1)} L of solid waste into a storage box`);
                break;
            }
            case 'seal':
                fab.seal(boxId);
                break;
            case 'sell': {
                if (byDrone) {
                    if (!fab.sellBlocker(boxId)) {
                        fab.sell(boxId);
                        this._showSaveStatus(`Compost away by drone — it's paid for at ${this.logistics.PORT_NAME}`);
                    }
                    break;
                }
                const earned = fab.sell(boxId);
                if (earned > 0) this._showSaveStatus(`Sold compost for ${earned} credits`);
                break;
            }
            case 'buyFood':
                if (fab.buyFood()) this._showSaveStatus(`Bought ${fab.FOOD.caseSize} ${fab.FOOD.name.toLowerCase()} for ${fab.FOOD.price} credits${waits}`);
                break;
            case 'repairStored':
                this.startRepair(`box:${boxId}`);
                return; // startRepair redraws
            case 'swap': {
                const name = fab.moduleName(fab.storedModule(boxId)?.moduleKey);
                if (fab.swap(boxId)) {
                    delete this._repairTargets[`box:${boxId}`];
                    this._showSaveStatus(`${name} fitted from the machine box`);
                }
                break;
            }
            case 'sellModule': {
                const name = fab.moduleName(fab.storedModule(boxId)?.moduleKey);
                if (byDrone) {
                    if (!fab.sellModuleBlocker(boxId)) {
                        fab.sellModule(boxId);
                        this._showSaveStatus(`${name} away by drone — it's paid for at ${this.logistics.PORT_NAME}`);
                    }
                    break;
                }
                const earned = fab.sellModule(boxId);
                if (earned > 0) this._showSaveStatus(`Sold ${name} for ${earned} credits`);
                break;
            }
            default:
                return;
        }
        this.updateDisplay();
    }

    // Buy a market listing (rules live in CommsNav.purchaseBlocker/purchase).
    buyMarketItem(listingId, dest = 'fit') {
        if (!this.gameActive || this.gamePaused) return;
        const listing = (this.market || []).find(l => l.id === listingId);
        const byDrone = this.logistics.tradeMode() === 'drone';
        if (!listing || !this.commsNav.purchase(listingId, dest)) return;
        const where = byDrone ? ` — it waits at ${this.logistics.PORT_NAME} for a drone` : dest === 'store' ? ' — stored in a machine box' : '';
        this._showSaveStatus(`Bought ${listing.name} for ${listing.price} credits${where}`);
        this.updateDisplay();
    }

    togglePause() {
        if (!this.gameActive) return;
        this.gamePaused = !this.gamePaused;
        if (this.gamePaused) Overlay.show(this.pauseMenu); else Overlay.hide(this.pauseMenu);
    }

    saveGame() {
        return this._saveWithCheckpoint('save');
    }

    // Saves the game, then marks the moment on the timeline (timeline.js).
    async _saveWithCheckpoint(kind) {
        try {
            await GameState.saveServer(this);
            this._showSaveStatus('Saved');
        } catch (e) {
            this._showSaveStatus('Save failed — is server.js running?', true);
            return;
        }
        await this.timeline.checkpoint(kind);
    }

    // The Timeline has just put an earlier checkpoint's state onto the game
    // (GameState.restore). Bring everything else in line with it. The game is
    // left paused on the pause menu, so the player resumes when ready. This
    // also revives a game that had ended in GAME OVER.
    afterRewind() {
        this._repairTargets   = {};
        this._selectedCommsId = null;
        this.crew             = this.crewManager.aliveCount();
        this.gameActive       = true;
        this.gamePaused       = true;
        this._resetPauseMenuUI();
        Overlay.show(this.pauseMenu);
        this._applySpeedUI();
        this._syncTargetInputs();
        this._updateShipIdentityUI();
        this._startTimer();
        this._startAutosaveTimer();
        this.updateDisplay();
        this._showSaveStatus('Went back on the timeline');
    }

    async _autosave() {
        try {
            await GameState.saveServer(this);
            this._showSaveStatus('Autosaved');
        } catch (e) {
            this._showSaveStatus('Autosave failed — is server.js running?', true);
        }
    }

    returnToMainMenu() {
        if (confirm('Return to main menu? Unsaved progress will be lost.')) {
            this._stopTimer();
            this._stopAutosaveTimer();
            this.gameActive = false;
            this.saveId     = null;
            this.saveName   = null;
            this.setBackground('space');
            this.launchScreen.style.display  = 'block';
            this.gameContainer.style.display = 'none';
            Overlay.hide(this.pauseMenu);
        }
    }

    setGameSpeed(speed) {
        this.gameSpeed = speed;
        this._applySpeedUI();
    }

    _applySpeedUI() {
        [1, 10, 100, 1000].forEach(s => {
            document.getElementById(`speed-${s}x`).className =
                'speed-btn' + (s === this.gameSpeed ? ' speed-active' : '');
        });
    }

    // ── Timer ───────────────────────────────────────────────────────────────

    _startTimer() {
        this._stopTimer();
        this.timer = setInterval(() => {
            if (this.gamePaused || !this.gameActive) return;
            // A tutorial step or tip on screen holds the clock (without the pause
            // menu, so the controls it points at still work).
            if (this.tour.holdsTime()) return;
            this.gameTime += this.gameSpeed;
            this.systemUpdate.update(this.gameSpeed);
            this.updateDisplay();
            this.tour.checkTips();
            this.timeline.maybeCheckpoint();
        }, 1000);
    }

    _startAutosaveTimer() {
        this._stopAutosaveTimer();
        this.autosaveTimer = setInterval(() => {
            if (!this.gameActive) return;
            this._autosave();
        }, 5 * 60 * 1000); // real-world 5 minutes, independent of game speed
    }

    _stopAutosaveTimer() {
        if (this.autosaveTimer) { clearInterval(this.autosaveTimer); this.autosaveTimer = null; }
    }

    _stopTimer() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    // ── Display ─────────────────────────────────────────────────────────────

    updateDisplay() {
        this.creditsElement.textContent = this.credits;
        this._displayCrew();

        const day      = Math.floor(this.gameTime / 86400) + 1;
        const secInDay = this.gameTime % 86400;
        const hh       = Math.floor(secInDay / 3600);
        const mm       = Math.floor((secInDay % 3600) / 60);
        this.dayElement.textContent   = day;
        this.timerElement.textContent = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');

        this._displayO2();
        this._displayCO2();
        this._displayPower();
        this._displayFuel();
        this._displayFreshWater();
        this._displayFood();
        this._displayBlackWater();
        this._displayTransceiver();
        this._displayWaterMaker();
        this._displayLogistics();
        this._displayShipCapacity();
        this._displayCargo();
        this._renderDroneRunScreen();
        this._displayEnvironment();
        this._displayLocation();
        this._syncBackground();
        this._displayRepairQueue();
        this._layoutCards();
        // Contacts and market access follow the transceiver's live range.
        if (Overlay.isOpen(this.commsNavScreen)) this._renderCommsNavScreen();
        // Anything that changed since the last redraw — a tick or a player action — goes on the list.
        this.notifications?.check();
    }

    // ── Dashboard layout: card groups and fixed-height cards ───────────────
    // Every card has the same fixed height, so a message appearing in one
    // never moves the rest of the dashboard. The part of a card that varies
    // (`.card-details`: rates, projections, notes) is what gets clipped; the
    // headline above it and the controls below it always show. A clipped card
    // offers "More", which lets that one card grow. Groups collapse to each
    // card's headline: its status and coloured gauge. Both choices are viewing
    // preferences, not game state, so they live in localStorage.

    _initDashboardLayout() {
        this.DASHBOARD_LAYOUT_KEY = 'starshipOps.dashboardLayout';
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(this.DASHBOARD_LAYOUT_KEY)) || {}; } catch { /* defaults */ }
        this._collapsedGroups = new Set(Array.isArray(saved.collapsedGroups) ? saved.collapsedGroups : []);
        this._expandedCards   = new Set(Array.isArray(saved.expandedCards)   ? saved.expandedCards   : []);

        document.querySelectorAll('.card-group').forEach(group => {
            group.querySelector('.card-group-header').addEventListener('click', () => {
                const id = group.dataset.group;
                if (this._collapsedGroups.has(id)) this._collapsedGroups.delete(id); else this._collapsedGroups.add(id);
                this._saveDashboardLayout();
                this._layoutCards();
            });
        });
        document.getElementById('expand-all-btn').addEventListener('click', () => {
            this._collapsedGroups.clear();
            this._saveDashboardLayout();
            this._layoutCards();
        });
        document.getElementById('collapse-all-btn').addEventListener('click', () => {
            document.querySelectorAll('.card-group').forEach(g => this._collapsedGroups.add(g.dataset.group));
            this._saveDashboardLayout();
            this._layoutCards();
        });

        // A "More" toggle under each card's details; shown only when it's needed.
        document.querySelectorAll('.system-card').forEach(card => {
            const btn = document.createElement('button');
            btn.className = 'card-more-btn';
            btn.type = 'button';
            btn.style.display = 'none';
            btn.addEventListener('click', () => {
                if (this._expandedCards.has(card.id)) this._expandedCards.delete(card.id); else this._expandedCards.add(card.id);
                this._saveDashboardLayout();
                this._layoutCards();
            });
            card.appendChild(btn);
        });
        this._layoutCards();
    }

    _saveDashboardLayout() {
        try {
            localStorage.setItem(this.DASHBOARD_LAYOUT_KEY, JSON.stringify({
                collapsedGroups: [...this._collapsedGroups], expandedCards: [...this._expandedCards],
            }));
        } catch { /* not remembered this time */ }
    }

    // Runs after every redraw: applies collapsed/expanded state, works out
    // which cards are clipping something, and sums up each group's status.
    _layoutCards() {
        if (!this._collapsedGroups) return;
        document.querySelectorAll('.card-group').forEach(group => {
            const collapsed = this._collapsedGroups.has(group.dataset.group);
            group.classList.toggle('collapsed', collapsed);
            group.querySelector('.card-group-header').setAttribute('aria-expanded', String(!collapsed));

            let critical = 0, warning = 0;
            group.querySelectorAll('.system-card').forEach(card => {
                if (card.classList.contains('card-critical')) critical++;
                else if (card.classList.contains('card-warning')) warning++;

                const expanded = this._expandedCards.has(card.id);
                card.classList.toggle('card-expanded', expanded);
                const btn = card.querySelector('.card-more-btn');
                if (collapsed) { btn.style.display = 'none'; return; }
                // Measured with the toggle in place, so showing it can't make the
                // details fit again and flip it back off next time.
                const details = [...card.querySelectorAll('.card-details')].filter(d => d.getClientRects().length);
                btn.style.display = '';
                const clipped = !expanded && details.some(d => d.scrollHeight > d.clientHeight + 1);
                details.forEach(d => d.classList.toggle('card-details-clipped', clipped));
                btn.style.display = (clipped || expanded) ? '' : 'none';
                btn.textContent   = expanded ? 'Less ▴' : 'More ▾';
                btn.setAttribute('aria-expanded', String(expanded));
            });

            const statusEl = group.querySelector('.card-group-status');
            statusEl.textContent = critical ? `${critical} critical` : warning ? `${warning} warning` : 'Nominal';
            statusEl.className = 'card-group-status ' + (critical ? 'badge-critical' : warning ? 'badge-warning' : 'badge-normal');
        });
    }

    // Suffix for a powered device's ON/OFF line when the ship can't supply it.
    _powerNote(sys) {
        if (!sys.active) return '';
        const fraction = this.systems.power.powerFraction ?? 1;
        if (fraction <= 0) return ' &mdash; <span class="no-power">NO POWER</span>';
        if (fraction < 1)  return ` &mdash; <span class="no-power">LOW POWER ${Math.round(fraction * 100)}%</span>`;
        return '';
    }

    // Header readout of where the ship currently is and what kind of place that is.
    _displayLocation() {
        const nameEl = document.getElementById('location-name');
        const typeEl = document.getElementById('location-type');
        if (!nameEl || !typeEl) return;

        const home = this.commsNav.home();
        if (!home) { nameEl.textContent = '—'; typeEl.textContent = ''; return; }

        // Where on the planet — Harlow's yard, Port Carrow, or in the air between
        // them — with the planet on the line below, to keep the header narrow.
        nameEl.textContent = this.logistics.isFlying()
            ? this.logistics.locationLabel()
            : this.logistics.berthName();
        typeEl.textContent = `${home.name} · ${this.commsNav.locationTypeLabel(home)}` +
            (this.logistics.atPort() ? ' · Spaceport' : this.logistics.isFlying() ? '' : ' · Salvage yard') +
            (this.inBreathableAtmosphere ? ' · Breathable atmosphere' : '');
    }

    // ── Propulsion & Logistics cards (logistics.js) ─────────────────────────
    // Each card's parts (badge, headline, details, controls) are filled in
    // from here; the drone card's rows vary with how many drones there are.
    // Buttons carry data-logi-action, handled by one delegated listener
    // (_bindEvents).

    _displayLogistics() {
        this._displayDrive('thrusters');
        this._displayDrive('ionDrive');
        this._displayDrones();
    }

    // A blocked button's tooltip says why; an enabled one's says what it does.
    _logiBtn(action, label, blocker, data = {}, tip = '') {
        const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${this._escapeHtml(String(v))}"`).join('');
        const title = blocker ?? tip;
        return `<button class="repair-btn" data-logi-action="${action}"${attrs}${blocker ? ' disabled' : ''}${title ? ` title="${this._escapeHtml(title)}"` : ''}>${label}</button>`;
    }

    _displayDrive(key) {
        const prefix = key === 'thrusters' ? 'thrusters' : 'iondrive';
        if (!document.getElementById(`card-${prefix}`)) return;
        const lg   = this.logistics;
        const sys  = this.systems[key];
        const name = lg.DRIVE_NAMES[key];
        const strip = this.repairQueue.find(t => t.kind === 'strip' && t.recipeKey === key);
        const build = this.repairQueue.find(t => t.kind === 'fabricate' && t.recipeKey === key);
        const fitted = sys && sys.installed !== false;

        let badge, value, label, status, details = '', controls = '', blocker = null;
        if (fitted && sys.destroyed) {
            badge = 'WRECKED'; value = 'Wrecked'; label = 'beyond repair'; status = 'Critical';
            const yields = Object.entries(lg.STRIP[key].yields).map(([k, n]) => `${n} ${this.fabrication.ITEMS[k].name.toLowerCase()}`).join(', ');
            details = `<p>Seized and burnt out — not worth repairing. Stripping it for parts recovers <strong>${yields}</strong>
                       and takes ${this._fmtRepairHours(lg.STRIP[key].hours)} of engineering work. The parts need an empty storage box.</p>`;
            if (strip) {
                details += `<p>Being stripped: ${strip.hoursRemaining.toFixed(1)}h of work left (${strip.status === 'in-progress' ? 'in progress' : 'queued'}).</p>`;
            } else {
                blocker  = lg.stripBlocker(key);
                controls = this._logiBtn('strip', 'Strip for Parts', blocker, { key },
                    'Engineers take the wreck apart in the Work Queue; the usable parts go into a storage box');
            }
        } else if (!fitted) {
            badge = 'NOT FITTED'; value = '—'; label = 'not fitted'; status = 'Warning'; // a missing drive is never "fine"
            if (key === 'thrusters') {
                const recipe = this.fabrication.RECIPES.thrusters;
                details = build
                    ? `<p>Being built: ${build.hoursRemaining.toFixed(1)}h of work left (${build.status === 'in-progress' ? 'in progress' : 'queued'}).</p>`
                    : `<p>New thrusters are fabricated in the Work Queue from ${this.fabrication.componentsLabel(recipe)}
                       (${this._fmtRepairHours(recipe.hours)} of work). They lift her across to ${lg.PORT_NAME}.</p>`;
            } else {
                details = `<p>An ion drive is what gets her off the planet and between the stars. Salvaged ones turn up at
                           ${lg.PORT_NAME}'s yards — get her there first.</p>`;
            }
        } else if (key === 'thrusters') {
            badge = lg.isFlying() ? 'FLYING' : 'READY'; status = 'Normal';
            value = lg.isFlying() ? `${Math.round(lg.game.flight.hoursLeft * 60)} min` : `${lg.hopFuelL()} L`;
            label = lg.isFlying() ? `to ${lg.berthName(lg.game.flight.to)}` : 'fuel per hop';
            const to = lg.berth() === 'port' ? 'yard' : 'port';
            details = `<p>A hop between ${lg.YARD_NAME} and ${lg.PORT_NAME} is ${lg.YARD_TO_PORT_KM} km: about
                       ${Math.round(lg.hopHours() * 60)} minutes and ${lg.hopFuelL()} L of fuel. Fuel aboard: ${this.systems.fuel.current.toFixed(1)} L.</p>`;
            if (!lg.isFlying()) {
                blocker  = lg.flyBlocker(to);
                controls = this._logiBtn('fly', `Fly to ${lg.berthName(to)}`, blocker, { to },
                    `Lift off on the atmospheric thrusters: about ${Math.round(lg.hopHours() * 60)} minutes and ${lg.hopFuelL()} L of fuel`);
            }
        } else {
            badge = 'FITTED'; value = 'Fitted'; label = 'ion drive'; status = 'Normal';
            details = '<p>Ready for space — travel between systems comes later.</p>';
        }

        this._fillCardHead(prefix, badge, status, value, label);
        this._setHtmlIfChanged(document.getElementById(`${prefix}-details`), details);
        this._setHtmlIfChanged(document.getElementById(`${prefix}-controls`),
            (blocker ? `<span class="market-blocker">${this._escapeHtml(blocker)}</span>` : '') + controls);
        this._setCardStatus(`card-${prefix}`, status, !fitted);
    }

    _fillCardHead(prefix, badge, status, value, label) {
        const badgeEl = document.getElementById(`${prefix}-badge`);
        badgeEl.textContent = badge;
        badgeEl.className   = `status-badge ${this._badgeClass(status)}`;
        document.getElementById(`${prefix}-value`).textContent = value;
        document.getElementById(`${prefix}-label`).textContent = label;
    }

    _badgeClass(status) {
        return status === 'Critical' ? 'badge-critical' : status === 'Warning' ? 'badge-warning' : 'badge-normal';
    }

    _displayDrones() {
        if (!document.getElementById('card-drone')) return;
        const lg = this.logistics;
        const drones = lg.drones();
        const held = this.portHold ?? [];
        const heldMass = lg.holdMassKg();

        let badge = 'NONE', status = 'Warning', value = '0', label = 'drones', rows = '';
        if (drones.length) {
            const home = drones.filter(d => lg.isHome(d)).length;
            value  = String(drones.length);
            label  = `${drones.length === 1 ? 'drone' : 'drones'} · ${home} home`;
            const anyReady = drones.some(d => !lg.launchBlocker(d, { forSale: true })); // could fly, planned or not
            badge  = lg.atPort() ? 'AT PORT' : anyReady ? 'READY' : home ? 'GROUNDED' : 'AWAY';
            status = lg.atPort() || anyReady || home < drones.length ? 'Normal' : 'Warning';
            rows = drones.map(d => this._droneRowHtml(d)).join('');
        }

        const holdLine = held.length
            ? `<p class="logi-hold">Waiting at ${lg.PORT_NAME}: ${held.map(e => this._escapeHtml(lg.entryLabel(e))).join(', ')} (${heldMass.toFixed(0)} kg).</p>`
            : `<p class="logi-hold">Nothing waiting at ${lg.PORT_NAME}.</p>`;
        const intro = drones.length ? '' : `<p>Nothing bought reaches ${lg.YARD_NAME} by itself. A transfer drone (${lg.DRONE_PRICE} cr on the
            market) ferries up to ${lg.droneSpec('payloadKg')} kg a run between here and ${lg.PORT_NAME}, ${lg.YARD_TO_PORT_KM} km away.</p>`;
        const docks = this.droneDocks ?? 0;
        const dockLine = `<p class="logi-docks">Drone docks: ${docks}${docks ? '' : ' — fabricate one in the Work Queue to charge a drone'}.</p>`;

        this._fillCardHead('drone', badge, status, value, label);
        this._setHtmlIfChanged(document.getElementById('drone-details'),
            `${intro}${rows ? `<ul class="drone-list">${rows}</ul>` : ''}${holdLine}${dockLine}`);
        this._setCardStatus('card-drone', status);
    }

    _droneRowHtml(d) {
        const lg = this.logistics;
        const cap = lg.droneSpec('batteryWh');
        const chargePct = Math.round(100 * (d.chargeWh ?? 0) / cap);
        const stateText = {
            arriving:  `Flying over from ${lg.PORT_NAME} — ${this._fmtHrs(d.hoursLeft)}`,
            outbound:  `Heading to ${lg.PORT_NAME} — ${this._fmtHrs(d.hoursLeft + lg.droneLegHours())} round trip left`,
            returning: `On its way back — ${this._fmtHrs(d.hoursLeft)}`,
            parked:    'Parked outside — not charging',
            stowed:    'Stowed aboard — not charging',
            docked:    (d.chargeWh ?? 0) >= cap - 1e-6 ? 'Docked — fully charged' : this._droneChargingText(d),
        }[d.state] ?? d.state;
        const carrying = [...(d.cargoOut ?? []), ...(d.cargoIn ?? [])];
        const load = carrying.length ? ` · carrying ${carrying.map(e => this._escapeHtml(lg.entryLabel(e))).join(', ')}` : '';
        const unit = lg.unitKey(d);
        const task = this.repairQueue.find(t => t.systemKey === unit);

        const id = { 'drone-id': d.id };
        const planned = lg.plan(d);
        const goingOut = lg.planOut(d).map(o => {
            const box = this.fabrication._box(o.boxId);
            return o.kind === 'module' && box?.module ? this.fabrication.moduleName(box.module.moduleKey) : 'compost';
        });
        const planLine = (planned.length || goingOut.length) && lg.isHome(d)
            ? (goingOut.length ? `<div class="drone-meta">Selling: ${this._escapeHtml(goingOut.join(', '))}
               (${lg.planOutMassKg(d).toFixed(0)} / ${lg.droneSpec('payloadKg')} kg)</div>` : '') +
              (planned.length ? `<div class="drone-meta">Planned: ${planned.map(p => this._escapeHtml(lg.planItemLabel(lg._holdEntry(p.holdId), p.qty))).join(', ')}
               (${lg.planMassKg(d).toFixed(0)} / ${lg.droneSpec('payloadKg')} kg)</div>` : '')
            : '';
        let actions = '';
        if (lg.isHome(d)) {
            if (!lg.atPort()) {
                actions += this._logiBtn('planRun', 'Plan Run', null, id,
                    `Choose what this drone brings back from the port, up to ${lg.droneSpec('payloadKg')} kg`);
                actions += this._logiBtn('launch', 'Send to Port', lg.launchBlocker(d), id,
                    `Fly to ${lg.PORT_NAME} and back (about ${this._fmtHrs(2 * lg.droneLegHours())}), bringing what's planned`);
            }
            if (d.state !== 'docked') actions += this._logiBtn('dock', 'Dock', lg.dockBlocker(d), id,
                'Put it on a drone dock aboard, where it charges from spare generator power');
            if (d.state !== 'stowed') actions += this._logiBtn('stow', 'Stow', lg.stowBlocker(d), id,
                'Pack it away aboard: it counts toward the ship\'s mass and space, and doesn\'t charge');
            if (d.state !== 'parked') actions += this._logiBtn('park', 'Park Outside', lg.parkBlocker(d), id,
                'Set it down on the ground outside: frees its mass and space aboard, but it can\'t charge there, and the ship can\'t fly until it\'s back aboard');
            if (!task && this.repairManager.canRepair(unit)) actions += this._logiBtn('repairDrone', 'Repair', null, id,
                'Add its repair to the Work Queue');
            // Only a docked drone charges, but the switch can be set at any time.
            actions += `<button class="repair-btn drone-battery-btn${d.chargeFromBattery ? ' btn-on' : ''}" data-logi-action="batteryCharge" data-drone-id="${d.id}"
                title="When spare generator power isn't enough, also charge from the ship's battery (never below ${this.systemUpdate.DOCK_BATTERY_FLOOR_PCT}%)">Charge from Battery: ${d.chargeFromBattery ? 'ON' : 'OFF'}</button>`;
        }
        const why = lg.isHome(d) && !lg.atPort() ? lg.launchBlocker(d) : null;
        return `
            <li class="drone-row" data-drone-id="${d.id}">
                <div class="drone-title">${lg.droneLabel(d)} &middot; charge ${chargePct}% &middot; condition ${Math.round(d.repairPct ?? 100)}%${task ? ' · repair queued' : ''}</div>
                <div class="task-progress-track"><div class="task-progress-fill" style="width:${Math.min(100, chargePct)}%"></div></div>
                <div class="drone-meta">${stateText}${load}</div>
                ${planLine}
                ${why ? `<div class="market-blocker">${this._escapeHtml(why)}</div>` : ''}
                <div class="drone-actions">${actions}</div>
            </li>`;
    }

    // ── Plan Run screen: what a drone brings back from the port hold ────────

    _openDroneRunScreen(droneId) {
        this._planDroneId = droneId;
        Overlay.show(this.droneRunScreen);
        this._renderDroneRunScreen();
    }

    _closeDroneRunScreen() {
        if (Overlay.isOpen(this.droneRunScreen)) Overlay.hide(this.droneRunScreen);
    }

    _renderDroneRunScreen() {
        const bodyEl = document.getElementById('drone-run-body');
        if (!bodyEl || !Overlay.isOpen(this.droneRunScreen)) return;
        const lg = this.logistics;
        const d  = lg.drone(this._planDroneId);
        if (!d) { this._closeDroneRunScreen(); return; }
        const payload = lg.droneSpec('payloadKg');
        const mass    = lg.planMassKg(d);
        const id      = { 'drone-id': d.id };
        const kg      = n => `${Number(n.toFixed(1))} kg`;
        document.getElementById('drone-run-title').textContent = `${lg.droneLabel(d)} — Plan Run`;

        const planned = lg.plan(d).map(p => {
            const entry = lg._holdEntry(p.holdId);
            if (!entry) return '';
            const { field, unitKg } = lg._entryUnit(entry);
            const data = { ...id, 'hold-id': p.holdId };
            const less = field && p.qty > 1 ? this._logiBtn('planRemove', '&minus;1', null, { ...data, qty: 1 }, 'Take one off the plan') : '';
            return `
                <li class="task-card task-card-static" data-plan-hold-id="${p.holdId}">
                    <div class="task-info">
                        <div class="task-title">${this._escapeHtml(lg.planItemLabel(entry, p.qty))}</div>
                        <div class="task-meta">${kg(unitKg * p.qty)}</div>
                    </div>
                    <div class="cargo-box-actions">${less}${this._logiBtn('planRemove', 'Remove', null, { ...data, qty: 'all' }, 'Leave it at the port')}</div>
                </li>`;
        }).join('');

        const waiting = (this.portHold ?? []).map(entry => {
            const free = lg.availableQty(entry.id);
            const { field, unitKg } = lg._entryUnit(entry);
            const data = { ...id, 'hold-id': entry.id };
            const fit  = lg.planMaxFit(d, entry.id);
            const onOthers = lg.plannedQty(entry.id, d) > 0 ? ' · some is planned on another drone' : '';
            let buttons;
            if (field) {
                buttons = this._logiBtn('planAdd', '+1', lg.planAddBlocker(d, entry.id, 1), { ...data, qty: 1 }, `Add one (${kg(unitKg)})`);
                // "All that fits" only when that's more than one.
                if (fit > 1) {
                    buttons += this._logiBtn('planAdd', `+${fit} (all that fits)`, null, { ...data, qty: 'max' },
                        `Add as many as fit in what's left of the ${payload} kg`);
                }
            } else {
                buttons = this._logiBtn('planAdd', 'Add', lg.planAddBlocker(d, entry.id, 1), { ...data, qty: 1 }, `Add it to the run (${kg(unitKg)})`);
            }
            const tooHeavy = unitKg > payload ? ` · too heavy for any drone` : '';
            return `
                <li class="task-card task-card-static" data-hold-id="${entry.id}">
                    <div class="task-info">
                        <div class="task-title">${free > 0
                            ? this._escapeHtml(lg.planItemLabel(entry, free)) + (free < lg.entryQty(entry) ? ` <span class="task-meta">(of ${this._escapeHtml(lg.entryLabel(entry))})</span>` : '')
                            : this._escapeHtml(lg.entryLabel(entry))}</div>
                        <div class="task-meta">${field ? `${kg(unitKg)} each` : kg(unitKg)}${onOthers}${tooHeavy}</div>
                    </div>
                    <div class="cargo-box-actions">${free > 0 ? buttons : '<span class="task-meta">all planned</span>'}</div>
                </li>`;
        }).join('');

        // Going out: stored modules and finished compost, sold when it lands.
        // A module going out frees its machine box for one coming back.
        const fab = this.fabrication;
        const outMass = lg.planOutMassKg(d);
        const outgoing = lg.outCandidates().map(o => {
            const box = fab._box(o.boxId);
            const by  = lg.outPlannedBy(o.boxId);
            const data = { ...id, 'box-id': o.boxId };
            const isModule = o.kind === 'module';
            const label = isModule
                ? `${fab.moduleName(box.module.moduleKey)} (${Math.round(box.module.repairPct ?? 100)}%)`
                : `${box.fillL.toFixed(1)} L of compost`;
            const mass  = isModule ? fab.moduleMassKg(box.module) : box.fillL * fab.BOX.contentDensityKgPerL;
            const value = isModule ? fab.moduleSaleValue(box.module) : fab.salePrice(box);
            const repairing = isModule && this.repairQueue.some(t => t.systemKey === `box:${box.id}`)
                ? ' · its queued repair is dropped when it goes' : '';
            const button = by === d
                ? this._logiBtn('planOutRemove', 'Remove', null, data, 'Keep it aboard')
                : by ? '<span class="task-meta">going on another drone</span>'
                : this._logiBtn('planOutAdd', 'Add', lg.planOutAddBlocker(d, o.boxId), data,
                    isModule ? `Take it to the port and sell it; its machine box is free for something coming back`
                             : `Take it to the port and sell it (as much as fits in what's left of the ${payload} kg)`);
            return `
                <li class="task-card task-card-static" data-out-box-id="${o.boxId}">
                    <div class="task-info">
                        <div class="task-title">${this._escapeHtml(label)} <span class="task-meta">— ${this._escapeHtml(fab.boxLabel(box))}</span></div>
                        <div class="task-meta">${kg(mass)} · sells for about ${value} cr${repairing}</div>
                    </div>
                    <div class="cargo-box-actions">${button}</div>
                </li>`;
        }).join('');

        const bar = (cls, label, kgNow) => `
            <div class="drone-run-weight">
                <div class="${cls}"><strong>${kg(kgNow)}</strong> of ${payload} kg ${label}</div>
                <div class="task-progress-track"><div class="task-progress-fill" style="width:${Math.min(100, (kgNow / payload) * 100).toFixed(1)}%"></div></div>
            </div>`;
        const launchBlocker = lg.launchBlocker(d);
        const html = `
            <h3 class="overlay-section-title">Taking to the port to sell</h3>
            ${bar('drone-run-out-weight-label', 'going out', outMass)}
            <ul class="overlay-list" id="drone-run-outgoing">${outgoing || '<li class="task-empty">Nothing aboard to sell — stored modules and finished compost show here.</li>'}</ul>
            <h3 class="overlay-section-title">Bringing back</h3>
            ${bar('drone-run-weight-label', 'coming back', mass)}
            <ul class="overlay-list" id="drone-run-planned">${planned || '<li class="task-empty">Nothing yet — add what you want from below.</li>'}</ul>
            <h3 class="overlay-section-title">Waiting at ${lg.PORT_NAME}</h3>
            <ul class="overlay-list" id="drone-run-waiting">${waiting || '<li class="task-empty">Nothing is waiting — buy from the market in Comms &amp; Nav first.</li>'}</ul>
            <div class="drone-run-footer">
                ${lg.plan(d).length || lg.planOut(d).length ? this._logiBtn('planClear', 'Clear Plan', null, id, 'Take everything off the plan, both ways') : ''}
                ${this._logiBtn('launch', 'Send to Port', launchBlocker, id,
                    `Fly to ${lg.PORT_NAME} and back (about ${this._fmtHrs(2 * lg.droneLegHours())}), selling what goes out and bringing back what's planned`)}
            </div>
            ${launchBlocker ? `<div class="market-blocker">${this._escapeHtml(launchBlocker)}</div>` : ''}`;
        this._setHtmlIfChanged(bodyEl, html);
    }

    // What a docked drone that isn't full is charging from.
    _droneChargingText(d) {
        const p = this.systems.power;
        const dockW = p.dockW ?? 0, fromBattery = p.dockBatteryW ?? 0;
        if (dockW <= 0) {
            if (!d.chargeFromBattery) return 'Docked — no spare generator power to charge it';
            return `Docked — no spare generator power, and the battery is at its ${this.systemUpdate.DOCK_BATTERY_FLOOR_PCT}% floor`;
        }
        return `Docked — charging at ${Math.round(dockW)} W${fromBattery > 0.5 ? ` (${Math.round(fromBattery)} W from the battery)` : ''}`;
    }

    // Every Propulsion & Logistics action the player can take (rules live in Logistics).
    logisticsAction(action, { key, droneId, to, holdId, qty, boxId } = {}) {
        if (!this.gameActive || this.gamePaused) return;
        const lg = this.logistics;
        switch (action) {
            case 'strip':
                if (lg.queueStrip(key)) this._showSaveStatus(`Stripping the ${lg.DRIVE_NAMES[key].toLowerCase()} added to the work queue`);
                break;
            case 'fly':
                if (lg.fly(to)) this._showSaveStatus(`Lifting off for ${lg.berthName(to)} — ${lg.hopFuelL()} L of fuel`);
                break;
            case 'launch':
                if (lg.launch(droneId)) {
                    this._closeDroneRunScreen();
                    this._showSaveStatus(`Drone away to ${lg.PORT_NAME}`);
                }
                break;
            case 'planRun':
                this._openDroneRunScreen(droneId);
                return;
            case 'planAdd':    lg.planAdd(droneId, holdId, qty === 'max' ? 'max' : Number(qty) || 1); break;
            case 'planRemove': lg.planRemove(droneId, holdId, qty === 'all' ? 'all' : Number(qty) || 1); break;
            case 'planClear':  lg.planClear(droneId); break;
            case 'planOutAdd':    lg.planOutAdd(droneId, boxId); break;
            case 'planOutRemove': lg.planOutRemove(droneId, boxId); break;
            case 'dock':  lg.setDroneBerth(droneId, 'docked'); break;
            case 'batteryCharge': lg.toggleBatteryCharge(droneId); break;
            case 'stow':  lg.setDroneBerth(droneId, 'stowed'); break;
            case 'park':  lg.setDroneBerth(droneId, 'parked'); break;
            case 'repairDrone':
                this.startRepair(`drone:${droneId}`);
                return; // startRepair redraws
            case 'buyDrone':
                if (lg.buyDrone()) this._showSaveStatus(lg.atPort() ? `Bought a transfer drone for ${lg.DRONE_PRICE} credits` : `Bought a transfer drone — it's flying itself over from ${lg.PORT_NAME}`);
                break;
            case 'buyFuel':
                if (lg.buyFuel()) this._showSaveStatus(`Bought ${lg.FUEL.lotL} L of fuel for ${lg.fuelLotPrice()} credits${lg.tradeMode() === 'drone' ? ' — it waits at the port' : ''}`);
                break;
            default:
                return;
        }
        this.updateDisplay();
    }

    _displayO2() {
        const sys = this.systems.o2;

        document.getElementById('o2-level').textContent       = sys.pct.toFixed(2) + '%';
        document.getElementById('o2-indicator').style.left    = Math.min(100, (sys.pct / 25) * 100) + '%';
        document.getElementById('o2-consumption').textContent = '−' + sys.consumptionLhr.toFixed(1) + ' L/hr';
        document.getElementById('o2-generation').textContent  = sys.generationLhr.toFixed(1) + ' L/hr';

        // Vent row
        const ventRow = document.getElementById('o2-vent-row');
        if (sys.ventLhr !== 0) {
            ventRow.style.display = '';
            document.getElementById('o2-vent').textContent =
                (sys.ventLhr >= 0 ? '+' : '') + sys.ventLhr.toFixed(1) + ' L/hr';
        } else {
            ventRow.style.display = 'none';
        }

        const netEl = document.getElementById('o2-rate');
        netEl.textContent = (sys.netLhr >= 0 ? '+' : '') + sys.netLhr.toFixed(1) + ' L/hr';
        netEl.className   = 'rate-value ' + (sys.netLhr < 0 ? 'rate-neg' : 'rate-pos-good');

        document.getElementById('o2-projections').innerHTML = this._o2Projections(sys);

        this._setBadge('o2-status-badge', sys.status);
        document.getElementById('o2-status').innerHTML =
            'Generator: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>' + this._powerNote(sys);
        const btn = document.getElementById('o2-toggle');
        btn.textContent = sys.active ? 'Disable Generator' : 'Enable Generator';
        btn.className   = 'toggle-btn ' + (sys.active ? 'btn-on' : 'btn-off');
        btn.disabled     = !!sys.destroyed;
        this._setCardStatus('card-o2', sys.status);

        this._displayRepairPanel('o2', 'o2');
    }

    _displayCO2() {
        const sys = this.systems.co2;
        const ppm = sys.pct * 10000;

        document.getElementById('co2-level').textContent       = Math.round(ppm) + ' ppm';
        document.getElementById('co2-indicator').style.left    = Math.min(100, (ppm / 10000) * 100) + '%';
        document.getElementById('co2-production').textContent  = '+' + sys.productionLhr.toFixed(1) + ' L/hr';
        document.getElementById('co2-scrubbing').textContent   = '−' + sys.removalLhr.toFixed(1) + ' L/hr';

        // Vent row — shows removal rate (positive = removing CO2)
        const ventRow = document.getElementById('co2-vent-row');
        if (sys.ventLhr !== 0) {
            ventRow.style.display = '';
            document.getElementById('co2-vent').textContent =
                '−' + sys.ventLhr.toFixed(1) + ' L/hr';
        } else {
            ventRow.style.display = 'none';
        }

        const netEl = document.getElementById('co2-rate');
        netEl.textContent = (sys.netLhr >= 0 ? '+' : '') + sys.netLhr.toFixed(1) + ' L/hr';
        netEl.className   = 'rate-value ' + (sys.netLhr > 0 ? 'rate-pos-bad' : 'rate-neg-good');

        document.getElementById('co2-projections').innerHTML = this._co2Projections(sys);

        this._setBadge('co2-status-badge', sys.status);
        document.getElementById('co2-status').innerHTML =
            'Scrubber: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>' + this._powerNote(sys);
        const btn = document.getElementById('co2-toggle');
        btn.textContent = sys.active ? 'Disable Scrubber' : 'Enable Scrubber';
        btn.className   = 'toggle-btn ' + (sys.active ? 'btn-on' : 'btn-off');
        btn.disabled     = !!sys.destroyed;
        this._setCardStatus('card-co2', sys.status);

        this._displayRepairPanel('co2', 'co2');
    }

    _displayPower() {
        const sys = this.systems.power;
        document.getElementById('power-level').textContent    = Math.round(sys.level) + '%';
        document.getElementById('power-wh').textContent       = Math.round(sys.current);
        document.getElementById('power-indicator').style.left = sys.level.toFixed(1) + '%';

        const genEl = document.getElementById('power-gen-output');
        genEl.textContent = sys.genOutputW.toFixed(2) + ' W';
        genEl.className   = 'rate-value ' + (sys.genOutputW > 0 ? 'rate-pos-good' : '');

        document.getElementById('power-o2-draw').textContent  = sys.o2DrawW  > 0 ? '−' + sys.o2DrawW.toFixed(2)  + ' W' : '0.00 W';
        document.getElementById('power-co2-draw').textContent = sys.co2DrawW > 0 ? '−' + sys.co2DrawW.toFixed(2) + ' W' : '0.00 W';
        const otherDrawW = sys.otherDrawW ?? 0;
        document.getElementById('power-other-draw').textContent = otherDrawW > 0 ? '−' + otherDrawW.toFixed(2) + ' W' : '0.00 W';

        // Shown only while something switched on isn't getting the power it needs.
        const shortRow = document.getElementById('power-shortfall-row');
        const fraction = sys.powerFraction ?? 1;
        if (fraction < 1 && (sys.demandW ?? 0) > 0) {
            shortRow.style.display = '';
            document.getElementById('power-shortfall').textContent =
                fraction <= 0 ? 'NO POWER — systems offline' : `Brownout — systems at ${Math.round(fraction * 100)}%`;
        } else {
            shortRow.style.display = 'none';
        }

        const netEl = document.getElementById('power-rate');
        netEl.textContent = (sys.netWhr >= 0 ? '+' : '') + sys.netWhr.toFixed(0) + ' Wh/hr';
        netEl.className   = 'rate-value ' + (sys.netWhr < 0 ? 'rate-neg' : sys.netWhr > 0 ? 'rate-pos-good' : '');

        this._setBadge('power-status-badge', sys.status);
        const genRunning = sys.active && this.systems.fuel.current > 0;
        document.getElementById('power-status').innerHTML =
            'Generator: <strong>' + (genRunning ? 'RUNNING' : sys.active ? 'NO FUEL' : 'OFF') + '</strong>';
        const btn = document.getElementById('power-toggle');
        btn.textContent = sys.active ? 'Disable Generator' : 'Enable Generator';
        btn.className   = 'toggle-btn ' + (sys.active ? 'btn-on' : 'btn-off');
        btn.disabled     = !!sys.destroyed;
        this._setCardStatus('card-power', sys.status);

        this._displayRepairPanel('power', 'power');
    }

    _displayFuel() {
        const sys = this.systems.fuel;
        document.getElementById('fuel-level').textContent    = sys.current.toFixed(2) + ' L';
        document.getElementById('fuel-indicator').style.left = ((sys.current / sys.capacity) * 100).toFixed(1) + '%';
        document.getElementById('fuel-rate').textContent     = sys.consumeRateLhr.toFixed(3) + ' L/hr';

        const rtEl = document.getElementById('fuel-runtime');
        if (sys.consumeRateLhr > 0) {
            const hrs = sys.current / sys.consumeRateLhr;
            rtEl.textContent = hrs >= 240 ? Math.round(hrs / 24) + ' days' : Math.round(hrs) + ' hrs';
        } else {
            rtEl.textContent = '—';
        }

        this._setBadge('fuel-status-badge', sys.status);
        this._setCardStatus('card-fuel', sys.status);
    }

    _displayFreshWater() {
        const sys = this.systems.freshWater;
        document.getElementById('freshwater-level').textContent    = sys.current.toFixed(2) + ' L';
        document.getElementById('freshwater-capacity').textContent = sys.capacity;
        document.getElementById('freshwater-indicator').style.left = Math.min(100, sys.level).toFixed(1) + '%';
        document.getElementById('freshwater-rate').textContent     = '−' + sys.consumeRateLhr.toFixed(3) + ' L/hr';

        const maker     = this.systems.waterMaker;
        const makerLhr  = maker.installed ? (maker.outputLhr ?? 0) : 0;
        const makerRow  = document.getElementById('freshwater-maker-row');
        makerRow.style.display = maker.installed ? '' : 'none';
        document.getElementById('freshwater-maker').textContent = '+' + makerLhr.toFixed(3) + ' L/hr';
        document.getElementById('freshwater-info').textContent = maker.installed
            ? 'Topped up by the water maker'
            : 'No water maker fitted — buy one from the local market';

        const netDrainLhr = sys.consumeRateLhr - makerLhr;
        const rtEl = document.getElementById('freshwater-runtime');
        if (sys.current <= 0 && netDrainLhr > 0) {
            rtEl.textContent = 'EMPTY';
        } else if (netDrainLhr > 0) {
            const hrs = sys.current / netDrainLhr;
            rtEl.textContent = hrs >= 240 ? Math.round(hrs / 24) + ' days' : Math.round(hrs) + ' hrs';
        } else if (makerLhr > 0) {
            rtEl.textContent = 'Not draining';
        } else {
            rtEl.textContent = '—';
        }

        this._setBadge('freshwater-status-badge', sys.status);
        document.getElementById('freshwater-mode-status').innerHTML =
            'Rationing: <strong>' + (sys.rationing ? 'ON' : 'OFF') + '</strong>';

        const toggleBtn = document.getElementById('water-ration-toggle');
        const graceHours = this.crewManager.WATER_RATION_GRACE_HOURS;
        const pastGrace  = sys.rationing && sys.rationHours >= graceHours;
        const canAffordReset = this._canAffordRationReset();

        toggleBtn.textContent = sys.rationing ? 'Disable Rationing' : 'Enable Rationing';
        toggleBtn.className   = 'toggle-btn ' + (sys.rationing ? 'btn-on' : 'btn-off');
        toggleBtn.disabled    = pastGrace && !canAffordReset;
        toggleBtn.title       = (pastGrace && !canAffordReset)
            ? `Can't come off rationing yet — it ${this._rationResetBlocker()}`
            : '';

        const timerRow = document.getElementById('freshwater-ration-timer-row');
        const timerEl  = document.getElementById('freshwater-ration-timer');
        if (sys.rationing) {
            timerRow.style.display = '';
            const remaining = graceHours - sys.rationHours;
            if (remaining > 0) {
                timerEl.textContent = this._fmtHrs(remaining);
                timerEl.className   = 'rate-value';
            } else {
                timerEl.textContent = 'ACTIVE';
                timerEl.className   = 'rate-value rate-neg';
            }
        } else {
            timerRow.style.display = 'none';
        }

        // After the grace period, coming off rationing costs a one-off
        // rehydration draw — say so on the card (and how far short the tank
        // is) rather than leaving a dead button with only a hover tooltip.
        const resetRow = document.getElementById('freshwater-reset-row');
        const resetEl  = document.getElementById('freshwater-reset');
        if (pastGrace) {
            const cost = this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew;
            resetRow.style.display = '';
            resetEl.textContent = canAffordReset
                ? `uses ${cost.toFixed(0)} L to rehydrate`
                : this._rationResetBlocker();
            resetEl.className = 'rate-value ' + (canAffordReset ? '' : 'rate-neg');
        } else {
            resetRow.style.display = 'none';
        }

        this._displayRationPreview(pastGrace);
        this._setCardStatus('card-freshwater', sys.status);
    }

    // While rationing is on: what full-rate use would be against what the
    // water maker is producing right now, so the player can judge whether
    // coming off is sustainable before doing it.
    _displayRationPreview(pastGrace) {
        const sys     = this.systems.freshWater;
        const maker   = this.systems.waterMaker;
        const boxEl   = document.getElementById('freshwater-preview');
        if (!boxEl) return;

        // The full-rate figure is always on the card for reference; the rest
        // of the preview only while rationing is on.
        const useLhr   = (this.systemUpdate.WATER_NORMAL_L_PER_CREW_DAY * this.crew) / 24;
        document.getElementById('freshwater-preview-use').textContent = '−' + useLhr.toFixed(3) + ' L/hr';
        if (!sys.rationing) { boxEl.style.display = 'none'; return; }
        boxEl.style.display = '';

        const makerLhr = maker.installed ? (maker.outputLhr ?? 0) : 0;
        const netLhr   = makerLhr - useLhr;
        const cost     = pastGrace ? this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew : 0;
        const leftL    = Math.max(0, sys.current - cost); // what the tank holds once the rehydration draw is taken

        const makerEl = document.getElementById('freshwater-preview-maker');
        makerEl.textContent = !maker.installed ? 'none fitted'
            : !maker.active ? 'switched off'
            : '+' + makerLhr.toFixed(3) + ' L/hr';
        makerEl.className = 'rate-value' + (makerLhr > 0 ? ' rate-pos-good' : '');

        const netEl = document.getElementById('freshwater-preview-net');
        netEl.textContent = (netLhr >= 0 ? '+' : '−') + Math.abs(netLhr).toFixed(3) + ' L/hr';
        netEl.className   = 'rate-value ' + (netLhr >= 0 ? 'rate-pos-good' : 'rate-neg');

        const verdictEl = document.getElementById('freshwater-preview-verdict');
        if (netLhr >= 0) {
            verdictEl.textContent = 'Sustainable — the water maker covers full use.';
            verdictEl.className   = 'ration-preview-verdict verdict-good';
        } else {
            verdictEl.textContent = leftL > 0
                ? `Not sustainable — the tank would run dry in ${this._fmtHrs(leftL / -netLhr)}.`
                : 'Not sustainable — and the tank would be empty straight away.';
            verdictEl.className   = 'ration-preview-verdict verdict-bad';
        }
    }

    // Food Stores card. Rations are read live from the food boxes; the eating
    // rate and the starvation clock come from the last tick (SystemUpdate._updateFood).
    _displayFood() {
        if (!document.getElementById('card-food')) return;
        const food    = this.systems.food;
        const fab     = this.fabrication;
        const rations = fab.rationsAboard();
        const nBoxes  = fab.foodBoxes().length;
        const perMeal = food.rationing ? this.systemUpdate.FOOD_RATION_PER_MEAL : 1;
        const perDay  = this.systemUpdate.MEAL_HOURS.length * perMeal * this.crew;
        const units   = n => (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(1)); // whole or half rations

        document.getElementById('food-rations').textContent = units(rations);
        document.getElementById('food-boxes').textContent   = `${nBoxes} box${nBoxes === 1 ? '' : 'es'}`;
        document.getElementById('food-rate').textContent    = '−' + units(perDay) + ' rations/day';
        const nextMeal = food.nextMealIn ?? this.systemUpdate._nextMealIn(this.gameTime);
        document.getElementById('food-next-meal').textContent =
            `in ${this._fmtHrs(nextMeal / 3600)} (${units(perMeal * this.crew)} ration${perMeal * this.crew === 1 ? '' : 's'})`;
        document.getElementById('food-room').textContent    = Math.floor(fab.foodRoom()) + ' rations';

        const rtEl = document.getElementById('food-runtime');
        if (rations <= 0) rtEl.textContent = perDay > 0 ? 'EMPTY' : '—';
        else if (perDay <= 0) rtEl.textContent = '—';
        else {
            const days = rations / perDay;
            rtEl.textContent = days >= 2 ? `${days.toFixed(1)} days` : `${Math.round(days * 24)} hrs`;
        }

        const starvingRow = document.getElementById('food-starving-row');
        const starved = food.starvedHours ?? 0;
        starvingRow.style.display = starved > 0 ? '' : 'none';
        if (starved > 0) {
            const grace = this.crewManager.FOOD_GRACE_HOURS;
            document.getElementById('food-starving').textContent = starved < grace
                ? `No food for ${Math.floor(starved)}h — health suffers after ${grace}h`
                : `Starving — no food for ${Math.floor(starved)}h`;
        }

        // Underfeeding: slower work at once, health only after a week on rations.
        const cm = this.crewManager;
        const underfed = food.rationHours ?? 0;
        document.getElementById('food-underfed-row').style.display = underfed > 0 ? '' : 'none';
        if (underfed > 0) {
            const slower = Math.round((cm.FOOD_RATION_WORK_FACTOR - 1) * 100);
            const el = document.getElementById('food-underfed');
            if (!food.rationing) {
                el.textContent = `recovering — ${this._fmtHrs(underfed / this.systemUpdate.FOOD_REFEED_RATE)} of full meals to go (${slower}% slower work)`;
                el.className = 'rate-value';
            } else if (underfed < cm.FOOD_RATION_GRACE_HOURS) {
                el.textContent = `${slower}% slower work; health suffers in ${this._fmtHrs(cm.FOOD_RATION_GRACE_HOURS - underfed)}`;
                el.className = 'rate-value';
            } else {
                el.textContent = `${slower}% slower work, and wearing health down`;
                el.className = 'rate-value rate-neg';
            }
        }
        document.getElementById('food-ration-status').innerHTML =
            'Rationing: <strong>' + (food.rationing ? 'ON' : 'OFF') + '</strong>';
        const rationBtn = document.getElementById('food-ration-toggle');
        rationBtn.textContent = food.rationing ? 'Disable Rationing' : 'Enable Rationing';
        rationBtn.className   = 'toggle-btn ' + (food.rationing ? 'btn-on' : 'btn-off');

        this._setBadge('food-status-badge', food.status);
        this._setCardStatus('card-food', food.status);
    }

    _displayBlackWater() {
        const sys = this.systems.blackWater;
        document.getElementById('blackwater-level').textContent    = sys.current.toFixed(2) + ' L';
        document.getElementById('blackwater-indicator').style.left = Math.min(100, sys.level).toFixed(1) + '%';
        document.getElementById('blackwater-liquid').textContent   = sys.liquidL.toFixed(2) + ' L';
        document.getElementById('blackwater-solid').textContent    = sys.solidL.toFixed(2) + ' L';
        const reclaimLhr = sys.reclaimRateLhr ?? 0;
        document.getElementById('blackwater-reclaim-row').style.display = this.systems.waterMaker.installed ? '' : 'none';
        document.getElementById('blackwater-reclaim').textContent  = '−' + reclaimLhr.toFixed(3) + ' L/hr';

        const residueL = sys.residueL ?? 0;
        document.getElementById('blackwater-residue-row').style.display = (this.systems.waterMaker.installed || residueL > 0) ? '' : 'none';
        document.getElementById('blackwater-residue').textContent = residueL.toFixed(2) + ' L';

        // Explains a reclaim figure that's lower than the maker's output: it can
        // only take liquid, and the liquid has run out.
        const maker    = this.systems.waterMaker;
        const solidsEl = document.getElementById('blackwater-solids-note');
        const leftL    = sys.solidL + residueL;
        if (maker.installed && maker.active && sys.reclaimStarved && leftL > 0.05) {
            solidsEl.style.display = '';
            const what = residueL > 0.05
                ? `${leftL.toFixed(1)} L is solid matter and the liquid soaked into it`
                : `${leftL.toFixed(1)} L is solid matter`;
            solidsEl.textContent = sys.liquidL < 0.05
                ? `All the free liquid has been reclaimed. The remaining ${what}, which the water maker can't process — move the solids to a compost box and the liquid they held can be reclaimed.`
                : `The water maker is reclaiming liquid as fast as it arrives. The other ${what}, which it can't process — move the solids to a compost box and the liquid they held can be reclaimed.`;
        } else {
            solidsEl.style.display = 'none';
        }

        // Solids go into whichever compost box is still taking them.
        const box = this.fabrication.transferTarget();
        const transferBtn = document.getElementById('blackwater-transfer-btn');
        const canMove = !!box && sys.solidL >= this.fabrication.MIN_TRANSFER_L;
        transferBtn.disabled = !canMove;
        transferBtn.title = !box ? 'No storage box is set up for solid waste — see the Cargo Hold'
                          : !canMove ? 'No solid waste in the tank' : '';

        const rateEl = document.getElementById('blackwater-rate');
        rateEl.textContent = (sys.fillRateLhr >= 0 ? '+' : '−') + Math.abs(sys.fillRateLhr).toFixed(3) + ' L/hr';
        rateEl.className   = 'rate-value' + (sys.fillRateLhr < 0 ? ' rate-neg-good' : '');

        this._setBadge('blackwater-status-badge', sys.status);
        document.getElementById('blackwater-status').innerHTML =
            'Tank: <strong>' + Math.round(sys.level) + '%</strong> full';
        const dumpBtn = document.getElementById('blackwater-dump-btn');
        dumpBtn.disabled = sys.current <= 0;
        document.getElementById('blackwater-fine').textContent = this.BLACK_WATER_DUMP_FINE;

        // A spill: what it is, what cleaning it up takes, and the button (in
        // place of the tank reading, which the gauge already shows).
        const spill       = this.cleanUpPlan();
        const exposureRow = document.getElementById('blackwater-exposure-row');
        const cleanBtn    = document.getElementById('blackwater-cleanup-btn');
        const statusEl    = document.getElementById('blackwater-status');
        if (spill.spill > 1e-6) {
            exposureRow.style.display = '';
            document.getElementById('blackwater-exposure').textContent =
                `${spill.spill.toFixed(1)} L spilled in the cabin for ${this._fmtHrs(sys.exposureHours ?? 0)} — crew exposed. ` +
                `Cleaning up uses ${spill.needWaterL.toFixed(1)} L of fresh water and needs ${spill.needRoomL.toFixed(1)} L free in the tank.`;
            const blocker = this.cleanUpBlocker();
            cleanBtn.style.display = '';
            statusEl.style.display = 'none';
            cleanBtn.disabled = !!blocker;
            cleanBtn.title = blocker ?? `Puts the spill back in the tank, with ${spill.needWaterL.toFixed(1)} L of fresh water used to clean up`;
        } else {
            exposureRow.style.display = 'none';
            cleanBtn.style.display = 'none';
            statusEl.style.display = '';
        }
        this._setCardStatus('card-blackwater', sys.status);
    }

    _displayTransceiver() {
        const sys = this.systems.transceiver;
        if (!document.getElementById('card-transceiver')) return; // markup not present yet

        const range = sys.rangeLy ?? 0;
        const rated = sys.ratedRangeLy ?? 2;
        document.getElementById('transceiver-level').textContent    = range.toFixed(2) + ' ly';
        document.getElementById('transceiver-indicator').style.left = Math.min(100, rated > 0 ? (range / rated) * 100 : 0).toFixed(1) + '%';
        document.getElementById('transceiver-transmit').textContent =
            (sys.transmitW ?? 0).toFixed(2) + ' W of ' + (sys.ratedTransmitW ?? 2).toFixed(2) + ' W';
        document.getElementById('transceiver-draw').textContent     = (sys.drawW ?? 0) > 0 ? '−' + sys.drawW.toFixed(2) + ' W' : '0.00 W';

        const localEl = document.getElementById('transceiver-local');
        const local   = this.commsNav.hasLocalDetails();
        localEl.textContent = local ? 'IN RANGE' : `Out of range (needs ${this.commsNav.LOCAL_DETAILS_RANGE_LY} ly)`;
        localEl.className   = 'rate-value ' + (local ? 'rate-pos-good' : 'rate-neg');
        document.getElementById('transceiver-contacts').textContent =
            Math.max(0, this.commsNav.visibleLocations().length - 1); // not counting where you already are

        this._setBadge('transceiver-status-badge', sys.status);
        document.getElementById('transceiver-status').innerHTML =
            'Transceiver: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>' + this._powerNote(sys);
        const btn = document.getElementById('transceiver-toggle');
        btn.textContent = sys.active ? 'Disable Transceiver' : 'Enable Transceiver';
        btn.className   = 'toggle-btn ' + (sys.active ? 'btn-on' : 'btn-off');
        btn.disabled    = !!sys.destroyed;
        this._setCardStatus('card-transceiver', sys.status);

        this._displayRepairPanel('transceiver', 'transceiver');
    }

    _displayWaterMaker() {
        const sys = this.systems.waterMaker;
        if (!document.getElementById('card-watermaker')) return; // markup not present yet

        const installed = sys.installed !== false;
        document.getElementById('watermaker-fitted').style.display  = installed ? '' : 'none';
        document.getElementById('watermaker-missing').style.display = installed ? 'none' : '';
        document.getElementById('watermaker-level').textContent = installed ? (sys.outputLhr ?? 0).toFixed(2) + ' L/hr' : '—';
        document.getElementById('watermaker-level-label').textContent = installed ? 'output' : 'not fitted';

        const badge = document.getElementById('watermaker-status-badge');
        if (installed) {
            this._setBadge('watermaker-status-badge', sys.status);
        } else {
            badge.textContent = 'NOT FITTED';
            badge.className   = 'status-badge badge-warning';
        }
        this._setCardStatus('card-watermaker', installed ? sys.status : 'Normal', !installed);
        if (!installed) return;

        // Black water is always used first; air only makes up what it can't.
        const fromBlack = sys.fromBlackLhr ?? 0, fromAir = sys.fromAirLhr ?? 0;
        const made = fromBlack + fromAir;
        const blackPct = made > 0 ? Math.round(fromBlack / made * 100) : 0;
        const sourceLabel = made > 0
            ? (fromAir <= 0 ? 'Reclaiming black water'
              : fromBlack <= 0 ? 'Condensing from outside air (low power)'
              : 'Black water, topped up from outside air')
            : { full: 'Fresh tank full', none: sys.active ? 'Nothing to process' : '—' }[sys.source] ?? '—';
        document.getElementById('watermaker-rated').textContent  = (sys.ratedLhr ?? 0).toFixed(2) + ' L/hr';
        document.getElementById('watermaker-source').textContent = sourceLabel;
        document.getElementById('watermaker-split').style.display = made > 0 ? '' : 'none';
        document.getElementById('watermaker-split-black').style.width = blackPct + '%';
        document.getElementById('watermaker-split-air').style.width   = (100 - blackPct) + '%';
        document.getElementById('watermaker-split-black-pct').textContent = blackPct + '%';
        document.getElementById('watermaker-split-air-pct').textContent   = (100 - blackPct) + '%';
        document.getElementById('watermaker-draw').textContent   = (sys.drawW ?? 0) > 0 ? '−' + sys.drawW.toFixed(2) + ' W' : '0.00 W';

        document.getElementById('watermaker-status').innerHTML =
            'Water maker: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>' + this._powerNote(sys);
        const btn = document.getElementById('watermaker-toggle');
        btn.textContent = sys.active ? 'Disable Water Maker' : 'Enable Water Maker';
        btn.className   = 'toggle-btn ' + (sys.active ? 'btn-on' : 'btn-off');
        btn.disabled    = !!sys.destroyed;

        this._displayRepairPanel('waterMaker', 'watermaker');
    }

    // ── Ship capacity (mass / volume) ──────────────────────────────────────
    // Buying supplies and fabricating boxes are refused when they wouldn't fit
    // (Fabrication.spaceBlocker). Decoupled from the atmosphere physics, which
    // uses its own fixed cabin volume in system_update.js.

    // Fixed mass/volume for hardware that isn't tiered via module_specs.json
    // (battery has no count of its own, tanks aren't tiered at all). Contents
    // density approximates how much heavier a tank gets as it fills.
    _tankSpecs() {
        return {
            fuel:       { label: 'Fuel Tank',        massKg: 9,  volumeM3: 0.15, contentDensityKgPerL: 0.8 },
            freshWater: { label: 'Fresh Water Tank', massKg: 32, volumeM3: 0.62, contentDensityKgPerL: 1.0 },
            blackWater: { label: 'Black Water Tank',  massKg: 11, volumeM3: 0.15, contentDensityKgPerL: 1.0 },
        };
    }

    _batterySpec() {
        return { label: 'Battery', massKg: 28, volumeM3: 0.25 };
    }

    // Mirrors SystemUpdate._moduleField — duplicated rather than reached into,
    // since that one's underscore-prefixed as internal to that class.
    _moduleField(moduleType, tier, field, fallback) {
        const modules = this.moduleSpecs && this.moduleSpecs.modules;
        const spec = modules && modules[moduleType] && modules[moduleType][String(tier)];
        return spec && spec[field] != null ? spec[field] : fallback;
    }

    _computeShipCapacity() {
        const unladenMassKg = this.shipClass?.specs?.massKg ?? 0;
        const maxMassKg     = unladenMassKg + (this.shipClass?.specs?.cargoCapacityKg ?? 0);
        const totalVolumeM3 = this.shipClass?.defaultSystems?.volumeM3 ?? 0;

        const items = [];

        [['o2', 'o2Generator', 'O₂ Generator'], ['co2', 'co2Scrubber', 'CO₂ Scrubber'], ['power', 'generator', 'Power Generator'],
         ['transceiver', 'transceiver', 'Transceiver'], ['waterMaker', 'waterMaker', 'Water Maker']]
            .filter(([sysKey]) => this.systems[sysKey].installed !== false)
            .forEach(([sysKey, moduleType, label]) => {
                const sys      = this.systems[sysKey];
                const massEach = this._moduleField(moduleType, sys.tier, 'massKg', 0);
                const volEach  = this._moduleField(moduleType, sys.tier, 'volumeM3', 0);
                items.push({ label, count: sys.count, massKg: massEach * sys.count, volumeM3: volEach * sys.count });
            });

        const battery = this._batterySpec();
        items.push({ label: battery.label, count: 1, massKg: battery.massKg, volumeM3: battery.volumeM3 });

        [['thrusters', 'Atmospheric Thrusters'], ['ionDrive', 'Ion Drive']]
            .filter(([key]) => this.systems[key] && this.systems[key].installed !== false)
            .forEach(([key, label]) => {
                const sys = this.systems[key];
                items.push({
                    label: label + (sys.destroyed ? ' (wrecked)' : ''), count: 1,
                    massKg: this._moduleField(key, sys.tier ?? 1, 'massKg', 0), volumeM3: this._moduleField(key, sys.tier ?? 1, 'volumeM3', 0),
                });
            });

        items.push(...this.fabrication.capacityItems());
        items.push(...this.logistics.capacityItems());

        const tankSpecs = this._tankSpecs();
        [['fuel', tankSpecs.fuel], ['freshWater', tankSpecs.freshWater], ['blackWater', tankSpecs.blackWater]]
            .forEach(([sysKey, spec]) => {
                const sys = this.systems[sysKey];
                items.push({
                    label: spec.label, count: 1,
                    massKg: spec.massKg + sys.current * spec.contentDensityKgPerL,
                    volumeM3: spec.volumeM3,
                });
            });

        const modulesMassKg   = items.reduce((sum, i) => sum + i.massKg, 0);
        const modulesVolumeM3 = items.reduce((sum, i) => sum + i.volumeM3, 0);
        const totalMassKg     = unladenMassKg + modulesMassKg;

        return {
            unladenMassKg, maxMassKg, totalMassKg,
            freeMassKg: maxMassKg - totalMassKg,
            totalVolumeM3, usedVolumeM3: modulesVolumeM3,
            freeVolumeM3: totalVolumeM3 - modulesVolumeM3,
            items,
        };
    }

    _displayShipCapacity() {
        if (!document.getElementById('capacity-breakdown')) return; // markup not present yet

        const imgEl   = document.getElementById('capacity-ship-img');
        const nameEl  = document.getElementById('capacity-ship-name');
        const classEl = document.getElementById('capacity-ship-class');
        if (imgEl && this.shipClass?.image) imgEl.src = this.shipClass.image;
        if (nameEl)  nameEl.textContent  = this.shipName;
        if (classEl) classEl.textContent = this.shipClass ? this.shipClass.name : 'Vagrant Mk.I';

        const cap = this._computeShipCapacity();

        const massPct = cap.maxMassKg > 0 ? (cap.totalMassKg / cap.maxMassKg) * 100 : 0;
        document.getElementById('capacity-mass-level').textContent    = Math.round(cap.totalMassKg) + ' kg';
        document.getElementById('capacity-mass-max').textContent      = Math.round(cap.maxMassKg);
        document.getElementById('capacity-mass-indicator').style.left = Math.min(100, massPct).toFixed(1) + '%';
        document.getElementById('capacity-mass-free').textContent     = Math.round(cap.freeMassKg) + ' kg';

        const volPct = cap.totalVolumeM3 > 0 ? (cap.usedVolumeM3 / cap.totalVolumeM3) * 100 : 0;
        document.getElementById('capacity-volume-level').textContent    = cap.usedVolumeM3.toFixed(2) + ' m³';
        document.getElementById('capacity-volume-max').textContent      = cap.totalVolumeM3;
        document.getElementById('capacity-volume-indicator').style.left = Math.min(100, volPct).toFixed(1) + '%';
        document.getElementById('capacity-volume-free').textContent     = cap.freeVolumeM3.toFixed(2) + ' m³';

        const rows = [
            `<li class="task-card task-card-static">
                <div class="task-info">
                    <div class="task-title">Hull (unladen)</div>
                    <div class="task-meta">${Math.round(cap.unladenMassKg)} kg</div>
                </div>
            </li>`,
            ...cap.items.map(item => `
                <li class="task-card task-card-static">
                    <div class="task-info">
                        <div class="task-title">${item.label}${item.count > 1 ? ` &times;${item.count}` : ''}</div>
                        <div class="task-meta">${item.massKg.toFixed(1)} kg &middot; ${item.volumeM3.toFixed(2)} m&#179;</div>
                    </div>
                </li>`),
        ];
        document.getElementById('capacity-breakdown').innerHTML = rows.join('');
    }

    _displayEnvironment() {
        const dot     = document.getElementById('atmos-dot');
        const label   = document.getElementById('atmos-label');
        const ventBtn = document.getElementById('vent-toggle');
        const ventLbl = document.getElementById('vent-status-label');

        dot.className     = this.inBreathableAtmosphere ? 'env-dot breathable' : 'env-dot';
        label.textContent = this.inBreathableAtmosphere ? 'BREATHABLE ATMOSPHERE' : 'VACUUM / SPACE';

        ventBtn.disabled    = !this.inBreathableAtmosphere;
        ventLbl.textContent = this.ventsOpen ? 'Vents: OPEN' : 'Vents: CLOSED';
        ventBtn.textContent = this.ventsOpen ? 'Close Vents' : 'Open Vents';
        ventBtn.className   = 'toggle-btn ' + (this.ventsOpen ? 'btn-on' : 'btn-off');
    }

    // ── Crew UI ─────────────────────────────────────────────────────────────

    _displayCrew() {
        const alive = (this.crewManifest && this.crewManifest.length)
            ? this.crewManager.aliveCount()
            : this.crew;
        this.crewElement.textContent = alive;

        const worst = this.crewManager.worstStatus();
        this.crewStatElement.className = 'stat stat-clickable' +
            (worst === 'normal' ? '' : (worst === 'warning' ? ' stat-warning' : ' stat-critical'));

        this._displayCrewIdleNote();

        if (Overlay.isOpen(this.crewScreen) && !this._editingCrewId) {
            this._renderCrewScreen();
        }
    }

    // Speech bubble under the Crew counter: someone on a long roster is on
    // shift with nothing to do, and says so. Purely informational — the
    // schedule is still the player's call. Dismissing it hides it until the
    // situation has cleared and come back.
    _displayCrewIdleNote() {
        const noteEl = document.getElementById('crew-idle-note');
        if (!noteEl) return;

        const idle = this.gameActive ? this.crewManager.idleOverScheduled() : [];
        if (!idle.length) {
            this._crewIdleNoteDismissed = false;
            noteEl.style.display = 'none';
            return;
        }
        if (this._crewIdleNoteDismissed) { noteEl.style.display = 'none'; return; }

        const member = idle[0];
        const number = this.crewManifest.indexOf(member) + 1;
        const hours  = +this.crewManager.dutyHours(member).toFixed(1);
        const others = idle.length > 1 ? ` (and ${idle.length - 1} more)` : '';
        document.getElementById('crew-idle-text').textContent =
            `Crew ${number}${others}: “I'm rostered ${hours} hours a day and there's nothing for me to do.”`;
        if (noteEl.style.display === 'none') {
            noteEl.style.display = '';
            Anchor.attach(noteEl, '#crew-stat'); // floats under the Crew counter, wherever it is
        }
    }

    _openCrewScreen() {
        Overlay.show(this.crewScreen);
        this._renderCrewScreen();
    }

    _closeCrewScreen() {
        Overlay.hide(this.crewScreen);
        this._editingCrewId = null;
    }

    _crewStatusLabel(status) {
        switch (status) {
            case 'dead':         return 'Deceased';
            case 'unconscious':  return 'Unconscious';
            case 'critical':     return 'Critical';
            case 'warning':      return 'Warning';
            default:             return 'Normal';
        }
    }

    _healthBarClass(status) {
        switch (status) {
            case 'dead':        return 'health-dead';
            case 'unconscious': return 'health-critical';
            case 'critical':    return 'health-major';
            case 'warning':     return 'health-warning';
            default:            return 'health-good';
        }
    }

    _fmtHour(h) {
        const hh = Math.floor(h);
        const mm = Math.round((h - hh) * 60);
        return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }

    // Surfaces exactly what CrewManager.update(dt) is currently penalising health
    // for, and by how much, so the player can tell which system to fix next
    // instead of guessing from the health bar alone.
    _renderCrewImpactPanel() {
        const panelEl = document.getElementById('crew-impact-panel');
        if (!panelEl) return;

        const items = this.crewManager.healthImpactBreakdown();
        if (!items.length) {
            panelEl.innerHTML = '<p class="task-empty">No negative health factors currently active.</p>';
            return;
        }

        const rows = items
            .slice()
            .sort((a, b) => b.ratePctPerHr - a.ratePctPerHr)
            .map(item => `
                <div class="rate-row">
                    <span class="rate-label">${item.label}</span>
                    <span class="rate-value rate-neg">&#8722;${item.ratePctPerHr.toFixed(2)}%/hr</span>
                </div>`).join('');

        panelEl.innerHTML = `<div class="rate-panel">${rows}</div>`;
    }

    _renderCrewScreen() {
        const listEl = document.getElementById('crew-list');
        if (!listEl) return;
        this._renderCrewImpactPanel();
        const roster = this.crewManifest || [];

        if (!roster.length) {
            listEl.innerHTML = '<li class="task-empty">No crew aboard.</li>';
            return;
        }

        listEl.innerHTML = roster.map((member, idx) => {
            const status     = this.crewManager.statusFor(member);
            const editing    = this._editingCrewId === member.id;
            const shiftsText = member.shifts.map(s => `${this._fmtHour(s.startHour)}&ndash;${this._fmtHour(s.endHour)}`).join(', ') || 'No shifts';
            const duty       = this.crewManager.dutySummary(member);

            return `
                <li class="crew-card" data-crew-id="${member.id}">
                    <div class="crew-info">
                        <div class="crew-title">Crew ${idx + 1} <span class="crew-status-label">${this._crewStatusLabel(status)}</span></div>
                        <div class="task-progress-track crew-health-track"><div class="task-progress-fill ${this._healthBarClass(status)}" style="width:${Math.max(0, member.health)}%"></div></div>
                        <div class="task-meta">${member.health.toFixed(0)}% health</div>
                        ${editing ? this._renderShiftEditor(member) : `<div class="task-meta">Shifts: ${shiftsText}</div>`}
                        ${member.dead ? '' : `<div class="task-meta crew-duty crew-duty-${duty.level}">${duty.text}</div>`}
                    </div>
                    ${editing ? '' : `<button class="crew-edit-btn" data-crew-id="${member.id}" ${member.dead ? 'disabled' : ''}>Edit Shifts</button>`}
                </li>`;
        }).join('');

        listEl.querySelectorAll('.crew-edit-btn').forEach(btn =>
            btn.addEventListener('click', () => { this._editingCrewId = btn.dataset.crewId; this._renderCrewScreen(); })
        );
        if (this._editingCrewId) this._bindShiftEditor(listEl);
    }

    _renderShiftEditor(member) {
        const rows = member.shifts.map((s, i) => `
            <div class="shift-edit-row" data-shift-idx="${i}">
                <input type="number" class="shift-input shift-start" min="0" max="24" step="0.5" value="${s.startHour}">
                <span>&ndash;</span>
                <input type="number" class="shift-input shift-end" min="0" max="24" step="0.5" value="${s.endHour}">
                <button class="shift-remove-btn" data-shift-idx="${i}">&times;</button>
            </div>`).join('');

        return `
            <div class="shift-editor" data-crew-id="${member.id}">
                ${rows}
                <div class="shift-editor-actions">
                    <button class="shift-add-btn">+ Add shift</button>
                    <button class="shift-save-btn">Save</button>
                    <button class="shift-cancel-btn">Cancel</button>
                </div>
            </div>`;
    }

    _bindShiftEditor(listEl) {
        const editorEl = listEl.querySelector('.shift-editor');
        if (!editorEl) return;
        const member = (this.crewManifest || []).find(m => m.id === editorEl.dataset.crewId);
        if (!member) return;

        editorEl.querySelector('.shift-add-btn').addEventListener('click', () => {
            member.shifts.push({ startHour: 0, endHour: 4 });
            this._renderCrewScreen();
        });
        editorEl.querySelectorAll('.shift-remove-btn').forEach(btn =>
            btn.addEventListener('click', () => {
                member.shifts.splice(Number(btn.dataset.shiftIdx), 1);
                this._renderCrewScreen();
            })
        );
        editorEl.querySelector('.shift-save-btn').addEventListener('click', () => this._saveCrewShifts(editorEl, member));
        editorEl.querySelector('.shift-cancel-btn').addEventListener('click', () => {
            this._editingCrewId = null;
            this._renderCrewScreen();
        });
    }

    _saveCrewShifts(editorEl, member) {
        const shifts = [...editorEl.querySelectorAll('.shift-edit-row')].map(row => ({
            startHour: parseFloat(row.querySelector('.shift-start').value),
            endHour:   parseFloat(row.querySelector('.shift-end').value),
        })).filter(s => isFinite(s.startHour) && isFinite(s.endHour) && s.startHour >= 0 && s.endHour <= 24 && s.startHour < s.endHour);

        if (!shifts.length) {
            alert('Add at least one valid shift (start before end, within 0–24h).');
            return;
        }

        member.shifts = shifts;
        this._editingCrewId = null;
        this._renderCrewScreen();
    }

    // ── Comms & Nav UI ─────────────────────────────────────────────────────

    _openCommsNavScreen() {
        this._commsShownIds = null; // every contact animates in on open
        Overlay.show(this.commsNavScreen);
        this._renderCommsNavScreen();
    }

    _closeCommsNavScreen() {
        Overlay.hide(this.commsNavScreen);
    }

    // ── Motion ──────────────────────────────────────────────────────────────
    // Entry animations for things that are re-rendered while visible. They use
    // the Web Animations API rather than CSS so they play exactly when called —
    // a CSS animation would replay whenever the markup or a class (e.g. the
    // critical-card pulse) changed. Modal open animations are plain CSS.

    _motionOk() {
        return Overlay.motionOk();
    }

    // System cards fade up one after another when the dashboard first appears.
    _playDashboardIntro() {
        if (!this._motionOk()) return;
        document.querySelectorAll('.system-dashboard > .system-card').forEach((card, i) => {
            card.animate(
                [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }],
                { duration: 380, delay: 80 + i * 60, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)', fill: 'backwards' }
            );
        });
    }

    // Comms & Nav "boot": location cards slide in in sequence and map markers
    // pop in with a ping ring. Only contacts not already on screen animate, so
    // opening the screen plays the whole sequence, a contact coming into range
    // later gets its own entrance, and re-renders (selection, ticks) play nothing.
    _animateCommsEntries(ids) {
        const previous = this._commsShownIds;
        this._commsShownIds = new Set(ids);
        if (!this._motionOk()) return;
        const fresh = ids.filter(id => !previous?.has(id));
        if (!fresh.length) return;

        fresh.forEach((id, i) => {
            const delay = i * 90;
            const card = document.querySelector(`#comms-location-list .comms-location-card[data-comms-id="${id}"]`);
            card?.animate(
                [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }],
                { duration: 300, delay, easing: 'ease-out', fill: 'backwards' }
            );
            document.querySelectorAll(`#comms-plane-views .comms-marker[data-comms-id="${id}"]`).forEach(marker => {
                marker.animate(
                    [{ transform: 'scale(0)' }, { transform: 'scale(1.5)', offset: 0.6 }, { transform: 'scale(1)' }],
                    { duration: 420, delay: 250 + delay, easing: 'ease-out', fill: 'backwards' }
                );
                const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                ring.setAttribute('cx', marker.getAttribute('cx'));
                ring.setAttribute('cy', marker.getAttribute('cy'));
                ring.setAttribute('r', '0.3');
                ring.setAttribute('class', 'comms-ping');
                ring.style.stroke = getComputedStyle(marker).fill;
                marker.parentNode.insertBefore(ring, marker);
                ring.animate(
                    [{ r: '0.3px', opacity: 0.9 }, { r: '1.6px', opacity: 0 }],
                    { duration: 800, delay: 300 + delay, easing: 'ease-out', fill: 'both' }
                ).finished.then(() => ring.remove(), () => ring.remove());
            });
        });
    }

    // ── Ship Capacity modal ─────────────────────────────────────────────────
    // Launched from the dashboard rather than an inline card since this will
    // grow into the buy/sell/adjust-components screen.

    _openShipCapacityScreen() {
        Overlay.show(this.shipCapacityScreen);
        this._displayShipCapacity();
    }

    _closeShipCapacityScreen() {
        Overlay.hide(this.shipCapacityScreen);
    }

    // ── Cargo Hold modal ────────────────────────────────────────────────────
    // Supplies aboard and storage boxes, with what can be done with each box.

    _openCargoScreen() {
        Overlay.show(this.cargoScreen);
        this._displayCargo();
    }

    _closeCargoScreen() {
        Overlay.hide(this.cargoScreen);
    }

    _displayCargo() {
        const bodyEl = document.getElementById('cargo-body');
        if (!bodyEl || !Overlay.isOpen(this.cargoScreen)) return;
        const fab = this.fabrication;

        const supplies = Object.entries(fab.ITEMS).map(([key, item]) => `
            <li class="task-card task-card-static" data-item-key="${key}">
                <div class="task-info">
                    <div class="task-title">${item.name} &times; <span class="cargo-count">${fab.count(key)}</span></div>
                    <div class="task-meta">${item.blurb} ${item.massKg} kg, ${item.litres} L of box space each.</div>
                </div>
            </li>`).join('');

        const boxes    = fab.standardBoxes().map(box => this._cargoBoxHtml(box)).join('');
        const machines = fab.machineBoxes().map(box => this._machineBoxHtml(box)).join('');
        const solidL   = this.systems.blackWater.solidL;
        const recipe   = fab.RECIPES.storageBox;
        const machineRecipe = fab.RECIPES.machineBox;

        const html = `
            <h3 class="overlay-section-title">Supplies</h3>
            <p class="repair-crew-status">Kept in parts boxes, below: components of both kinds and composting agent share a box.</p>
            <ul class="overlay-list">${supplies}</ul>
            <h3 class="overlay-section-title">Storage Boxes</h3>
            <p class="repair-crew-status">Food aboard: ${fab.rationsAboard().toFixed(1)} rations. Solid waste in the black water tank: ${solidL.toFixed(1)} L.
               Each box holds ${fab.BOX.capacityL} L &mdash; or ${fab.BOX.capacityL} rations &mdash; and one kind of thing at a time:
               food, parts, or compost.</p>
            <ul class="overlay-list" id="cargo-box-list">${boxes ||
                `<li class="task-empty">No storage boxes. Engineers can fabricate one from the Work Queue &mdash; it takes ${fab.componentsLabel(recipe)}.</li>`}</ul>
            <h3 class="overlay-section-title">Machine Boxes</h3>
            <p class="repair-crew-status">Each holds one piece of equipment, switched off, without it taking a dashboard slot:
               a spare to swap in, or salvage to repair and sell at a profit.</p>
            <ul class="overlay-list" id="cargo-machine-list">${machines ||
                `<li class="task-empty">No machine boxes. Engineers can fabricate one from the Work Queue &mdash; it takes ${fab.componentsLabel(machineRecipe)} and ${this._fmtRepairHours(machineRecipe.hours)}.</li>`}</ul>`;
        this._setHtmlIfChanged(bodyEl, html);
    }

    _cargoBoxHtml(box) {
        const fab    = this.fabrication;
        const status = fab.boxStatus(box);
        const btn = (action, label, blocker) =>
            `<button class="repair-btn" data-fab-action="${action}" data-box-id="${box.id}" ${blocker ? `disabled title="${blocker}"` : ''}>${label}</button>`;

        let label = '', meta = '', fillPct = 0, actions = '', blocker = null;
        switch (status) {
            case 'empty':
                label   = 'Empty';
                meta    = 'Food and parts you buy, and parts stripped from the drives, go into empty boxes. Or add composting agent to use it for solid waste.';
                blocker = fab.doseBlocker(box.id);
                actions = btn('dose', 'Add Composting Agent', blocker);
                break;
            case 'parts': {
                label   = 'Parts';
                const what = Object.entries(box.parts ?? {}).map(([k, n]) => `${n} &times; ${fab.ITEMS[k]?.name ?? k}`).join(', ');
                meta    = `${what || 'Nothing'} &middot; ${box.fillL.toFixed(0)} / ${fab.BOX.capacityL} L`;
                fillPct = (box.fillL / fab.BOX.capacityL) * 100;
                break;
            }
            case 'food':
                label   = 'Food';
                meta    = `${box.fillL.toFixed(1)} / ${fab.BOX.capacityL} rations. The crew eat from the emptiest food box first.`;
                fillPct = (box.fillL / fab.BOX.capacityL) * 100;
                break;
            case 'filling': {
                label   = 'Compost &mdash; taking solid waste';
                meta    = `${box.fillL.toFixed(1)} / ${fab.BOX.capacityL} L. Composting starts when it is sealed, or by itself once full.`;
                fillPct = (box.fillL / fab.BOX.capacityL) * 100;
                const moveBlocker = fab.transferBlocker(box.id);
                const sealBlocker = fab.sealBlocker(box.id);
                blocker = moveBlocker && sealBlocker ? moveBlocker : null;
                actions = btn('transfer', 'Move Solid Waste', moveBlocker) + btn('seal', 'Seal &amp; Compost', sealBlocker);
                break;
            }
            case 'composting':
                label   = 'Composting';
                meta    = `${box.fillL.toFixed(1)} L &middot; ${this._fmtRepairHours(fab.hoursUntilCompost(box))} to go`;
                fillPct = (box.compostHours / fab.COMPOST_HOURS) * 100;
                break;
            case 'ready':
                label   = 'Compost ready';
                meta    = `${box.fillL.toFixed(1)} L of compost &middot; sells for ${fab.salePrice(box)} credits on a planet`;
                fillPct = 100;
                blocker = fab.sellBlocker(box.id);
                actions = btn('sell', this._sellLabel(fab.salePrice(box)), blocker) + btn('emptyBox', 'Tip Out', null);
                break;
        }

        return `
            <li class="task-card task-card-static cargo-box cargo-box-${status}" data-box-id="${box.id}">
                <div class="task-info">
                    <div class="task-title">${fab.boxLabel(box)} &mdash; ${label}</div>
                    <div class="task-progress-track"><div class="task-progress-fill" style="width:${Math.min(100, fillPct).toFixed(1)}%"></div></div>
                    <div class="task-meta">${meta} &middot; ${fab.boxMassKg(box).toFixed(1)} kg</div>
                    ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                </div>
                <div class="cargo-box-actions">${actions}</div>
            </li>`;
    }

    _machineBoxHtml(box) {
        const fab = this.fabrication;
        const btn = (action, label, blocker) =>
            `<button class="repair-btn" data-fab-action="${action}" data-box-id="${box.id}" ${blocker ? `disabled title="${blocker}"` : ''}>${label}</button>`;
        const mod = box.module;

        let title, meta, actions = '', blocker = null, fillPct = 0, chips = '';
        if (!mod) {
            title = `${fab.boxLabel(box)} &mdash; Empty`;
            meta  = 'Buy a salvaged module on the market with &ldquo;Buy &amp; Store&rdquo; to keep it here.';
        } else {
            const unit = `box:${box.id}`;
            const name = fab.moduleName(mod.moduleKey);
            const pct  = Math.round(mod.repairPct ?? 100);
            const condition = mod.destroyed ? 'destroyed' : `${pct}%${mod.juryRigged ? ', jury-rigged' : ''}`;
            const task = this.repairQueue.find(t => t.systemKey === unit);
            const fitted = this.systems[mod.moduleKey];
            const swapLabel = fitted && fitted.installed !== false ? 'Swap with Fitted' : 'Fit';

            title   = `${fab.boxLabel(box)} &mdash; ${name} (${condition})`;
            fillPct = mod.destroyed ? 0 : (mod.repairPct ?? 100);
            meta    = `Worth ${fab.moduleSaleValue(mod)} credits on a planet` +
                      (task ? ` &middot; repair queued: ${task.band} &rarr; ${task.targetPct}%` : '');

            let repairBtn = '';
            if (!task && this.repairManager.canRepair(unit)) {
                const info = this.repairManager.describeRepair(unit, this._repairTargets[unit]);
                if (info) {
                    chips = this._repairTargetChips(unit, info.targetPct);
                    repairBtn = btn('repairStored', `${this._repairLabel(info)}`, null);
                }
            }
            const swapBlocker = fab.swapBlocker(box.id);
            const sellBlocker = fab.sellModuleBlocker(box.id);
            blocker = sellBlocker && swapBlocker ? swapBlocker : null;
            actions = repairBtn + btn('swap', swapLabel, swapBlocker) +
                      btn('sellModule', this._sellLabel(fab.moduleSaleValue(mod)), sellBlocker);
        }

        return `
            <li class="task-card task-card-static cargo-box cargo-box-machine" data-box-id="${box.id}">
                <div class="task-info">
                    <div class="task-title">${title}</div>
                    <div class="task-progress-track"><div class="task-progress-fill" style="width:${Math.min(100, fillPct).toFixed(1)}%"></div></div>
                    <div class="task-meta">${meta} &middot; ${fab.boxMassKg(box).toFixed(1)} kg</div>
                    ${chips}
                    ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                </div>
                <div class="cargo-box-actions">${actions}</div>
            </li>`;
    }

    // From the yard a sale goes by drone and is paid for when it lands at the port.
    _sellLabel(price) {
        return this.logistics.tradeMode() === 'drone' ? `Send by Drone &middot; ~${price} cr` : `Sell &middot; ${price} cr`;
    }

    _selectCommsLocation(id) {
        this._selectedCommsId = id;
        this._renderCommsNavScreen();
    }

    _commsKindLabel(kind) {
        switch (kind) {
            case 'home':     return 'Current Location';
            case 'location': return 'Known Location';
            case 'signal':    return 'Comm Signal';
            default:          return kind;
        }
    }

    _renderCommsNavScreen() {
        const seedEl = document.getElementById('comms-seed-label');
        if (seedEl) seedEl.textContent = this.commsSeed != null ? `— Sector Seed: ${this.commsSeed}` : '';

        // Only what the transceiver can reach right now is shown; a selection
        // that has dropped out of range falls back to where the ship is.
        const visible = this.commsNav.visibleLocations();
        if (!visible.some(l => l.id === this._selectedCommsId)) {
            this._selectedCommsId = this.commsNav.home()?.id ?? null;
        }

        const rangeEl = document.getElementById('comms-range-status');
        if (rangeEl) {
            const sys   = this.systems.transceiver;
            const state = sys.destroyed ? 'destroyed' : !sys.active ? 'switched off' : `range ${this.commsNav.rangeLy().toFixed(2)} ly`;
            rangeEl.textContent = `Transceiver ${state} — ${Math.max(0, visible.length - 1)} contact(s) in range`;
        }

        this._renderCommsLocationList();

        const planeEl = document.getElementById('comms-plane-views');
        if (planeEl) {
            const html = this._planeSvg('x', 'y', 'Top View (X / Y)') + this._planeSvg('x', 'z', 'Side View (X / Z)');
            if (this._setHtmlIfChanged(planeEl, html)) {
                planeEl.querySelectorAll('.comms-marker').forEach(el =>
                    el.addEventListener('click', () => this._selectCommsLocation(el.dataset.commsId))
                );
            }
        }

        this._renderCommsDetailsPane();
        this._animateCommsEntries(visible.map(l => l.id));
    }

    // This screen is refreshed every tick while open (what's in range follows
    // the transceiver live), so each part only touches the DOM when its markup
    // has actually changed — otherwise scroll position, hover and half-made
    // clicks would be thrown away once a second. Returns true if it re-rendered
    // (i.e. listeners need re-binding). Scroll positions inside survive a real change too.
    _setHtmlIfChanged(el, html) {
        if (el._renderedHtml === html) return false;
        const scrolled = [...el.querySelectorAll('[data-keep-scroll]')].map(node => [node.dataset.keepScroll, node.scrollTop]);
        el._renderedHtml = html;
        el.innerHTML = html;
        scrolled.forEach(([key, top]) => {
            const node = el.querySelector(`[data-keep-scroll="${key}"]`);
            if (node) node.scrollTop = top;
        });
        return true;
    }

    _renderCommsLocationList() {
        const listEl = document.getElementById('comms-location-list');
        if (!listEl) return;
        const locations = this.commsNav.visibleLocations();

        if (!locations.length) {
            this._setHtmlIfChanged(listEl, '<li class="task-empty">No charted locations.</li>');
            return;
        }

        const html = locations.map(loc => {
            const selected = loc.id === this._selectedCommsId;
            const dist = loc.kind === 'home' ? null : this.commsNav.distanceFromHome(loc);
            return `
                <li class="comms-location-card${selected ? ' comms-location-selected' : ''}" data-comms-id="${loc.id}">
                    <div class="comms-location-name">${loc.name}</div>
                    <div class="comms-location-kind">${this._commsKindLabel(loc.kind)}</div>
                    ${dist != null ? `<div class="comms-location-distance">${dist.toFixed(2)} ly</div>` : ''}
                </li>`;
        }).join('');

        if (!this._setHtmlIfChanged(listEl, html)) return;
        listEl.querySelectorAll('.comms-location-card').forEach(li =>
            li.addEventListener('click', () => this._selectCommsLocation(li.dataset.commsId))
        );
    }

    _renderCommsDetailsPane() {
        const paneEl = document.getElementById('comms-details-pane');
        if (!paneEl) return;
        const loc = this.commsNav.visibleLocations().find(l => l.id === this._selectedCommsId);

        if (!loc) {
            this._setHtmlIfChanged(paneEl, '<p class="task-empty">Select a location to view details.</p>');
            return;
        }

        const distanceLine = loc.kind === 'home'
            ? 'You are here'
            : `Distance: ${this.commsNav.distanceFromHome(loc).toFixed(2)} ly`;

        const html = `
            <h3 class="comms-details-title">${loc.name}</h3>
            <div class="comms-details-kind">${this._commsKindLabel(loc.kind)} &middot; ${this.commsNav.locationTypeLabel(loc)}</div>
            <div class="comms-details-coords">XYZ: ${loc.x.toFixed(2)}, ${loc.y.toFixed(2)}, ${loc.z.toFixed(2)}</div>
            <div class="comms-details-distance">${distanceLine}</div>
            <div class="comms-details-services" data-keep-scroll="services">${this._commsServicesHtml(loc)}</div>`;

        if (!this._setHtmlIfChanged(paneEl, html)) return;
        paneEl.querySelectorAll('.market-buy-btn').forEach(btn =>
            btn.addEventListener('click', () => this.buyMarketItem(btn.dataset.listingId))
        );
    }

    // Trade & news for one location. Local services need the local network in
    // range; anywhere else is view-only until remote trade and delivery exist.
    _commsServicesHtml(loc) {
        if (loc.kind !== 'home') {
            return '<p class="task-empty">No trade link. For now you can only buy in person, on a planet.</p>';
        }
        if (this.logistics.isFlying()) {
            return '<p class="task-empty">In flight — the market can wait until she\'s down.</p>';
        }
        if (!this.commsNav.hasLocalDetails()) {
            return `<p class="task-empty">Local network out of range. Transceiver range is ${this.commsNav.rangeLy().toFixed(2)} ly;
                    the local market and news need ${this.commsNav.LOCAL_DETAILS_RANGE_LY} ly. Repair the transceiver and switch it on.</p>`;
        }

        const fab = this.fabrication;
        const lg  = this.logistics;
        // From the yard a module to store is only an order waiting at the port, so
        // it can be bought before there's a machine box free (or built) for it.
        const byDrone  = lg.tradeMode() === 'drone';
        const canStore = byDrone || fab.machineBoxes().length > 0;
        const listings = this.commsNav.listingsAt(loc);
        const rows = listings.map(l => {
            const blocker      = this.commsNav.purchaseBlocker(l, 'fit');
            const storeBlocker = canStore ? this.commsNav.purchaseBlocker(l, 'store') : null;
            // With a way to store it, only say why when neither way of buying works.
            const shown   = canStore ? (blocker && storeBlocker ? storeBlocker : null) : blocker;
            const gamble  = l.repairPct < 20 ? ' &middot; <span class="market-risk">repair is a gamble</span>' : '';
            const worth   = fab.moduleSaleValue({ moduleKey: l.moduleKey, repairPct: 100 });
            const storeTip = byDrone
                ? 'Waits at the port; a drone can bring it back once there is an empty machine storage box for it'
                : 'Goes into an empty machine storage box';
            const storeBtn = canStore
                ? `<button class="repair-btn market-store-btn" data-listing-id="${l.id}" title="${storeBlocker ?? storeTip}" ${storeBlocker ? 'disabled' : ''}>${byDrone ? 'Order to Store' : 'Buy &amp; Store'} &middot; ${l.price} cr</button>`
                : '';
            return `
                <li class="market-card" data-listing-id="${l.id}">
                    <div class="market-info">
                        <div class="market-name">${this._escapeHtml(l.name)}</div>
                        <div class="market-meta">Condition ${Math.round(l.repairPct)}%${gamble} &middot; ${fab.moduleMassKg({ moduleKey: l.moduleKey, tier: 1 })} kg &middot; sells for ${worth} cr fully repaired</div>
                        ${shown ? `<div class="market-blocker">${shown}</div>` : ''}
                    </div>
                    <div class="market-buttons">
                        <button class="repair-btn market-buy-btn" data-listing-id="${l.id}" ${blocker ? `disabled title="${blocker}"` : ''}>${lg.tradeMode() === 'drone' ? 'Order to Fit' : 'Buy &amp; Fit'} &middot; ${l.price} cr</button>
                        ${storeBtn}
                    </div>
                </li>`;
        }).join('');

        const supplies = Object.entries(fab.ITEMS).map(([key, item]) => {
            const blocker = fab.buyBlocker(key);
            return `
                <li class="market-card" data-supply-key="${key}">
                    <div class="market-info">
                        <div class="market-name">${item.name}</div>
                        <div class="market-meta">${item.blurb} Aboard: ${fab.count(key)}</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="buy" data-key="${key}" ${blocker ? 'disabled' : ''}>Buy &middot; ${item.price} cr</button>
                </li>`;
        }).join('');

        const droneBlocker = lg.buyDroneBlocker();
        const fuelBlocker  = lg.buyFuelBlocker();
        const logisticsRows = `
                <li class="market-card" data-supply-key="drone">
                    <div class="market-info">
                        <div class="market-name">${lg.DRONE_NAME}</div>
                        <div class="market-meta">Carries ${lg.droneSpec('payloadKg')} kg at ${lg.droneSpec('speedKmh')} km/h. Flies itself to you, charged. Owned: ${lg.drones().length}</div>
                        ${droneBlocker ? `<div class="market-blocker">${droneBlocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-logi-action="buyDrone" ${droneBlocker ? 'disabled' : ''}>Buy &middot; ${lg.DRONE_PRICE} cr</button>
                </li>
                <li class="market-card" data-supply-key="fuel">
                    <div class="market-info">
                        <div class="market-name">${lg.FUEL.name} &mdash; ${lg.FUEL.lotL} L</div>
                        <div class="market-meta">${lg.FUEL.pricePerL} cr a litre. In the tank: ${this.systems.fuel.current.toFixed(1)} / ${this.systems.fuel.capacity} L</div>
                        ${fuelBlocker ? `<div class="market-blocker">${fuelBlocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-logi-action="buyFuel" ${fuelBlocker ? 'disabled' : ''}>Buy &middot; ${lg.fuelLotPrice()} cr</button>
                </li>`;

        const foodBlocker = fab.buyFoodBlocker();
        const foodRow = `
                <li class="market-card" data-supply-key="food">
                    <div class="market-info">
                        <div class="market-name">${fab.FOOD.name}</div>
                        <div class="market-meta">${fab.FOOD.blurb} Aboard: ${fab.rationsAboard().toFixed(1)} &middot; box space for ${Math.floor(fab.foodRoom())}</div>
                        ${foodBlocker ? `<div class="market-blocker">${foodBlocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="buyFood" ${foodBlocker ? 'disabled' : ''}>Buy &middot; ${fab.FOOD.price} cr</button>
                </li>`;

        // Stored equipment can be sold here as well as from the Cargo Hold.
        const equipmentRows = fab.machineBoxes().filter(b => b.module).map(box => {
            const blocker = fab.sellModuleBlocker(box.id);
            const m = box.module;
            const condition = m.destroyed ? 'destroyed &mdash; scrap' : `condition ${Math.round(m.repairPct ?? 100)}%${m.juryRigged ? ', jury-rigged' : ''}`;
            return `
                <li class="market-card" data-sell-module-box-id="${box.id}">
                    <div class="market-info">
                        <div class="market-name">${fab.moduleName(m.moduleKey)} &mdash; ${fab.boxLabel(box)}</div>
                        <div class="market-meta">${condition}</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="sellModule" data-box-id="${box.id}" ${blocker ? 'disabled' : ''}>${this._sellLabel(fab.moduleSaleValue(m))}</button>
                </li>`;
        }).join('');

        // Finished compost can be sold here as well as from the Cargo Hold.
        const compostRows = fab.boxes()
            .map((box, i) => ({ box, n: i + 1 }))
            .filter(({ box }) => fab.boxStatus(box) === 'ready')
            .map(({ box, n }) => {
                const blocker = fab.sellBlocker(box.id);
                return `
                <li class="market-card" data-sell-box-id="${box.id}">
                    <div class="market-info">
                        <div class="market-name">Compost &mdash; ${fab.boxLabel(box)}</div>
                        <div class="market-meta">${box.fillL.toFixed(1)} L</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="sell" data-box-id="${box.id}" ${blocker ? 'disabled' : ''}>${this._sellLabel(fab.salePrice(box))}</button>
                </li>`;
            }).join('');

        const tradeNote = lg.tradeMode() === 'drone'
            ? `<p class="market-mode">You're at ${lg.YARD_NAME}, ${lg.YARD_TO_PORT_KM} km out. What you buy waits at ${lg.PORT_NAME} until a drone
               fetches it (up to ${lg.droneSpec('payloadKg')} kg a run); what you sell goes by drone and is paid for when it lands.${
               lg.drones().length ? '' : ' <strong>Buy a transfer drone first.</strong>'}</p>`
            : `<p class="market-mode">Berthed at ${lg.PORT_NAME}: everything comes straight aboard.</p>`;

        return `
            ${tradeNote}
            <h4 class="comms-services-title">Items for Sale</h4>
            <p class="market-credits">Your credits: <strong>${this.credits}</strong></p>
            <ul class="market-list">${rows || '<li class="task-empty">Nothing for sale right now.</li>'}</ul>
            <h4 class="comms-services-title">Supplies</h4>
            <ul class="market-list">${logisticsRows}${foodRow}${supplies}</ul>
            <h4 class="comms-services-title">Buying</h4>
            <p class="market-credits">Compost &mdash; ${fab.COMPOST_PRICE_PER_L} credits a litre.</p>
            <ul class="market-list">${compostRows || '<li class="task-empty">You have no finished compost to sell.</li>'}</ul>
            <p class="market-credits">Equipment &mdash; ${fab.MODULE_SELL_MIN}&ndash;${fab.MODULE_SELL_MAX} credits by condition, from a machine box.${this._resaleNote()}</p>
            <ul class="market-list">${equipmentRows || '<li class="task-empty">You have no stored equipment to sell.</li>'}</ul>
            <h4 class="comms-services-title">News</h4>
            <p class="task-empty">No bulletins.</p>`;
    }

    // Two orthographic plane views stand in for a full 3D render — axis1/axis2
    // pick which two coordinates to plot, the third is dropped for that view.
    _planeSvg(axis1, axis2, title) {
        const gridLines = [];
        for (let i = 0; i <= 10; i += 2) {
            gridLines.push(`<line x1="${i}" y1="0" x2="${i}" y2="10" class="comms-grid-line" />`);
            gridLines.push(`<line x1="0" y1="${i}" x2="10" y2="${i}" class="comms-grid-line" />`);
        }

        const markers = this.commsNav.visibleLocations().map(loc => {
            const cx = loc[axis1];
            const cy = 10 - loc[axis2]; // flip so larger values read "up"
            const selected = loc.id === this._selectedCommsId;
            return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${selected ? 0.45 : 0.28}" class="comms-marker comms-marker-${loc.kind}${selected ? ' comms-marker-selected' : ''}" data-comms-id="${loc.id}"></circle>`;
        }).join('');

        return `
            <div class="comms-plane">
                <div class="comms-plane-title">${title}</div>
                <svg viewBox="-0.5 -0.5 11 11" class="comms-plane-svg">
                    ${gridLines.join('')}
                    ${markers}
                </svg>
            </div>`;
    }

    // ── Repair UI ───────────────────────────────────────────────────────────

    _repairZoneClass(pct, destroyed) {
        if (destroyed)  return 'repair-destroyed';
        if (pct >= 95)  return 'repair-good';
        if (pct >= 50)  return 'repair-degraded';
        if (pct >= 20)  return 'repair-major';
        return 'repair-critical';
    }

    _displayRepairPanel(systemKey, idPrefix) {
        const sys = this.systems[systemKey];
        const pct = sys.repairPct ?? 100;

        const fill = document.getElementById(`${idPrefix}-repair-fill`);
        if (!fill) return; // markup not present yet
        fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        fill.className    = 'repair-fill ' + this._repairZoneClass(pct, sys.destroyed);

        document.getElementById(`${idPrefix}-repair-pct`).textContent =
            sys.destroyed ? 'DESTROYED' : `Repair: ${pct.toFixed(0)}%` + (sys.juryRigged ? ' (jury-rigged)' : '');

        const task     = this.repairQueue.find(t => t.systemKey === systemKey);
        const btn       = document.getElementById(`${idPrefix}-repair-btn`);
        const statusEl  = document.getElementById(`${idPrefix}-repair-status`);

        // The "Repair to" chip row lives just above the button; created on first use.
        let targetsEl = document.getElementById(`${idPrefix}-repair-targets`);
        if (!targetsEl) {
            targetsEl = document.createElement('div');
            targetsEl.id = `${idPrefix}-repair-targets`;
            targetsEl.className = 'repair-targets';
            btn.parentNode.insertBefore(targetsEl, btn);
        }
        targetsEl.style.display = 'none';

        if (sys.destroyed) {
            btn.style.display      = 'none';
            statusEl.style.display = '';
            statusEl.textContent   = 'Awaiting replacement part';
        } else if (task) {
            btn.style.display      = 'none';
            statusEl.style.display = '';
            const stageTop = this.repairManager._taskStage(task).toPct;
            statusEl.textContent   = `${task.status === 'in-progress' ? 'Repairing' : 'Queued'}: ${task.band} → ${stageTop}% — ` +
                `${task.hoursRemaining.toFixed(1)}h left` + (task.targetPct > stageTop ? `, then on to ${task.targetPct}%` : '');
        } else if (!this.repairManager.canRepair(systemKey)) {
            btn.style.display      = 'none';
            statusEl.style.display = 'none';
        } else {
            const info = this.repairManager.describeRepair(systemKey, this._repairTargets[systemKey]);
            if (!info) { btn.style.display = 'none'; statusEl.style.display = 'none'; return; }
            btn.style.display      = '';
            statusEl.style.display = 'none';
            btn.textContent        = this._repairLabel(info);

            // Rebuilt only when something it shows has changed, so a click on a
            // chip is never lost to the once-a-second re-render.
            const nowPct = Math.round(this.repairManager.efficiencyFor(systemKey) * 100);
            const html   = this._repairTargetChips(systemKey, info.targetPct) +
                `<div class="repair-target-note">Output now ${nowPct}% of rated &rarr; ${Math.round(info.efficiency * 100)}% at ${info.targetPct}%</div>`;
            if (targetsEl.dataset.html !== html) { targetsEl.innerHTML = html; targetsEl.dataset.html = html; }
            targetsEl.style.display = '';
        }
    }

    _fmtRepairHours(hours) {
        return (+hours.toFixed(1)) + 'h';
    }

    // "Repair to 80% (9.2h)" — plus the risk, if any stage on the way can wreck the module.
    _repairLabel(info) {
        return `Repair to ${info.targetPct}% (${this._fmtRepairHours(info.hours)})` +
            (info.destroyChance > 0 ? ` — ${Math.round(info.destroyChance * 100)}% destroy risk` : '');
    }

    // One chip per level the repair could stop at. `taskId` makes the chips
    // retarget that queued task instead of choosing for a not-yet-ordered repair.
    _repairTargetChips(systemKey, activePct, taskId = null) {
        const chips = this.repairManager.targetOptions(systemKey).map(o => `
            <button class="repair-target-chip${o.targetPct === activePct ? ' chip-active' : ''}"
                    data-system-key="${systemKey}" data-target="${o.targetPct}"${taskId ? ` data-task-id="${taskId}"` : ''}
                    title="${o.stageName}: ${this._fmtRepairHours(o.hours)} in total, ${Math.round(o.efficiency * 100)}% of rated output">${o.targetPct}%</button>`).join('');
        return `<div class="repair-target-row"><span class="repair-target-label">Repair to</span>${chips}</div>`;
    }

    // Which module types are fetching less after recent sales, and by how much.
    _resaleNote() {
        const fab = this.fabrication;
        const down = Object.keys(this.moduleResale || {})
            .map(key => ({ key, pct: Math.round((1 - fab.resaleFactor(key)) * 100) }))
            .filter(x => x.pct > 0)
            .map(x => `${fab.moduleName(x.key)} &minus;${x.pct}%`);
        return down.length ? ` Prices are down after recent sales: ${down.join(', ')}.` : '';
    }

    _repairSystemLabel(systemKey) {
        if (this.repairManager.isDroneUnit(systemKey)) {
            const drone = this.logistics.drone(systemKey.slice(6));
            return drone ? this.logistics.droneLabel(drone) : 'Transfer drone';
        }
        if (this.repairManager.isStoredUnit(systemKey)) {
            const boxId = systemKey.slice(4);
            const box   = this.fabrication.boxes().find(b => b.id === boxId);
            const mod   = box?.module;
            return mod ? `${this.fabrication.moduleName(mod.moduleKey)} (stored, ${this.fabrication.boxLabel(box)})` : 'Stored module';
        }
        return {
            o2: 'O₂ Generator', co2: 'CO₂ Scrubber', power: 'Power Generator',
            transceiver: 'Transceiver', waterMaker: 'Water Maker',
        }[systemKey] ?? systemKey;
    }

    // Repairable systems not yet in the queue — the same set each system's own
    // card offers a "Repair" button for, surfaced centrally so a task can be
    // added from here too instead of having to find the right widget first.
    _renderRepairAvailable() {
        const listEl = document.getElementById('repair-available-list');
        if (!listEl) return;

        const rows = [...this.repairManager.repairableKeys(), ...this.repairManager.storedKeys(), ...this.repairManager.droneKeys()]
            .filter(key => this.repairManager.canRepair(key))
            .map(key => {
                const info = this.repairManager.describeRepair(key, this._repairTargets[key]);
                if (!info) return null;
                const nowPct = Math.round(this.repairManager.efficiencyFor(key) * 100);
                return `
                    <li class="task-card task-card-static" data-system-key="${key}">
                        <div class="task-info">
                            <div class="task-title">${this._repairSystemLabel(key)} &mdash; ${Math.round(this.repairManager._sys(key).repairPct ?? 100)}%</div>
                            <div class="task-meta">${this._repairLabel(info)} &middot; output ${nowPct}% &rarr; ${Math.round(info.efficiency * 100)}%</div>
                            ${this._repairTargetChips(key, info.targetPct)}
                        </div>
                        <button class="repair-btn repair-available-btn" data-system-key="${key}">Add to Queue</button>
                    </li>`;
            })
            .filter(Boolean);

        if (!rows.length) {
            listEl.innerHTML = '<li class="task-empty">No repairs currently needed.</li>';
            return;
        }

        listEl.innerHTML = rows.join('');
        listEl.querySelectorAll('.repair-available-btn').forEach(btn =>
            btn.addEventListener('click', () => this.startRepair(btn.dataset.systemKey))
        );
    }

    // What engineers can make, each with what it needs.
    _renderFabricationAvailable() {
        const listEl = document.getElementById('fabrication-list');
        if (!listEl) return;
        const fab = this.fabrication;
        const html = Object.entries(fab.RECIPES).map(([key, recipe]) => {
            const blocker = fab.fabricateBlocker(key);
            const have = Object.keys(recipe.components).map(k => `${fab.count(k)} ${fab.ITEMS[k].name.toLowerCase().replace(' components', '')}`).join(', ');
            return `
                <li class="task-card task-card-static" data-recipe-key="${key}">
                    <div class="task-info">
                        <div class="task-title">${recipe.name}</div>
                        <div class="task-meta">${fab.componentsLabel(recipe)} (aboard: ${have}) &middot; ${this._fmtRepairHours(recipe.hours)} of engineering work</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="fabricate" data-key="${key}" ${blocker ? 'disabled' : ''}>Fabricate</button>
                </li>`;
        }).join('');
        this._setHtmlIfChanged(listEl, html);
    }

    _fabricationTaskHtml(task) {
        const strip  = task.kind === 'strip';
        const recipe = strip ? { name: this.logistics.DRIVE_NAMES[task.recipeKey] } : this.fabrication.RECIPES[task.recipeKey];
        const progressPct = task.totalHours > 0
            ? Math.max(0, Math.min(100, 100 * (1 - task.hoursRemaining / task.totalHours))) : 100;
        return `
            <li class="task-card task-card-fabricate" draggable="true" data-task-id="${task.id}">
                <span class="task-drag-handle">&#10495;</span>
                <div class="task-info">
                    <div class="task-title">${strip ? 'Strip for Parts' : 'Fabricate'} &mdash; ${recipe ? recipe.name : task.recipeKey}</div>
                    <div class="task-progress-track"><div class="task-progress-fill" style="width:${progressPct.toFixed(1)}%"></div></div>
                    <div class="task-meta">${task.status === 'in-progress' ? 'In progress' : 'Queued'} &middot; ${task.hoursRemaining.toFixed(1)}h / ${this._fmtRepairHours(task.totalHours)} &middot; ${strip ? 'cancelling leaves it as it is' : 'cancelling returns its components'}</div>
                </div>
                <button class="task-cancel-btn" data-task-id="${task.id}">Cancel</button>
            </li>`;
    }

    _displayRepairQueue() {
        this._renderRepairAvailable();
        this._renderFabricationAvailable();

        const listEl = document.getElementById('repair-queue-list');
        if (!listEl || this._isDraggingTask) return; // markup not present yet, or mid-drag

        const onShift        = this.repairManager.crewOnShift();
        const totalEngineers = this.crewManifest.filter(c => c.classes.includes('engineering')).length;
        const nextChange     = this.repairManager.nextShiftChangeHour();
        const crewStatusEl   = document.getElementById('repair-crew-status');
        if (crewStatusEl) {
            const nextStr = nextChange != null
                ? ` — next shift change ${String(Math.floor(nextChange)).padStart(2, '0')}:${String(Math.round((nextChange % 1) * 60)).padStart(2, '0')}`
                : '';
            crewStatusEl.textContent = `Engineering on duty: ${onShift.length}/${totalEngineers}${nextStr}`;
        }

        if (!this.repairQueue.length) {
            listEl.innerHTML = '<li class="task-empty">Nothing queued.</li>';
            return;
        }

        listEl.innerHTML = this.repairQueue.map(task => {
            if (this.repairManager.isJob(task)) return this._fabricationTaskHtml(task);
            const progressPct = task.totalHours > 0
                ? Math.max(0, Math.min(100, 100 * (1 - task.hoursRemaining / task.totalHours))) : 100;
            const stageTop = this.repairManager._taskStage(task).toPct;
            const toTarget = this.repairManager.remainingHours(task);
            return `
                <li class="task-card" draggable="true" data-task-id="${task.id}">
                    <span class="task-drag-handle">&#10495;</span>
                    <div class="task-info">
                        <div class="task-title">${this._repairSystemLabel(task.systemKey)} &mdash; ${task.band} &rarr; ${stageTop}%</div>
                        <div class="task-progress-track"><div class="task-progress-fill" style="width:${progressPct.toFixed(1)}%"></div></div>
                        <div class="task-meta">${task.status === 'in-progress' ? 'In progress' : 'Queued'} &middot; this stage ${task.hoursRemaining.toFixed(1)}h / ${this._fmtRepairHours(task.totalHours)} &middot; ${this._fmtRepairHours(toTarget)} to reach ${task.targetPct}%</div>
                        ${this._repairTargetChips(task.systemKey, task.targetPct, task.id)}
                    </div>
                    <button class="task-cancel-btn" data-task-id="${task.id}">Cancel</button>
                </li>`;
        }).join('');

        listEl.querySelectorAll('.task-cancel-btn').forEach(btn =>
            btn.addEventListener('click', () => this.cancelRepairTask(btn.dataset.taskId))
        );

        this._bindDragReorder(listEl);
    }

    _bindDragReorder(listEl) {
        let dragEl = null;
        listEl.querySelectorAll('.task-card').forEach(li => {
            li.addEventListener('dragstart', () => { dragEl = li; this._isDraggingTask = true; li.classList.add('dragging'); });
            li.addEventListener('dragend', () => {
                if (dragEl) dragEl.classList.remove('dragging');
                dragEl = null;
                this._isDraggingTask = false;
                this._commitQueueOrder(listEl);
            });
            li.addEventListener('dragover', e => {
                e.preventDefault();
                if (!dragEl || dragEl === li) return;
                const rect   = li.getBoundingClientRect();
                const before = (e.clientY - rect.top) < rect.height / 2;
                li.parentNode.insertBefore(dragEl, before ? li : li.nextSibling);
            });
        });
    }

    _commitQueueOrder(listEl) {
        const orderedIds = [...listEl.querySelectorAll('.task-card')].map(li => li.dataset.taskId);
        this.repairManager.reorderTasks(orderedIds);
    }

    // ── Projections ─────────────────────────────────────────────────────────
    // All times in game-hours (ship time), consistent with ship clock.

    _fmtHrs(hrs) {
        if (!isFinite(hrs) || hrs <= 0) return '—';
        const totalMin = Math.round(hrs * 60);
        if (totalMin < 1)  return '< 1 min';
        if (totalMin < 60) return totalMin + ' min';
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        if (h >= 48) return Math.round(h / 24) + ' days';
        return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
    }

    _o2Projections(sys) {
        // Rate of O2 % change per game hour: netLhr [L/hr] ÷ (16000 L ÷ 100%) = netLhr / 160
        const ratePctPerHr = sys.netLhr / 160;
        if (Math.abs(ratePctPerHr) < 0.00001) return '<div class="proj-stable">Stable</div>';

        const rows = [];
        if (ratePctPerHr < 0) {
            // Depleting — show time to each upcoming threshold
            const thresholds = [
                { label: 'Warning',   pct: 19.5, cls: 'proj-warn' },
                { label: 'Critical',  pct: 16.0, cls: 'proj-crit' },
                { label: 'Exhausted', pct: 0.0,  cls: 'proj-dead' },
            ];
            for (const t of thresholds) {
                if (sys.pct > t.pct) {
                    const hrs = (sys.pct - t.pct) / Math.abs(ratePctPerHr);
                    rows.push(`<div class="proj-row ${t.cls}">
                        <span class="proj-label">→ ${t.label} (${t.pct}%)</span>
                        <span class="proj-value">${this._fmtHrs(hrs)}</span>
                    </div>`);
                }
            }
        } else {
            // Recovering — show time to exit each warning zone / reach nominal
            const targets = [
                { label: 'Safe (19.5%)',  pct: 19.5, cls: 'proj-safe', show: sys.pct < 19.5 },
                { label: 'Nominal (21%)', pct: 21.0, cls: 'proj-good', show: sys.pct < 21.0 },
            ];
            for (const t of targets) {
                if (t.show) {
                    const hrs = (t.pct - sys.pct) / ratePctPerHr;
                    rows.push(`<div class="proj-row ${t.cls}">
                        <span class="proj-label">→ ${t.label}</span>
                        <span class="proj-value">${this._fmtHrs(hrs)}</span>
                    </div>`);
                }
            }
        }

        return rows.length ? rows.join('') : '<div class="proj-stable">At nominal</div>';
    }

    _co2Projections(sys) {
        const ppm = sys.pct * 10000;
        // Rate in ppm per game hour: netLhr × (100% ÷ 16000L) × 10000ppm/% = netLhr × 62.5
        const ratePpmPerHr = sys.netLhr * 62.5;
        if (Math.abs(ratePpmPerHr) < 0.01) return '<div class="proj-stable">Stable</div>';

        const rows = [];
        if (ratePpmPerHr > 0) {
            // Accumulating — show time to each upcoming threshold
            const thresholds = [
                { label: 'Warning',  ppm: 1000,  cls: 'proj-warn', fmt: '1,000' },
                { label: 'Critical', ppm: 5000,  cls: 'proj-crit', fmt: '5,000' },
                { label: 'Lethal',   ppm: 10000, cls: 'proj-dead', fmt: '10,000' },
            ];
            for (const t of thresholds) {
                if (ppm < t.ppm) {
                    const hrs = (t.ppm - ppm) / ratePpmPerHr;
                    rows.push(`<div class="proj-row ${t.cls}">
                        <span class="proj-label">→ ${t.label} (${t.fmt} ppm)</span>
                        <span class="proj-value">${this._fmtHrs(hrs)}</span>
                    </div>`);
                }
            }
        } else {
            // Scrubbing — show time to reach lower thresholds
            const targets = [
                { label: 'Safe (1,000 ppm)',   ppm: 1000, cls: 'proj-safe', show: ppm > 1000 },
                { label: 'Nominal (400 ppm)',   ppm: 400,  cls: 'proj-good', show: ppm > 400  },
            ];
            for (const t of targets) {
                if (t.show) {
                    const hrs = (ppm - t.ppm) / Math.abs(ratePpmPerHr);
                    rows.push(`<div class="proj-row ${t.cls}">
                        <span class="proj-label">→ ${t.label}</span>
                        <span class="proj-value">${this._fmtHrs(hrs)}</span>
                    </div>`);
                }
            }
        }

        return rows.length ? rows.join('') : '<div class="proj-stable">At nominal</div>';
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    _syncTargetInputs() {
        const o2  = this.systems.o2;
        const co2 = this.systems.co2;
        const pwr = this.systems.power;
        document.getElementById('o2-target-input').value    = o2.target  != null ? o2.target  : '';
        document.getElementById('co2-target-input').value   = co2.target != null ? Math.round(co2.target * 10000) : '';
        document.getElementById('power-target-input').value = pwr.target != null ? pwr.target : '';
    }

    // A short-lived result message, floated beside what it's about (anchor.js)
    // so it never shifts the layout: `anchorEl` if given, else the button the
    // player just pressed, else the header's action buttons (autosaves).
    _showSaveStatus(msg, isError = false, anchorEl = null) {
        const el = document.getElementById('save-status');
        if (!el) return;
        const recent = this._lastPressed && performance.now() - this._lastPressedAt < 1500 ? this._lastPressed : null;
        const source = anchorEl ?? recent;
        const onScreen = n => n && n.isConnected && n.getClientRects().length > 0;
        el.textContent   = msg;
        el.className     = 'save-status callout ' + (isError ? 'save-error' : 'save-ok');
        el.style.display = '';
        Anchor.attach(el, () => onScreen(source) ? source : '#header-actions');
        clearTimeout(this._saveStatusTimer);
        this._saveStatusTimer = setTimeout(() => {
            el.textContent   = '';
            el.className     = 'save-status callout';
            el.style.display = 'none';
            Anchor.detach(el);
        }, 3000);
    }

    _setBadge(id, status) {
        const el = document.getElementById(id);
        switch (status) {
            case 'Critical': el.textContent = 'CRITICAL'; el.className = 'status-badge badge-critical'; break;
            case 'Warning':  el.textContent = 'WARNING';  el.className = 'status-badge badge-warning';  break;
            default:         el.textContent = 'NOMINAL';  el.className = 'status-badge badge-normal';
        }
    }

    _cardMod(status) {
        return status === 'Critical' ? ' card-critical' : status === 'Warning' ? ' card-warning' : '';
    }

    // Only the status classes change; the card's layout classes (expanded,
    // overflowing) belong to _layoutCards.
    _setCardStatus(id, status, unfitted = false) {
        const card = document.getElementById(id);
        if (!card) return;
        card.classList.toggle('card-critical', status === 'Critical');
        card.classList.toggle('card-warning',  status === 'Warning');
        card.classList.toggle('card-unfitted', unfitted);
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// Exposed on window so e2e tests (see tests/) can inspect/drive game state directly.
document.addEventListener('DOMContentLoaded', () => { window.game = new StarshipGame(); });
