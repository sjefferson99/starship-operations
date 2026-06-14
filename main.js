class StarshipGame {
    constructor() {
        this.gameActive = false;
        this.gamePaused = false;
        this.timer      = null;
        this.credits    = 1000;
        this.crew       = 1;
        this.gameTime   = 0;
        this.gameSpeed  = 1;

        // Environment state
        this.inBreathableAtmosphere = true;
        this.ventsOpen              = false;

        this.systems = this._defaultSystems();

        this.launchScreen  = document.getElementById('launch-screen');
        this.gameContainer = document.getElementById('game-container');
        this.pauseMenu     = document.getElementById('pause-menu');
        this.creditsElement = document.getElementById('credits');
        this.timerElement   = document.getElementById('timer');
        this.dayElement     = document.getElementById('day-counter');
        this.crewElement    = document.getElementById('crew');

        this.systemUpdate = new SystemUpdate(this);
        this._bindEvents();
        this.updateDisplay();
    }

    _defaultSystems() {
        return {
            o2: {
                pct: 21.0, status: 'Normal', active: false,
                count: 1, tier: 1,
                consumptionLhr: 15.0, generationLhr: 0, ventLhr: 0, netLhr: -15.0,
                target: 21.0,
            },
            co2: {
                pct: 0.04, status: 'Normal', active: false,
                count: 1, tier: 1,
                productionLhr: 12.0, removalLhr: 0, ventLhr: 0, netLhr: 12.0,
                target: 0.04,
            },
            power: {
                level: 10, status: 'Warning', active: false,
                capacity: 1000, current: 100,
                count: 1, tier: 1,
                genOutputW: 0, o2DrawW: 0, co2DrawW: 0, netWhr: 0,
                target: 80.0,
            },
            fuel: {
                level: 10, status: 'Warning',
                capacity: 100, current: 10,
                consumeRateLhr: 0,
            },
        };
    }

    _bindEvents() {
        document.getElementById('new-game-btn').addEventListener('click',  () => this.startNewGame());
        document.getElementById('load-game-btn').addEventListener('click', () => this.loadGame());
        document.getElementById('quit-btn').addEventListener('click',      () => this.quitGame());
        document.getElementById('resume-btn').addEventListener('click',    () => this.togglePause());
        document.getElementById('save-btn').addEventListener('click',      () => this.saveGame());
        document.getElementById('export-btn').addEventListener('click',    () => GameState.exportFile(this));
        document.getElementById('main-menu-btn').addEventListener('click', () => this.returnToMainMenu());

        document.getElementById('o2-toggle').addEventListener('click',    () => this.toggleSystem('o2'));
        document.getElementById('co2-toggle').addEventListener('click',   () => this.toggleSystem('co2'));
        document.getElementById('power-toggle').addEventListener('click', () => this.toggleSystem('power'));

        document.getElementById('vent-toggle').addEventListener('click',  () => this.toggleVents());

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

        [1, 10, 100].forEach(s =>
            document.getElementById(`speed-${s}x`).addEventListener('click', () => this.setGameSpeed(s))
        );

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.gameActive) this.togglePause();
        });
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    startNewGame() {
        this.gameActive             = true;
        this.gamePaused             = false;
        this.gameTime               = 0;
        this.gameSpeed              = 1;
        this.credits                = 1000;
        this.crew                   = 1;
        this.inBreathableAtmosphere = true;
        this.ventsOpen              = false;
        this.systems                = this._defaultSystems();

        this._applySpeedUI();
        this._syncTargetInputs();
        this.launchScreen.style.display  = 'none';
        this.gameContainer.style.display = 'block';
        this._startTimer();
        this.updateDisplay();
    }

    async loadGame() {
        try {
            await GameState.loadServer(this);
            this.gameActive = true;
            this.gamePaused = false;
            this._applySpeedUI();
            this._syncTargetInputs();
            this.launchScreen.style.display  = 'none';
            this.gameContainer.style.display = 'block';
            this._startTimer();
            this.updateDisplay();
        } catch (e) { alert('Could not load save: ' + e.message); }
    }

    quitGame() {
        if (confirm('Quit to main menu?')) {
            this._stopTimer();
            this.gameActive = false;
            this.launchScreen.style.display  = 'block';
            this.gameContainer.style.display = 'none';
            this.pauseMenu.style.display     = 'none';
        }
    }

    endGame() {
        this._stopTimer();
        this.gameActive = false;
        const o2 = this.systems.o2, co2 = this.systems.co2;
        const reason = o2.pct <= 0              ? 'Oxygen depleted — crew asphyxiated.'
                     : co2.pct * 10000 >= 10000 ? 'CO₂ reached lethal levels.'
                     : 'Mission failed.';
        alert('GAME OVER\n\n' + reason);
    }

    toggleSystem(name) {
        if (!this.gameActive || this.gamePaused) return;
        this.systems[name].active = !this.systems[name].active;
        this.updateDisplay();
    }

    toggleVents() {
        if (!this.gameActive || this.gamePaused || !this.inBreathableAtmosphere) return;
        this.ventsOpen = !this.ventsOpen;
        this.updateDisplay();
    }

    togglePause() {
        if (!this.gameActive) return;
        this.gamePaused = !this.gamePaused;
        this.pauseMenu.style.display = this.gamePaused ? 'block' : 'none';
    }

    async saveGame() {
        try {
            await GameState.saveServer(this);
            this._showSaveStatus('Saved to savegame/save.json');
        } catch (e) {
            this._showSaveStatus('Save failed — is server.js running?', true);
        }
    }

    returnToMainMenu() {
        if (confirm('Return to main menu? Unsaved progress will be lost.')) {
            this._stopTimer();
            this.gameActive = false;
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
        [1, 10, 100].forEach(s => {
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

    _stopTimer() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    // ── Display ─────────────────────────────────────────────────────────────

    updateDisplay() {
        this.creditsElement.textContent = this.credits;
        this.crewElement.textContent    = this.crew;

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
        this._displayEnvironment();
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
        document.getElementById('card-o2').className = 'system-card' + this._cardMod(sys.status);
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
        document.getElementById('card-co2').className = 'system-card' + this._cardMod(sys.status);
    }

    _displayPower() {
        const sys = this.systems.power;
        document.getElementById('power-level').textContent    = Math.round(sys.level) + '%';
        document.getElementById('power-wh').textContent       = Math.round(sys.current);
        document.getElementById('power-indicator').style.left = sys.level.toFixed(1) + '%';

        const genEl = document.getElementById('power-gen-output');
        genEl.textContent = sys.genOutputW + ' W';
        genEl.className   = 'rate-value ' + (sys.genOutputW > 0 ? 'rate-pos-good' : '');

        document.getElementById('power-o2-draw').textContent  = sys.o2DrawW  > 0 ? '−' + sys.o2DrawW  + ' W' : '0 W';
        document.getElementById('power-co2-draw').textContent = sys.co2DrawW > 0 ? '−' + sys.co2DrawW + ' W' : '0 W';

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
        document.getElementById('card-power').className = 'system-card' + this._cardMod(sys.status);
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
}

document.addEventListener('DOMContentLoaded', () => { new StarshipGame(); });
