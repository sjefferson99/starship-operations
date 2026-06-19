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
        this.commsLocations = [];
        this._selectedCommsId = null;
        this._pendingSeed     = null; // chosen on the seed screen, consumed by startNewGame()

        this.launchScreen   = document.getElementById('launch-screen');
        this.gameContainer  = document.getElementById('game-container');
        this.pauseMenu      = document.getElementById('pause-menu');
        this.seedScreen      = document.getElementById('seed-screen');
        this.introModal     = document.getElementById('intro-modal');
        this.taskQueueScreen = document.getElementById('task-queue-screen');
        this.loadScreen      = document.getElementById('load-screen');
        this.crewScreen      = document.getElementById('crew-screen');
        this.commsNavScreen  = document.getElementById('comms-nav-screen');
        this.creditsElement = document.getElementById('credits');
        this.timerElement   = document.getElementById('timer');
        this.dayElement     = document.getElementById('day-counter');
        this.crewElement    = document.getElementById('crew');
        this.crewStatElement = document.getElementById('crew-stat');

        this.crewManager    = new CrewManager(this);
        this.commsNav        = new CommsNav(this);
        this.repairManager = new RepairManager(this);
        this.systemUpdate   = new SystemUpdate(this);
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
                genOutputW: 0, o2DrawW: 0, co2DrawW: 0, netWhr: 0,
                target: 80.0,
                repairPct: 25, juryRigged: false, destroyed: false,
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
        document.getElementById('comms-nav-btn').addEventListener('click',         () => this._openCommsNavScreen());
        document.getElementById('comms-nav-close-btn').addEventListener('click',   () => this._closeCommsNavScreen());
        document.getElementById('quit-btn').addEventListener('click',      () => this.quitGame());
        document.getElementById('resume-btn').addEventListener('click',    () => this.togglePause());
        document.getElementById('save-btn').addEventListener('click',      () => this.saveGame());
        document.getElementById('export-btn').addEventListener('click',    () => GameState.exportFile(this));
        document.getElementById('main-menu-btn').addEventListener('click', () => this.returnToMainMenu());

        document.getElementById('o2-toggle').addEventListener('click',    () => this.toggleSystem('o2'));
        document.getElementById('co2-toggle').addEventListener('click',   () => this.toggleSystem('co2'));
        document.getElementById('power-toggle').addEventListener('click', () => this.toggleSystem('power'));

        document.getElementById('o2-repair-btn').addEventListener('click',    () => this.startRepair('o2'));
        document.getElementById('co2-repair-btn').addEventListener('click',   () => this.startRepair('co2'));
        document.getElementById('power-repair-btn').addEventListener('click', () => this.startRepair('power'));

        document.getElementById('repair-queue-btn').addEventListener('click',     () => this.toggleTaskQueueScreen());
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
            if (e.key === 'Escape' && this.gameActive) this.togglePause();
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
        this.introModal.style.display   = 'flex';

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
        this.introModal.style.display = 'none';
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
        this.seedScreen.style.display   = 'flex';
    }

    _confirmSeedAndShowIntro() {
        const parsed = parseInt(document.getElementById('seed-input').value, 10);
        this._pendingSeed = Number.isFinite(parsed) && parsed >= 0 ? parsed : this.commsNav.rollSeed();
        this.seedScreen.style.display = 'none';
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
        this.crewManager.resetRoster();
        this.crew                   = this.crewManager.aliveCount();
        this.commsNav.generate(this._pendingSeed); // chosen on the seed screen before the intro
        this._pendingSeed           = null;

        this._resetPauseMenuUI();
        this._applySpeedUI();
        this._syncTargetInputs();
        this._updateShipIdentityUI();
        this.launchScreen.style.display  = 'none';
        this.gameContainer.style.display = 'block';
        this._startTimer();
        this._startAutosaveTimer();
        this.updateDisplay();
        this.saveGame(); // persist the freshly-created slot immediately
    }

    // ── Load screen ─────────────────────────────────────────────────────────

    async _openLoadScreen() {
        this.launchScreen.style.display = 'none';
        this.loadScreen.style.display   = 'flex';
        await this._renderLoadScreen();
    }

    _closeLoadScreen() {
        this.loadScreen.style.display   = 'none';
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
            this._startTimer();
            this._startAutosaveTimer();
            this.updateDisplay();
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
            this.pauseMenu.style.display     = 'none';
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

        this.pauseMenu.style.display = 'flex';
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
        if (this.systems[name].destroyed) return;
        this.systems[name].active = !this.systems[name].active;
        this.updateDisplay();
    }

    startRepair(systemKey) {
        if (!this.gameActive || this.gamePaused) return;
        this.repairManager.startRepair(systemKey);
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
        const isOpen = this.taskQueueScreen.style.display === 'flex';
        this.taskQueueScreen.style.display = isOpen ? 'none' : 'flex';
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

        const input = prompt('Dump what percentage of the black water tank? (0-100)', '50');
        if (input === null) return;
        const pct = parseFloat(input);
        if (!isFinite(pct) || pct <= 0) return;

        const fraction = Math.min(100, pct) / 100;
        black.liquidL *= (1 - fraction);
        black.solidL  *= (1 - fraction);
        black.current  = black.liquidL + black.solidL;
        black.level    = (black.current / black.capacity) * 100;
        this.updateDisplay();
    }

    togglePause() {
        if (!this.gameActive) return;
        this.gamePaused = !this.gamePaused;
        this.pauseMenu.style.display = this.gamePaused ? 'flex' : 'none';
    }

    async saveGame() {
        try {
            await GameState.saveServer(this);
            this._showSaveStatus('Saved');
        } catch (e) {
            this._showSaveStatus('Save failed — is server.js running?', true);
        }
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
            this.pauseMenu.style.display     = 'none';
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
            this.gameTime += this.gameSpeed;
            this.systemUpdate.update(this.gameSpeed);
            this.updateDisplay();
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
        this._displayEnvironment();
        this._displayRepairQueue();
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
            'Generator: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>';
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
            'Scrubber: <strong>' + (sys.active ? 'ON' : 'OFF') + '</strong>';
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

        const rtEl = document.getElementById('freshwater-runtime');
        if (sys.current <= 0) {
            rtEl.textContent = 'EMPTY';
        } else if (sys.consumeRateLhr > 0) {
            const hrs = sys.current / sys.consumeRateLhr;
            rtEl.textContent = hrs >= 240 ? Math.round(hrs / 24) + ' days' : Math.round(hrs) + ' hrs';
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

        document.getElementById('card-freshwater').className = 'system-card' + this._cardMod(sys.status);
    }

    _displayBlackWater() {
        const sys = this.systems.blackWater;
        document.getElementById('blackwater-level').textContent    = sys.current.toFixed(2) + ' L';
        document.getElementById('blackwater-indicator').style.left = Math.min(100, sys.level).toFixed(1) + '%';
        document.getElementById('blackwater-liquid').textContent   = sys.liquidL.toFixed(2) + ' L';
        document.getElementById('blackwater-solid').textContent    = sys.solidL.toFixed(2) + ' L';
        document.getElementById('blackwater-rate').textContent     = '+' + sys.fillRateLhr.toFixed(3) + ' L/hr';

        this._setBadge('blackwater-status-badge', sys.status);
        document.getElementById('blackwater-status').innerHTML =
            'Tank: <strong>' + Math.round(sys.level) + '%</strong> full';
        const dumpBtn = document.getElementById('blackwater-dump-btn');
        dumpBtn.disabled = sys.current <= 0;
        document.getElementById('card-blackwater').className = 'system-card' + this._cardMod(sys.status);
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

        if (this.crewScreen.style.display === 'flex' && !this._editingCrewId) {
            this._renderCrewScreen();
        }
    }

    _openCrewScreen() {
        this.crewScreen.style.display = 'flex';
        this._renderCrewScreen();
    }

    _closeCrewScreen() {
        this.crewScreen.style.display = 'none';
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

            return `
                <li class="crew-card" data-crew-id="${member.id}">
                    <div class="crew-info">
                        <div class="crew-title">Crew ${idx + 1} <span class="crew-status-label">${this._crewStatusLabel(status)}</span></div>
                        <div class="task-progress-track crew-health-track"><div class="task-progress-fill ${this._healthBarClass(status)}" style="width:${Math.max(0, member.health)}%"></div></div>
                        <div class="task-meta">${member.health.toFixed(0)}% health</div>
                        ${editing ? this._renderShiftEditor(member) : `<div class="task-meta">Shifts: ${shiftsText}</div>`}
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
        if (!this._selectedCommsId) {
            const home = this.commsNav.home();
            if (home) this._selectedCommsId = home.id;
        }
        this.commsNavScreen.style.display = 'flex';
        this._renderCommsNavScreen();
    }

    _closeCommsNavScreen() {
        this.commsNavScreen.style.display = 'none';
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

        this._renderCommsLocationList();

        const planeEl = document.getElementById('comms-plane-views');
        if (planeEl) {
            planeEl.innerHTML = this._planeSvg('x', 'y', 'Top View (X / Y)') + this._planeSvg('x', 'z', 'Side View (X / Z)');
            planeEl.querySelectorAll('.comms-marker').forEach(el =>
                el.addEventListener('click', () => this._selectCommsLocation(el.dataset.commsId))
            );
        }

        this._renderCommsDetailsPane();
    }

    _renderCommsLocationList() {
        const listEl = document.getElementById('comms-location-list');
        if (!listEl) return;
        const locations = this.commsLocations || [];

        if (!locations.length) {
            listEl.innerHTML = '<li class="task-empty">No charted locations.</li>';
            return;
        }

        listEl.innerHTML = locations.map(loc => {
            const selected = loc.id === this._selectedCommsId;
            const dist = loc.kind === 'home' ? null : this.commsNav.distanceFromHome(loc);
            return `
                <li class="comms-location-card${selected ? ' comms-location-selected' : ''}" data-comms-id="${loc.id}">
                    <div class="comms-location-name">${loc.name}</div>
                    <div class="comms-location-kind">${this._commsKindLabel(loc.kind)}</div>
                    ${dist != null ? `<div class="comms-location-distance">${dist.toFixed(2)} ly</div>` : ''}
                </li>`;
        }).join('');

        listEl.querySelectorAll('.comms-location-card').forEach(li =>
            li.addEventListener('click', () => this._selectCommsLocation(li.dataset.commsId))
        );
    }

    _renderCommsDetailsPane() {
        const paneEl = document.getElementById('comms-details-pane');
        if (!paneEl) return;
        const loc = (this.commsLocations || []).find(l => l.id === this._selectedCommsId);

        if (!loc) {
            paneEl.innerHTML = '<p class="task-empty">Select a location to view details.</p>';
            return;
        }

        const distanceLine = loc.kind === 'home'
            ? 'You are here'
            : `Distance: ${this.commsNav.distanceFromHome(loc).toFixed(2)} ly`;

        paneEl.innerHTML = `
            <h3 class="comms-details-title">${loc.name}</h3>
            <div class="comms-details-kind">${this._commsKindLabel(loc.kind)}</div>
            <div class="comms-details-coords">XYZ: ${loc.x.toFixed(2)}, ${loc.y.toFixed(2)}, ${loc.z.toFixed(2)}</div>
            <div class="comms-details-distance">${distanceLine}</div>
            <div class="comms-details-placeholder">
                <p class="task-empty">Trade and news services coming soon.</p>
            </div>`;
    }

    // Two orthographic plane views stand in for a full 3D render — axis1/axis2
    // pick which two coordinates to plot, the third is dropped for that view.
    _planeSvg(axis1, axis2, title) {
        const gridLines = [];
        for (let i = 0; i <= 10; i += 2) {
            gridLines.push(`<line x1="${i}" y1="0" x2="${i}" y2="10" class="comms-grid-line" />`);
            gridLines.push(`<line x1="0" y1="${i}" x2="10" y2="${i}" class="comms-grid-line" />`);
        }

        const markers = (this.commsLocations || []).map(loc => {
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

        if (sys.destroyed) {
            btn.style.display      = 'none';
            statusEl.style.display = '';
            statusEl.textContent   = 'Awaiting replacement part';
        } else if (task) {
            btn.style.display      = 'none';
            statusEl.style.display = '';
            statusEl.textContent   = `${task.status === 'in-progress' ? 'Repairing' : 'Queued'} (${task.band}) — ${task.hoursRemaining.toFixed(1)}h left`;
        } else if (pct >= 95) {
            btn.style.display      = 'none';
            statusEl.style.display = 'none';
        } else {
            const info = this.repairManager.describeRepair(systemKey);
            if (!info) { btn.style.display = 'none'; statusEl.style.display = 'none'; return; } // module_specs.json still loading
            btn.style.display      = '';
            statusEl.style.display = 'none';
            btn.textContent = info.band === 'replacement'
                ? `Replace (${info.hours}h, 50% cap, ${Math.round(info.destroyChance * 100)}% destroy risk)`
                : `Repair — ${info.band === 'major' ? 'Major' : 'Minor'} (${info.hours}h)`;
        }
    }

    _repairSystemLabel(systemKey) {
        return { o2: 'O₂ Generator', co2: 'CO₂ Scrubber', power: 'Power Generator' }[systemKey] ?? systemKey;
    }

    // Repairable systems not yet in the queue — the same set each system's own
    // card offers a "Repair" button for, surfaced centrally so a task can be
    // added from here too instead of having to find the right widget first.
    _renderRepairAvailable() {
        const listEl = document.getElementById('repair-available-list');
        if (!listEl) return;

        const rows = ['o2', 'co2', 'power']
            .filter(key => this.repairManager.canRepair(key))
            .map(key => {
                const info = this.repairManager.describeRepair(key);
                if (!info) return null; // module_specs.json still loading
                const desc = info.band === 'replacement'
                    ? `Replace (${info.hours}h, 50% cap, ${Math.round(info.destroyChance * 100)}% destroy risk)`
                    : `Repair — ${info.band === 'major' ? 'Major' : 'Minor'} (${info.hours}h)`;
                return `
                    <li class="task-card task-card-static" data-system-key="${key}">
                        <div class="task-info">
                            <div class="task-title">${this._repairSystemLabel(key)}</div>
                            <div class="task-meta">${desc}</div>
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

    _displayRepairQueue() {
        this._renderRepairAvailable();

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
            listEl.innerHTML = '<li class="task-empty">No repair tasks queued.</li>';
            return;
        }

        listEl.innerHTML = this.repairQueue.map(task => {
            const progressPct = Math.max(0, Math.min(100, 100 * (1 - task.hoursRemaining / task.totalHours)));
            return `
                <li class="task-card" draggable="true" data-task-id="${task.id}">
                    <span class="task-drag-handle">&#10495;</span>
                    <div class="task-info">
                        <div class="task-title">${this._repairSystemLabel(task.systemKey)} &mdash; ${task.band}</div>
                        <div class="task-progress-track"><div class="task-progress-fill" style="width:${progressPct.toFixed(1)}%"></div></div>
                        <div class="task-meta">${task.status === 'in-progress' ? 'In progress' : 'Queued'} &middot; ${task.hoursRemaining.toFixed(1)}h / ${task.totalHours}h</div>
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
