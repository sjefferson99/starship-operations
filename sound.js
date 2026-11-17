// Sound effects, synthesised with the Web Audio API — there are no audio
// files. The tone is deliberately calm: soft clicks, a low hum, gentle chimes.
//
// SoundManager is an observer, not a participant. It never touches game
// state and the game never calls it: UI sounds come from one delegated
// document click listener, and everything else (hum level, alerts, repairs
// finishing, vents, purchases…) from comparing a small snapshot of game state
// a few times a second. That is why nothing in main.js knows it exists —
// this file wires itself up at the bottom, after main.js has created the game.
// It also owns its own settings panel (#sound-screen).
//
// Browsers only allow audio after a user gesture, so the AudioContext is
// created on the first pointer/key press rather than at load.

class SoundManager {
    constructor(game) {
        this.game = game;
        this.ctx  = null;   // created lazily on the first user gesture

        // ── Mix ─────────────────────────────────────────────────────────────
        // Four channels plus a master, each a 0–1 slider in the Sounds panel.
        // A channel at its default slider position plays at BASE loudness (a
        // multiplier on each recipe's own level); the top of the slider is
        // 1 / DEFAULT_LEVEL times that, so there is always headroom above the
        // default. A limiter on the output keeps a loud mix from clipping.
        this.CHANNELS = [
            { key: 'ui',     label: 'Buttons',     hint: 'Clicks and switches',                   test: 'click'   },
            { key: 'effect', label: 'Effects',     hint: 'Comms, vents, repairs, purchases',       test: 'comms'   },
            { key: 'alert',  label: 'Alerts',      hint: 'Warning and critical chimes',            test: 'warning' },
            { key: 'hum',    label: 'Systems hum', hint: 'Generator and running equipment',        test: null      },
        ];
        // BASE and MASTER_MAX are the mix Stephen settled on by ear (2026-11-17),
        // re-centred so that every slider's default position reproduces it.
        this.BASE          = { ui: 1.6, effect: 2.8, alert: 3.6, hum: 0.5 };
        this.DEFAULT_LEVEL = 0.4;   // slider position that gives BASE — so the maximum is 2.5× the default
        this.MASTER_MAX    = 2.0;   // master gain at the top of its slider (default 50% = unity)
        this.DEFAULTS      = { enabled: true, master: 0.5, ui: 0.4, effect: 0.4, alert: 0.4, hum: 0.4 };
        this.UI_SOUNDS     = ['click', 'close', 'switchOn', 'switchOff'];
        this.ALERT_SOUNDS  = ['warning', 'critical'];

        // v2: slider positions mean something different from the first version
        // of the panel, so levels saved under the old key are not carried over
        // (only whether sound was on).
        this.SETTINGS_KEY     = 'starshipOps.soundSettings.v2';
        this.OLD_SETTINGS_KEY = 'starshipOps.soundSettings';
        this.LEGACY_OFF_KEY   = 'starshipOps.soundOff'; // the original on/off-only preference
        this.settings = this._loadSettings();

        this.POLL_MS           = 400;
        this.ALERT_MIN_GAP_MS  = 4000;  // alerts never stack up, even at 1000× speed
        this.CHIME_MIN_GAP_MS  = 1200;

        // Hum: the generator is the bed, each other running system adds to it.
        this.HUM_GENERATOR   = 0.5;
        this.HUM_PER_SYSTEM  = 0.17;
        this.POWERED_KEYS    = ['o2', 'co2', 'transceiver', 'waterMaker'];
        this.STATUS_KEYS     = ['o2', 'co2', 'power', 'fuel', 'freshWater', 'blackWater', 'transceiver', 'waterMaker'];

        this.log   = [];    // names of the most recent sounds — for tests and debugging
        this._mix  = 1;     // loudness of the channel currently being scheduled (set in play())
        this._prev = null;  // last state snapshot (null = nothing to compare against yet)
        this._lastAlertAt = 0;
        this._lastChimeAt = 0;
        this._humPreviewUntil = 0;

        this._bindPanel();

        const unlock = () => this._ensureContext();
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('keydown', unlock, true);

        // Capture phase: a toggle button's on/off class is read before the
        // game's own handler flips it.
        document.addEventListener('click', e => this._onClick(e), true);

        setInterval(() => this._poll(), this.POLL_MS);
    }

    get enabled() { return this.settings.enabled; }

    // ── Settings ────────────────────────────────────────────────────────────

    _loadSettings() {
        const settings = { ...this.DEFAULTS };
        try {
            const saved = JSON.parse(localStorage.getItem(this.SETTINGS_KEY) ?? 'null');
            if (saved && typeof saved === 'object') {
                Object.keys(this.DEFAULTS).forEach(key => {
                    if (key === 'enabled') { if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled; }
                    else if (Number.isFinite(saved[key])) settings[key] = Math.max(0, Math.min(1, saved[key]));
                });
            } else {
                const old = JSON.parse(localStorage.getItem(this.OLD_SETTINGS_KEY) ?? 'null');
                if (old && typeof old.enabled === 'boolean') settings.enabled = old.enabled;
                else if (localStorage.getItem(this.LEGACY_OFF_KEY) === '1') settings.enabled = false;
            }
        } catch { /* unreadable — defaults */ }
        return settings;
    }

    _saveSettings() {
        try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* not persisted */ }
    }

    setEnabled(on) {
        this.settings.enabled = !!on;
        this._settingsChanged();
        if (on) this.play('click');
    }

    // `key` is 'master' or a channel key; `level` is the 0–1 slider position.
    setLevel(key, level) {
        if (!(key in this.DEFAULTS) || key === 'enabled') return;
        this.settings[key] = Math.max(0, Math.min(1, level));
        this._settingsChanged();
    }

    resetSettings() {
        this.settings = { ...this.DEFAULTS };
        this._settingsChanged();
    }

    _settingsChanged() {
        this._saveSettings();
        if (this.master) this.master.gain.setTargetAtTime(this._masterGain(), this.ctx.currentTime, 0.03);
        this._applyHum(0.08);
        this._renderPanel();
    }

    _masterGain() {
        return this.settings.enabled ? this.settings.master * this.MASTER_MAX : 0;
    }

    // Loudness multiplier for a channel at its current slider position.
    channelGain(key) {
        return this.BASE[key] * (this.settings[key] / this.DEFAULT_LEVEL);
    }

    // ── Settings panel ──────────────────────────────────────────────────────

    _bindPanel() {
        this.toggleEl = document.getElementById('sound-toggle');
        this.screenEl = document.getElementById('sound-screen');
        if (!this.toggleEl || !this.screenEl) return;

        const rowsEl = document.getElementById('sound-channel-rows');
        rowsEl.innerHTML = [{ key: 'master', label: 'Overall volume', hint: 'Everything', test: null }, ...this.CHANNELS].map(ch => `
            <div class="sound-row" data-channel="${ch.key}">
                <div class="sound-row-label">
                    <span class="sound-row-name">${ch.label}</span>
                    <span class="sound-row-hint">${ch.hint}</span>
                </div>
                <input type="range" class="sound-slider" id="sound-level-${ch.key}" min="0" max="100" step="1" aria-label="${ch.label} volume">
                <span class="sound-row-value" id="sound-value-${ch.key}"></span>
                ${ch.key === 'master' ? '<span class="sound-test-spacer"></span>'
                                      : `<button class="sound-test-btn" data-channel="${ch.key}" title="Play a sample">Test</button>`}
            </div>`).join('');

        this.toggleEl.addEventListener('click', () => this.openPanel());
        document.getElementById('sound-screen-close-btn').addEventListener('click', () => this.closePanel());
        document.getElementById('sound-enabled-toggle').addEventListener('click', () => this.setEnabled(!this.enabled));
        document.getElementById('sound-reset-btn').addEventListener('click', () => this.resetSettings());

        rowsEl.querySelectorAll('.sound-slider').forEach(slider =>
            slider.addEventListener('input', () => this.setLevel(slider.closest('.sound-row').dataset.channel, Number(slider.value) / 100))
        );
        rowsEl.querySelectorAll('.sound-test-btn').forEach(btn =>
            btn.addEventListener('click', () => this.testChannel(btn.dataset.channel))
        );
        this._renderPanel();
    }

    openPanel()  { this.screenEl.style.display = 'flex'; this._renderPanel(); }
    closePanel() { this.screenEl.style.display = 'none'; }

    _renderPanel() {
        if (!this.toggleEl || !this.screenEl) return;
        this.toggleEl.textContent = this.enabled ? 'Sounds' : 'Sounds: Off';
        this.toggleEl.title = 'Sound settings';

        const onBtn = document.getElementById('sound-enabled-toggle');
        onBtn.textContent = this.enabled ? 'Turn All Sounds Off' : 'Turn Sounds On';
        onBtn.className   = 'toggle-btn ' + (this.enabled ? 'btn-on' : 'btn-off');
        document.getElementById('sound-enabled-status').innerHTML = 'Sounds: <strong>' + (this.enabled ? 'ON' : 'OFF') + '</strong>';

        ['master', ...this.CHANNELS.map(ch => ch.key)].forEach(key => {
            const pct = Math.round(this.settings[key] * 100);
            const slider = document.getElementById(`sound-level-${key}`);
            if (Number(slider.value) !== pct) slider.value = pct; // don't fight the thumb mid-drag
            slider.disabled = !this.enabled;
            document.getElementById(`sound-value-${key}`).textContent = pct + '%';
        });
    }

    // Plays a sample of a channel at its current level. The hum has no
    // one-shot sound, so it is held on briefly instead (whatever the ship is doing).
    testChannel(key) {
        const channel = this.CHANNELS.find(ch => ch.key === key);
        if (!channel) return;
        if (channel.test) { this.play(channel.test); return; }
        this._humPreviewUntil = Date.now() + 2500;
        this._applyHum(0.15);
        setTimeout(() => this._applyHum(0.4), 2600);
    }

    // ── Audio plumbing ──────────────────────────────────────────────────────

    _ensureContext() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
            return;
        }
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return; // no Web Audio — the game simply stays silent
        try {
            this.ctx    = new AudioCtx();
            this.master = this.ctx.createGain();
            this.master.gain.value = this._masterGain();

            // Safety limiter: with every slider at maximum the mix could
            // otherwise clip. At default levels it does nothing.
            const limiter = this.ctx.createDynamicsCompressor();
            limiter.threshold.value = -6;
            limiter.knee.value      = 6;
            limiter.ratio.value     = 12;
            limiter.attack.value    = 0.003;
            limiter.release.value   = 0.15;
            this.master.connect(limiter).connect(this.ctx.destination);

            this._buildHum();
        } catch { this.ctx = null; }
    }

    // One enveloped oscillator note. `at` = seconds from now.
    _tone(freq, { at = 0, dur = 0.12, gain = 0.08, type = 'sine', attack = 0.008, slideTo = null } = {}) {
        const t0  = this.ctx.currentTime + at;
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this._mix), t0 + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(env).connect(this.master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    _noiseBuffer() {
        if (!this._noise) {
            const length = this.ctx.sampleRate * 2;
            this._noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
            const data = this._noise.getChannelData(0);
            for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        }
        return this._noise;
    }

    // A band of filtered noise, optionally sweeping — hisses, whooshes, static.
    _hiss({ at = 0, dur = 0.4, gain = 0.05, from = 1200, to = null, q = 1.2, attack = 0.03 } = {}) {
        const t0  = this.ctx.currentTime + at;
        const src = this.ctx.createBufferSource();
        const filter = this.ctx.createBiquadFilter();
        const env = this.ctx.createGain();
        src.buffer = this._noiseBuffer();
        src.loop = true;
        filter.type = 'bandpass';
        filter.Q.value = q;
        filter.frequency.setValueAtTime(from, t0);
        if (to) filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this._mix), t0 + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(filter).connect(env).connect(this.master);
        src.start(t0);
        src.stop(t0 + dur + 0.05);
    }

    // ── The sounds ──────────────────────────────────────────────────────────
    // Each is a few notes at most. The levels here are relative to each other
    // within a channel; overall loudness is the channel's job (see BASE).

    _recipes() {
        return {
            click:     () => this._tone(720, { dur: 0.05, gain: 0.035, slideTo: 560 }),
            close:     () => this._tone(420, { dur: 0.07, gain: 0.03, slideTo: 300 }),
            switchOn:  () => { this._tone(330, { dur: 0.09, gain: 0.05 }); this._tone(495, { at: 0.07, dur: 0.14, gain: 0.05 }); },
            switchOff: () => { this._tone(495, { dur: 0.09, gain: 0.045 }); this._tone(330, { at: 0.07, dur: 0.16, gain: 0.045 }); },

            // Comms & Nav: a breath of static, then a three-note handshake.
            comms: () => {
                this._hiss({ dur: 0.35, gain: 0.03, from: 2400, to: 900, q: 2 });
                [1320, 1760, 1480].forEach((f, i) => this._tone(f, { at: 0.12 + i * 0.075, dur: 0.06, gain: 0.03, type: 'triangle' }));
            },

            // Alerts are soft chimes, not alarms: one note for a warning, a
            // falling pair for something critical.
            warning:  () => this._tone(660, { dur: 0.7, gain: 0.05, attack: 0.04 }),
            critical: () => { this._tone(660, { dur: 0.5, gain: 0.06, attack: 0.03 }); this._tone(494, { at: 0.28, dur: 0.9, gain: 0.06, attack: 0.03 }); },

            // A repair stage landing: a small rising pair.
            repaired:  () => { this._tone(523, { dur: 0.18, gain: 0.05 }); this._tone(784, { at: 0.12, dur: 0.45, gain: 0.05 }); },
            destroyed: () => { this._tone(140, { dur: 0.6, gain: 0.09, slideTo: 55, type: 'triangle' }); this._hiss({ dur: 0.3, gain: 0.04, from: 500, to: 120 }); },

            ventOpen:  () => this._hiss({ dur: 0.9, gain: 0.05, from: 500, to: 2600, q: 0.8, attack: 0.1 }),
            ventClose: () => this._hiss({ dur: 0.6, gain: 0.045, from: 2200, to: 400, q: 0.8, attack: 0.04 }),
            flush:     () => this._hiss({ dur: 1.1, gain: 0.06, from: 1800, to: 180, q: 1.5, attack: 0.05 }),

            purchase: () => [880, 1108, 1320].forEach((f, i) => this._tone(f, { at: i * 0.07, dur: 0.16, gain: 0.04, type: 'triangle' })),
            fine:     () => { this._tone(392, { dur: 0.16, gain: 0.045, type: 'triangle' }); this._tone(294, { at: 0.13, dur: 0.3, gain: 0.045, type: 'triangle' }); },
            tip:      () => this._tone(988, { dur: 0.25, gain: 0.03, attack: 0.02, slideTo: 1175 }),
            gameOver: () => [392, 330, 262, 196].forEach((f, i) => this._tone(f, { at: i * 0.45, dur: 1.1, gain: 0.06, attack: 0.05 })),
        };
    }

    channelOf(name) {
        return this.UI_SOUNDS.includes(name) ? 'ui' : this.ALERT_SOUNDS.includes(name) ? 'alert' : 'effect';
    }

    play(name) {
        if (!this.enabled) return;
        this.log.push(name);
        if (this.log.length > 50) this.log.shift();
        if (!this.ctx) return;
        const recipe = (this._recipeCache ??= this._recipes())[name];
        // Every note the recipe schedules picks up its channel's loudness.
        this._mix = this.channelGain(this.channelOf(name));
        if (recipe && this._mix > 0) { try { recipe(); } catch { /* never let a sound break the game */ } }
    }

    // ── Hum ─────────────────────────────────────────────────────────────────
    // Two layers, both always running and faded by level: a low bed for the
    // generator, and a slightly brighter layer that grows with each other
    // system that's running. A slow wobble keeps it from sounding like a test tone.

    _buildHum() {
        const ctx = this.ctx;

        // The wobble is a tremolo stage *after* the generator layer's level
        // control (gain 1 ± a little), so when that level is zero the result is
        // true silence rather than a faint leftover.
        const tremolo = ctx.createGain();
        tremolo.gain.value = 1;
        tremolo.connect(this.master);
        const wobble = ctx.createOscillator();
        const depth  = ctx.createGain();
        wobble.frequency.value = 0.13;
        depth.gain.value = 0.08;
        wobble.connect(depth).connect(tremolo.gain);
        wobble.start();

        const layer = (partials, cutoff, destination) => {
            const out = ctx.createGain();
            out.gain.value = 0;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = cutoff;
            partials.forEach(([freq, level, type]) => {
                const osc = ctx.createOscillator();
                const g   = ctx.createGain();
                osc.type = type;
                osc.frequency.value = freq;
                g.gain.value = level;
                osc.connect(g).connect(filter);
                osc.start();
            });
            filter.connect(out).connect(destination);
            return out;
        };
        this.humGenerator = layer([[55, 1, 'sine'], [82.6, 0.35, 'sine'], [110.4, 0.25, 'triangle']], 220, tremolo);
        this.humSystems   = layer([[165.3, 0.6, 'sine'], [220.7, 0.4, 'sine'], [331, 0.12, 'triangle']], 600, this.master);
    }

    // 0..1 for each layer, from what is actually running right now.
    humLevels() {
        const g = this.game;
        if (!g.gameActive || g.gamePaused) return { generator: 0, systems: 0 };
        const s = g.systems;
        const generatorRunning = s.power.active && !s.power.destroyed && s.fuel.current > 0;
        const fraction = s.power.powerFraction ?? 1;
        const running  = this.POWERED_KEYS.filter(key =>
            s[key] && s[key].active && !s[key].destroyed && s[key].installed !== false).length;
        return {
            generator: generatorRunning ? this.HUM_GENERATOR : 0,
            // Unpowered systems are silent; a brownout is proportionally quieter.
            systems: Math.min(1, running * this.HUM_PER_SYSTEM * fraction),
        };
    }

    _applyHum(timeConstant = 0.6) {
        if (!this.ctx || !this.humGenerator) return;
        // While "Test" is held on the hum row, play a typical busy ship instead of the real state.
        const previewing = Date.now() < this._humPreviewUntil;
        const levels = previewing ? { generator: this.HUM_GENERATOR, systems: this.HUM_PER_SYSTEM * 2 } : this.humLevels();
        const mix = this.channelGain('hum');
        const now = this.ctx.currentTime;
        this.humGenerator.gain.setTargetAtTime(levels.generator * 0.09 * mix, now, timeConstant);
        this.humSystems.gain.setTargetAtTime(levels.systems * 0.035 * mix, now, timeConstant);
    }

    // ── UI clicks ───────────────────────────────────────────────────────────

    _onClick(e) {
        const el = e.target.closest('button, .stat-clickable, .comms-location-card, .comms-marker, .crew-idle-text');
        if (!el || el.disabled) return;
        // These make their own sound (a sample, or the on/off confirmation).
        if (el.classList.contains('sound-test-btn') || el.id === 'sound-enabled-toggle') return;

        if (el.id === 'comms-nav-btn') return this.play('comms');
        if (el.classList.contains('overlay-close-btn') || el.id === 'resume-btn') return this.play('close');
        if (el.classList.contains('toggle-btn') && el.id !== 'blackwater-dump-btn') {
            return this.play(el.classList.contains('btn-on') ? 'switchOff' : 'switchOn');
        }
        this.play('click');
    }

    // ── State watching ──────────────────────────────────────────────────────

    _snapshot() {
        const g = this.game, s = g.systems;
        const rank = { Normal: 0, Warning: 1, Critical: 2 };
        const crewRank = { normal: 0, warning: 1, critical: 2, unconscious: 2, dead: 2 };
        const modules = {};
        this.POWERED_KEYS.concat('power').forEach(key => {
            if (s[key] && s[key].installed !== false) modules[key] = { pct: s[key].repairPct ?? 100, destroyed: !!s[key].destroyed };
        });
        return {
            saveId: g.saveId,
            // Per-system ranks, so one thing getting worse is heard even while another is already bad.
            ranks: this.STATUS_KEYS.map(key => (s[key] && s[key].installed !== false ? rank[s[key].status] ?? 0 : 0))
                .concat(crewRank[g.crewManager.worstStatus()] ?? 0),
            modules,
            ventsOpen: g.ventsOpen,
            blackWater: s.blackWater.current,
            stock: (g.market || []).length,
            credits: g.credits,
            tip: g.tour && g.tour.tip ? g.tour.tip.id : null,
        };
    }

    _poll() {
        const g = this.game;
        this._applyHum();

        if (!g.gameActive) {
            // The game just ended on its own (not a quit to menu) — crew all dead.
            if (this._prev && document.getElementById('pause-title')?.textContent === 'GAME OVER') this.play('gameOver');
            this._prev = null;
            return;
        }
        if (g.gamePaused) return;

        const now  = this._snapshot();
        const prev = this._prev;
        this._prev = now;
        // Nothing to compare against on the first look at a new or freshly loaded game —
        // which also keeps a ship that starts out in a bad way from chiming at you on arrival.
        if (!prev || prev.saveId !== now.saveId) return;

        // Something got worse → one soft alert, rate-limited.
        const worsened = now.ranks.reduce((worst, rank, i) => (rank > prev.ranks[i] ? Math.max(worst, rank) : worst), 0);
        if (worsened > 0 && Date.now() - this._lastAlertAt >= this.ALERT_MIN_GAP_MS) {
            this._lastAlertAt = Date.now();
            this.play(worsened >= 2 ? 'critical' : 'warning');
        }

        // Modules: a jump up in repair level is a finished repair; a new `destroyed` is a failed one.
        let repaired = false, destroyed = false;
        Object.entries(now.modules).forEach(([key, mod]) => {
            const before = prev.modules[key];
            if (!before) return;
            if (mod.destroyed && !before.destroyed) destroyed = true;
            else if (mod.pct - before.pct >= 5 && now.stock === prev.stock) repaired = true;
        });
        if (destroyed) this.play('destroyed');
        else if (repaired && Date.now() - this._lastChimeAt >= this.CHIME_MIN_GAP_MS) {
            this._lastChimeAt = Date.now();
            this.play('repaired');
        }

        if (now.ventsOpen !== prev.ventsOpen) this.play(now.ventsOpen ? 'ventOpen' : 'ventClose');
        if (now.stock < prev.stock && now.credits < prev.credits) this.play('purchase');
        if (prev.blackWater - now.blackWater > 0.5 && now.credits < prev.credits) { this.play('flush'); this.play('fine'); }
        if (now.tip && now.tip !== prev.tip) this.play('tip');
    }
}

// Self-wiring: main.js registered its DOMContentLoaded handler first, so
// window.game exists by the time this one runs. Exposed on window for tests.
document.addEventListener('DOMContentLoaded', () => { window.sound = new SoundManager(window.game); });
