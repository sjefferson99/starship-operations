// Crew health & roster: owns the live crew list (merged from the read-only
// data/crew_manifest.json template + per-save health/shift/death state),
// the environment-driven health curve, and the resulting work effectiveness.
// RepairManager consumes isAvailable()/effectivenessMultiplier(); SystemUpdate
// drives update(dt) once per tick.

class CrewManager {
    constructor(game) {
        this.game = game;

        this.BASE_RATE_PCT_PER_HR = 15; // health gain/loss per hour at severity 1 (or recovering)
        this.UNCONSCIOUS_THRESHOLD = 20;
        this.WARNING_THRESHOLD    = 80;
        this.EFFECTIVENESS_K      = 3 / 6400; // timeFactor = 1 + K*(100-health)^2

        this._pendingSavedMembers = null; // saved roster received before the template finished loading
    }

    // ── Roster lifecycle ────────────────────────────────────────────────────

    _freshMember(tpl) {
        return {
            id: tpl.id,
            classes: tpl.classes,
            shifts: tpl.shifts.map(s => ({ ...s })),
            health: 100,
            varianceFactor: 0.7 + Math.random() * 0.6,
            dead: false,
        };
    }

    // New game: ignore any prior live state, rebuild fresh from the template.
    resetRoster() {
        this.game.crewManifest = (this.game.crewManifestTemplate || []).map(tpl => this._freshMember(tpl));
        this._pendingSavedMembers = null;
    }

    // Template finished (re)loading — merge it into whatever live roster
    // already exists (preserving health/shifts/variance), or apply a saved
    // roster that arrived before the template did.
    syncRoster() {
        const template = this.game.crewManifestTemplate || [];
        const existing = this.game.crewManifest || [];
        const savedById = this._pendingSavedMembers
            ? new Map(this._pendingSavedMembers.map(m => [m.id, m]))
            : null;

        this.game.crewManifest = template.map(tpl => {
            const live  = existing.find(m => m.id === tpl.id);
            const saved = savedById && savedById.get(tpl.id);
            if (saved) {
                return {
                    id: tpl.id, classes: tpl.classes,
                    shifts: (saved.shifts ?? tpl.shifts).map(s => ({ ...s })),
                    health: saved.health ?? 100,
                    varianceFactor: saved.varianceFactor ?? (0.7 + Math.random() * 0.6),
                    dead: saved.dead ?? false,
                };
            }
            if (live) return { ...live, classes: tpl.classes };
            return this._freshMember(tpl);
        });
        this._pendingSavedMembers = null;
    }

    // Loading a save: rehydrate health/variance/shifts/dead. If the template
    // hasn't finished loading yet, stash it — syncRoster() will pick it up.
    applySavedRoster(savedMembers) {
        const template = this.game.crewManifestTemplate || [];
        if (!template.length) {
            this._pendingSavedMembers = savedMembers ?? [];
            return;
        }
        this._pendingSavedMembers = savedMembers ?? [];
        this.syncRoster();
    }

    // ── Environment severity ────────────────────────────────────────────────
    // Continuous 0..1+ per factor, ramping across the same thresholds the
    // dashboard badges use (SystemUpdate._updateStatuses), summed so multiple
    // bad factors stack.

    _o2Severity() {
        const pct = this.game.systems.o2.pct;
        if (pct >= 19.5) return 0;
        if (pct >= 16) return ((19.5 - pct) / (19.5 - 16)) * 0.3;
        return 0.3 + (Math.min(16, 16 - pct) / 16) * 0.7;
    }

    _co2Severity() {
        const ppm = this.game.systems.co2.pct * 10000;
        if (ppm <= 1000) return 0;
        if (ppm <= 5000) return ((ppm - 1000) / (5000 - 1000)) * 0.3;
        return 0.3 + (Math.min(5000, ppm - 5000) / 5000) * 0.7;
    }

    environmentSeverity() {
        return this._o2Severity() + this._co2Severity();
    }

    // ── Health update ───────────────────────────────────────────────────────

    update(dt) {
        const severity = this.environmentSeverity();
        const hours = dt / 3600;

        (this.game.crewManifest || []).forEach(member => {
            if (member.dead) return;

            const rate = severity > 0
                ? -this.BASE_RATE_PCT_PER_HR * severity * member.varianceFactor
                :  this.BASE_RATE_PCT_PER_HR * member.varianceFactor;

            member.health = Math.max(0, Math.min(100, member.health + rate * hours));
            if (member.health <= 0) {
                member.health = 0;
                member.dead = true;
            }
        });
    }

    // ── Effectiveness / availability ────────────────────────────────────────

    effectivenessMultiplier(health) {
        const deficit = 100 - Math.max(0, Math.min(100, health));
        return 1 + this.EFFECTIVENESS_K * deficit * deficit;
    }

    isAvailable(member) {
        return !member.dead && member.health >= this.UNCONSCIOUS_THRESHOLD;
    }

    aliveCount() {
        return (this.game.crewManifest || []).filter(m => !m.dead).length;
    }

    // ── Status / display helpers ────────────────────────────────────────────

    statusFor(member) {
        if (member.dead) return 'dead';
        if (member.health < this.UNCONSCIOUS_THRESHOLD) return 'unconscious';
        if (member.health < 50) return 'critical';
        if (member.health < this.WARNING_THRESHOLD) return 'warning';
        return 'normal';
    }

    worstStatus() {
        const order = ['dead', 'unconscious', 'critical', 'warning', 'normal'];
        const statuses = (this.game.crewManifest || []).map(m => this.statusFor(m));
        for (const s of order) if (statuses.includes(s)) return s;
        return 'normal';
    }
}
