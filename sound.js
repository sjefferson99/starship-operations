// Sound effects, synthesised with the Web Audio API — there are no audio
// files. The tone is deliberately calm: soft clicks, a low hum, gentle chimes.
//
// SoundManager is an observer, not a participant. It never touches game
// state and the game never calls it: UI sounds come from one delegated
// document click listener, and everything else (hum level, alerts, repairs
// finishing, vents, purchases…) from comparing a small snapshot of game state
// a few times a second. That is why nothing in main.js knows it exists —
// this file wires itself up at the bottom, after main.js has created the game.
//
// Browsers only allow audio after a user gesture, so the AudioContext is
// created on the first pointer/key press rather than at load.

class SoundManager {
    constructor(game) {
        this.game    = game;
        this.ctx     = null;   // created lazily on the first user gesture
        this.OFF_KEY = 'starshipOps.soundOff';
        this.enabled = this._stored() !== '1';

        this.VOLUME            = 0.5;   // master level when sound is on
        this.POLL_MS           = 400;
        this.ALERT_MIN_GAP_MS  = 4000;  // alerts never stack up, even at 1000× speed
        this.CHIME_MIN_GAP_MS  = 1200;

        // Hum: the generator is the bed, each other running system adds to it.
        this.HUM_GENERATOR   = 0.5;
        this.HUM_PER_SYSTEM  = 0.17;
        this.POWERED_KEYS    = ['o2', 'co2', 'transceiver', 'waterMaker'];
        this.STATUS_KEYS     = ['o2', 'co2', 'power', 'fuel', 'freshWater', 'blackWater', 'transceiver', 'waterMaker'];

        this.log   = [];    // names of the most recent sounds — for tests and debugging
        this._prev = null;  // last state snapshot (null = nothing to compare against yet)
        this._lastAlertAt = 0;
        this._lastChimeAt = 0;

        this.toggleEl = document.getElementById('sound-toggle');
        if (this.toggleEl) this.toggleEl.addEventListener('click', () => this.setEnabled(!this.enabled));
        this._renderToggle();

        const unlock = () => this._ensureContext();
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('keydown', unlock, true);

        // Capture phase: a toggle button's on/off class is read before the
        // game's own handler flips it.
        document.addEventListener('click', e => this._onClick(e), true);

        setInterval(() => this._poll(), this.POLL_MS);
    }

    // ── Preference ──────────────────────────────────────────────────────────

    _stored() { try { return localStorage.getItem(this.OFF_KEY); } catch { return null; } }

    setEnabled(on) {
        this.enabled = on;
        try { on ? localStorage.removeItem(this.OFF_KEY) : localStorage.setItem(this.OFF_KEY, '1'); } catch { /* not persisted */ }
        if (this.master) this.master.gain.setTargetAtTime(on ? this.VOLUME : 0, this.ctx.currentTime, 0.05);
        this._renderToggle();
        if (on) this.play('click');
    }

    _renderToggle() {
        if (!this.toggleEl) return;
        this.toggleEl.textContent = this.enabled ? 'Sound: On' : 'Sound: Off';
        this.toggleEl.title = this.enabled ? 'Mute sound effects' : 'Turn sound effects on';
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
            this.master.gain.value = this.enabled ? this.VOLUME : 0;
            this.master.connect(this.ctx.destination);
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
        env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
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
        env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(filter).connect(env).connect(this.master);
        src.start(t0);
        src.stop(t0 + dur + 0.05);
    }

    // ── The sounds ──────────────────────────────────────────────────────────
    // Each is a few notes at most. Anything recurring is kept very quiet.

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

    play(name) {
        if (!this.enabled) return;
        this.log.push(name);
        if (this.log.length > 50) this.log.shift();
        if (!this.ctx) return;
        const recipe = (this._recipeCache ??= this._recipes())[name];
        if (recipe) { try { recipe(); } catch { /* never let a sound break the game */ } }
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

    _applyHum() {
        if (!this.ctx || !this.humGenerator) return;
        const levels = this.humLevels();
        const now = this.ctx.currentTime;
        this.humGenerator.gain.setTargetAtTime(levels.generator * 0.09, now, 0.6);
        this.humSystems.gain.setTargetAtTime(levels.systems * 0.035, now, 0.6);
    }

    // ── UI clicks ───────────────────────────────────────────────────────────

    _onClick(e) {
        const el = e.target.closest('button, .stat-clickable, .comms-location-card, .comms-marker, .crew-idle-text');
        if (!el || el.disabled || el === this.toggleEl) return;

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
            severity: Math.max(
                crewRank[g.crewManager.worstStatus()] ?? 0,
                ...this.STATUS_KEYS.map(key => (s[key] && s[key].installed !== false ? rank[s[key].status] ?? 0 : 0))
            ),
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
