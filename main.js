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
        this.creditsElement = document.getElementById('credits');
        this.timerElement   = document.getElementById('timer');
        this.dayElement     = document.getElementById('day-counter');
        this.crewElement    = document.getElementById('crew');
        this.crewStatElement = document.getElementById('crew-stat');

        this.crewManager    = new CrewManager(this);
        this.commsNav        = new CommsNav(this);
        this.repairManager = new RepairManager(this);
        this.fabrication   = new Fabrication(this);
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
    // Call with 'city' (planet surface) or 'space' (in transit / orbit)
    setBackground(theme) {
        document.body.dataset.bg = theme;
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
                liquidRateLhr: 0, solidRateLhr: 0, fillRateLhr: 0,
                exposureHours: 0, // how long the tank has been full and backing up into the cabin
            },
        };
    }

    _bindEvents() {
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
        document.getElementById('blackwater-transfer-btn').addEventListener('click', () => {
            const box = this.fabrication.transferTarget();
            if (box) this.fabricationAction('transfer', { boxId: box.id });
        });

        // Fabrication & cargo buttons (Cargo Hold, Work Queue, market supplies)
        // are re-rendered constantly, so one delegated listener handles them.
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-fab-action]');
            if (!btn || btn.disabled) return;
            this.fabricationAction(btn.dataset.fabAction, { boxId: btn.dataset.boxId, key: btn.dataset.key });
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
        document.getElementById('blackwater-dump-btn').addEventListener('click', () => this.dumpBlackWater());

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
            const savedBg = this.storyMessages?.['new-game']?.background ?? 'city';
            this.setBackground(savedBg);
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
    toggleWaterRationing() {
        if (!this.gameActive || this.gamePaused) return;
        const fresh = this.systems.freshWater;

        if (fresh.rationing) {
            if (fresh.rationHours >= this.crewManager.WATER_RATION_GRACE_HOURS) {
                if (!this._canAffordRationReset()) return; // also greyed out in the UI
                const cost = this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew;
                fresh.current -= cost;
                fresh.level    = (fresh.current / fresh.capacity) * 100;
            }
            fresh.rationing   = false;
            fresh.rationHours = 0;
        } else {
            fresh.rationing = true;
        }
        this.updateDisplay();
    }

    _canAffordRationReset() {
        const fresh = this.systems.freshWater;
        const cost  = this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew;
        return fresh.current >= cost;
    }

    // Manually vent a player-chosen percentage of the black water tank to space —
    // the only way to relieve the tank until reclamation processing exists.
    dumpBlackWater() {
        if (!this.gameActive || this.gamePaused) return;
        const black = this.systems.blackWater;
        if (black.current <= 0) return;

        const fine  = this.BLACK_WATER_DUMP_FINE;
        const input = prompt(
            `Dump what percentage of the black water tank? (0-100)\n\nDumping waste is illegal. Every dump is detected and fined ${fine} credits.`, '50');
        if (input === null) return;
        const pct = parseFloat(input);
        if (!isFinite(pct) || pct <= 0) return;

        const fraction = Math.min(100, pct) / 100;
        black.liquidL *= (1 - fraction);
        black.solidL  *= (1 - fraction);
        this.syncBlackWaterLevel();

        // The fine is charged per dump regardless of size, and can put the account into debt.
        this.credits -= fine;
        this._showSaveStatus(`Fined ${fine} credits for dumping waste`, true);
        this.updateDisplay();
    }

    // Recomputes the black water tank's total and level after liquid/solid
    // changed outside the tick (a dump, solids moved to a storage box). A tank
    // that's no longer full stops backing up, so exposure resets.
    syncBlackWaterLevel() {
        const black = this.systems.blackWater;
        black.current = black.liquidL + black.solidL;
        black.level   = (black.current / black.capacity) * 100;
        if (black.level < this.systemUpdate.BLACK_WATER_FULL_PCT) black.exposureHours = 0;
    }

    // Every fabrication / cargo action the player can take (rules live in Fabrication).
    fabricationAction(action, { boxId, key } = {}) {
        if (!this.gameActive || this.gamePaused) return;
        const fab = this.fabrication;
        switch (action) {
            case 'buy':
                if (fab.buy(key)) this._showSaveStatus(`Bought 1 ${fab.ITEMS[key].name} for ${fab.ITEMS[key].price} credits`);
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
                const earned = fab.sell(boxId);
                if (earned > 0) this._showSaveStatus(`Sold compost for ${earned} credits`);
                break;
            }
            default:
                return;
        }
        this.updateDisplay();
    }

    // Buy a market listing (rules live in CommsNav.purchaseBlocker/purchase).
    buyMarketItem(listingId) {
        if (!this.gameActive || this.gamePaused) return;
        const listing = (this.market || []).find(l => l.id === listingId);
        if (!listing || !this.commsNav.purchase(listingId)) return;
        this._showSaveStatus(`Bought ${listing.name} for ${listing.price} credits`);
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
        this._displayBlackWater();
        this._displayTransceiver();
        this._displayWaterMaker();
        this._displayShipCapacity();
        this._displayCargo();
        this._displayEnvironment();
        this._displayLocation();
        this._displayRepairQueue();
        // Contacts and market access follow the transceiver's live range.
        if (Overlay.isOpen(this.commsNavScreen)) this._renderCommsNavScreen();
        // Anything that changed since the last redraw — a tick or a player action — goes on the list.
        this.notifications?.check();
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

        nameEl.textContent = home.name;
        typeEl.textContent = this.commsNav.locationTypeLabel(home) +
            (this.inBreathableAtmosphere ? ' · Breathable atmosphere' : '');
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
        document.getElementById('card-o2').className = 'system-card' + this._cardMod(sys.status);

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
        document.getElementById('card-co2').className = 'system-card' + this._cardMod(sys.status);

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
        document.getElementById('card-power').className = 'system-card' + this._cardMod(sys.status);

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
        document.getElementById('card-fuel').className = 'system-card' + this._cardMod(sys.status);
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
            ? `Not enough fresh water to come off rationing — needs ${(this.systemUpdate.WATER_RATION_RESET_L_PER_CREW * this.crew).toFixed(0)} L`
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
                : `needs ${cost.toFixed(0)} L in the tank (${Math.ceil(cost - sys.current)} L short)`;
            resetEl.className = 'rate-value ' + (canAffordReset ? '' : 'rate-neg');
        } else {
            resetRow.style.display = 'none';
        }

        this._displayRationPreview(pastGrace);
        document.getElementById('card-freshwater').className = 'system-card' + this._cardMod(sys.status);
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

    _displayBlackWater() {
        const sys = this.systems.blackWater;
        document.getElementById('blackwater-level').textContent    = sys.current.toFixed(2) + ' L';
        document.getElementById('blackwater-indicator').style.left = Math.min(100, sys.level).toFixed(1) + '%';
        document.getElementById('blackwater-liquid').textContent   = sys.liquidL.toFixed(2) + ' L';
        document.getElementById('blackwater-solid').textContent    = sys.solidL.toFixed(2) + ' L';
        const reclaimLhr = sys.reclaimRateLhr ?? 0;
        document.getElementById('blackwater-reclaim-row').style.display = this.systems.waterMaker.installed ? '' : 'none';
        document.getElementById('blackwater-reclaim').textContent  = '−' + reclaimLhr.toFixed(3) + ' L/hr';

        // Explains a reclaim figure that's lower than the maker's output: it can
        // only take liquid, and the liquid has run out.
        const maker    = this.systems.waterMaker;
        const solidsEl = document.getElementById('blackwater-solids-note');
        if (maker.installed && maker.active && sys.reclaimStarved && sys.solidL > 0) {
            solidsEl.style.display = '';
            solidsEl.textContent = sys.liquidL < 0.05
                ? `All the liquid has been reclaimed. The remaining ${sys.solidL.toFixed(1)} L is solid matter the water maker can't process — dump it, or move it into a compost box.`
                : `The water maker is reclaiming liquid as fast as it arrives. It can't process the ${sys.solidL.toFixed(1)} L of solid matter — dump it, or move it into a compost box.`;
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

        const exposureRow = document.getElementById('blackwater-exposure-row');
        if ((sys.exposureHours ?? 0) > 0) {
            exposureRow.style.display = '';
            document.getElementById('blackwater-exposure').textContent =
                'Overflowing for ' + this._fmtHrs(sys.exposureHours) + ' — crew exposed';
        } else {
            exposureRow.style.display = 'none';
        }
        document.getElementById('card-blackwater').className = 'system-card' + this._cardMod(sys.status);
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
        document.getElementById('card-transceiver').className = 'system-card' + this._cardMod(sys.status);

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
        document.getElementById('card-watermaker').className =
            'system-card' + (installed ? this._cardMod(sys.status) : ' card-unfitted');
        if (!installed) return;

        const sourceLabel = {
            blackWater: 'Reclaiming black water', atmosphere: 'Condensing from outside air (low power)',
            full: 'Fresh tank full', none: sys.active ? 'Nothing to process' : '—',
        }[sys.source ?? 'none'];
        document.getElementById('watermaker-rated').textContent  = (sys.ratedLhr ?? 0).toFixed(2) + ' L/hr';
        document.getElementById('watermaker-source').textContent = sourceLabel;
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

        items.push(...this.fabrication.capacityItems());

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
        noteEl.style.display = '';
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
                    <div class="task-meta">${item.blurb}</div>
                </div>
            </li>`).join('');

        const boxes  = fab.boxes().map((box, i) => this._cargoBoxHtml(box, i)).join('');
        const solidL = this.systems.blackWater.solidL;
        const recipe = fab.RECIPES.storageBox;
        const plural = recipe.components === 1 ? '' : 's';

        const html = `
            <h3 class="overlay-section-title">Supplies</h3>
            <ul class="overlay-list">${supplies}</ul>
            <h3 class="overlay-section-title">Storage Boxes</h3>
            <p class="repair-crew-status">Solid waste in the black water tank: ${solidL.toFixed(1)} L.
               Each box holds ${fab.BOX.capacityL} L and one kind of thing at a time.</p>
            <ul class="overlay-list" id="cargo-box-list">${boxes ||
                `<li class="task-empty">No storage boxes. Engineers can fabricate one from the Work Queue &mdash; it takes ${recipe.components} basic component${plural}.</li>`}</ul>`;
        this._setHtmlIfChanged(bodyEl, html);
    }

    _cargoBoxHtml(box, i) {
        const fab    = this.fabrication;
        const status = fab.boxStatus(box);
        const btn = (action, label, blocker) =>
            `<button class="repair-btn" data-fab-action="${action}" data-box-id="${box.id}" ${blocker ? `disabled title="${blocker}"` : ''}>${label}</button>`;

        let label = '', meta = '', fillPct = 0, actions = '', blocker = null;
        switch (status) {
            case 'empty':
                label   = 'Empty';
                meta    = 'Add composting agent to use it for solid waste.';
                blocker = fab.doseBlocker(box.id);
                actions = btn('dose', 'Add Composting Agent', blocker);
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
                actions = btn('sell', `Sell &middot; ${fab.salePrice(box)} cr`, blocker);
                break;
        }

        return `
            <li class="task-card task-card-static cargo-box cargo-box-${status}" data-box-id="${box.id}">
                <div class="task-info">
                    <div class="task-title">Storage Box ${i + 1} &mdash; ${label}</div>
                    <div class="task-progress-track"><div class="task-progress-fill" style="width:${Math.min(100, fillPct).toFixed(1)}%"></div></div>
                    <div class="task-meta">${meta} &middot; ${fab.boxMassKg(box).toFixed(1)} kg</div>
                    ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                </div>
                <div class="cargo-box-actions">${actions}</div>
            </li>`;
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
        if (!this.commsNav.hasLocalDetails()) {
            return `<p class="task-empty">Local network out of range. Transceiver range is ${this.commsNav.rangeLy().toFixed(2)} ly;
                    the local market and news need ${this.commsNav.LOCAL_DETAILS_RANGE_LY} ly. Repair the transceiver and switch it on.</p>`;
        }

        const listings = this.commsNav.listingsAt(loc);
        const rows = listings.map(l => {
            const blocker = this.commsNav.purchaseBlocker(l);
            const gamble  = l.repairPct < 20 ? ' &middot; <span class="market-risk">repair is a gamble</span>' : '';
            return `
                <li class="market-card" data-listing-id="${l.id}">
                    <div class="market-info">
                        <div class="market-name">${this._escapeHtml(l.name)}</div>
                        <div class="market-meta">Condition ${Math.round(l.repairPct)}%${gamble}</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn market-buy-btn" data-listing-id="${l.id}" ${blocker ? 'disabled' : ''}>Buy &middot; ${l.price} cr</button>
                </li>`;
        }).join('');

        const fab = this.fabrication;
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

        // Finished compost can be sold here as well as from the Cargo Hold.
        const compostRows = fab.boxes()
            .map((box, i) => ({ box, n: i + 1 }))
            .filter(({ box }) => fab.boxStatus(box) === 'ready')
            .map(({ box, n }) => {
                const blocker = fab.sellBlocker(box.id);
                return `
                <li class="market-card" data-sell-box-id="${box.id}">
                    <div class="market-info">
                        <div class="market-name">Compost &mdash; Storage Box ${n}</div>
                        <div class="market-meta">${box.fillL.toFixed(1)} L</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="sell" data-box-id="${box.id}" ${blocker ? 'disabled' : ''}>Sell &middot; ${fab.salePrice(box)} cr</button>
                </li>`;
            }).join('');

        return `
            <h4 class="comms-services-title">Items for Sale</h4>
            <p class="market-credits">Your credits: <strong>${this.credits}</strong></p>
            <ul class="market-list">${rows || '<li class="task-empty">Nothing for sale right now.</li>'}</ul>
            <h4 class="comms-services-title">Supplies</h4>
            <ul class="market-list">${supplies}</ul>
            <h4 class="comms-services-title">Buying</h4>
            <p class="market-credits">Compost &mdash; ${fab.COMPOST_PRICE_PER_L} credits a litre.</p>
            <ul class="market-list">${compostRows || '<li class="task-empty">You have no finished compost to sell.</li>'}</ul>
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

    _repairSystemLabel(systemKey) {
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

        const rows = this.repairManager.repairableKeys()
            .filter(key => this.repairManager.canRepair(key))
            .map(key => {
                const info = this.repairManager.describeRepair(key, this._repairTargets[key]);
                if (!info) return null;
                const nowPct = Math.round(this.repairManager.efficiencyFor(key) * 100);
                return `
                    <li class="task-card task-card-static" data-system-key="${key}">
                        <div class="task-info">
                            <div class="task-title">${this._repairSystemLabel(key)} &mdash; ${Math.round(this.systems[key].repairPct ?? 100)}%</div>
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
            const plural  = recipe.components === 1 ? '' : 's';
            return `
                <li class="task-card task-card-static" data-recipe-key="${key}">
                    <div class="task-info">
                        <div class="task-title">${recipe.name}</div>
                        <div class="task-meta">${recipe.components} basic component${plural} (${fab.count('basicComponents')} aboard) &middot; ${this._fmtRepairHours(recipe.hours)} of engineering work</div>
                        ${blocker ? `<div class="market-blocker">${blocker}</div>` : ''}
                    </div>
                    <button class="repair-btn" data-fab-action="fabricate" data-key="${key}" ${blocker ? 'disabled' : ''}>Fabricate</button>
                </li>`;
        }).join('');
        this._setHtmlIfChanged(listEl, html);
    }

    _fabricationTaskHtml(task) {
        const recipe = this.fabrication.RECIPES[task.recipeKey];
        const progressPct = task.totalHours > 0
            ? Math.max(0, Math.min(100, 100 * (1 - task.hoursRemaining / task.totalHours))) : 100;
        return `
            <li class="task-card task-card-fabricate" draggable="true" data-task-id="${task.id}">
                <span class="task-drag-handle">&#10495;</span>
                <div class="task-info">
                    <div class="task-title">Fabricate &mdash; ${recipe ? recipe.name : task.recipeKey}</div>
                    <div class="task-progress-track"><div class="task-progress-fill" style="width:${progressPct.toFixed(1)}%"></div></div>
                    <div class="task-meta">${task.status === 'in-progress' ? 'In progress' : 'Queued'} &middot; ${task.hoursRemaining.toFixed(1)}h / ${this._fmtRepairHours(task.totalHours)} &middot; cancelling returns its components</div>
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
            if (task.kind === 'fabricate') return this._fabricationTaskHtml(task);
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

    _showSaveStatus(msg, isError = false) {
        const el = document.getElementById('save-status');
        if (!el) return;
        el.textContent = msg;
        el.className   = 'save-status ' + (isError ? 'save-error' : 'save-ok');
        clearTimeout(this._saveStatusTimer);
        this._saveStatusTimer = setTimeout(() => {
            el.textContent = '';
            el.className   = 'save-status';
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

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// Exposed on window so e2e tests (see tests/) can inspect/drive game state directly.
document.addEventListener('DOMContentLoaded', () => { window.game = new StarshipGame(); });
