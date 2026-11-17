// Notifications — a list of things that happened, opened from the header's
// Notifications pill. Each entry has the game time it happened, a level
// (critical / warning / good / info), a title and an optional detail line.
//
// Most entries come from comparing a small snapshot of game state with the one
// before it, every time the dashboard is redrawn (each tick, and after each
// player action) — the same events sound.js chimes for, from the same kind of
// comparison: a status getting worse, a repair stage landing, a module
// destroyed, purchases, sales, a fine. A few events have no visible state to
// compare (an infection), and the code where they happen calls add() instead.
// Switching vents on and off is not listed: it's the player's own click, heard
// as a switch, not news.
//
// The list is game state: it's saved with the game (world.notifications, the
// `notifications` table in db.js) and restored by GameState.restore, so going
// back on the Timeline shows the list as it was at that point.

class Notifications {
    constructor(game) {
        this.game = game;
        this.list = [];        // newest first
        this.MAX  = 100;       // oldest entries drop off beyond this
        this._prev = null;     // last state snapshot (null = nothing to compare against yet)
        this._version = 0;     // bumped on every change, so the panel only redraws when needed

        this.RANK = { Normal: 0, Warning: 1, Critical: 2 };
        this.STATUS_LABELS = {
            o2: 'Oxygen', co2: 'CO₂', power: 'Battery', fuel: 'Fuel', freshWater: 'Fresh water',
            blackWater: 'Black water', transceiver: 'Transceiver', waterMaker: 'Water maker',
        };
        this.MODULE_LABELS = {
            o2: 'O₂ Generator', co2: 'CO₂ Scrubber', power: 'Power Generator',
            transceiver: 'Transceiver', waterMaker: 'Water Maker',
        };
        this.CREW_RANK = { normal: 0, warning: 1, critical: 2, unconscious: 3, dead: 4 };

        this.pillEl  = document.getElementById('notifications-pill');
        this.countEl = document.getElementById('notifications-count');
        this.panelEl = document.getElementById('notifications-panel');
        this.listEl  = document.getElementById('notifications-list');
        this.clearEl = document.getElementById('notifications-clear-btn');
        this._bindPanel();
    }

    // ── The list ────────────────────────────────────────────────────────────

    // `key` groups repeats: a new entry with the same key and title as one
    // already listed replaces it at the top with a count, so a status flicking
    // back and forth at high speed doesn't flood the list.
    add({ key = null, level = 'info', title, detail = '' }) {
        const at = this.game.gameTime;
        const same = key != null ? this.list.findIndex(n => n.key === key && n.title === title) : -1;
        let entry;
        if (same >= 0) {
            entry = this.list.splice(same, 1)[0];
            entry.count = (entry.count ?? 1) + 1;
            entry.gameTime = at;
            entry.level = level;
            entry.detail = detail;
        } else {
            entry = { id: this._nextId(), key, level, title, detail, gameTime: at, count: 1 };
        }
        this.list.unshift(entry);
        if (this.list.length > this.MAX) this.list.length = this.MAX;
        this._changed();
        return entry;
    }

    // Ids only need to be unique within a save, and must not use a gameplay roll.
    _nextId() {
        const highest = this.list.reduce((max, n) => Math.max(max, Number(String(n.id).replace(/^n-/, '')) || 0), 0);
        return `n-${highest + 1}`;
    }

    dismiss(id) {
        const before = this.list.length;
        this.list = this.list.filter(n => n.id !== id);
        if (this.list.length !== before) this._changed();
    }

    clear() {
        if (!this.list.length) return;
        this.list = [];
        this._changed();
    }

    // A loaded, rewound or new game: take its list, and compare from scratch
    // (so a ship that's already in a bad way doesn't notify on arrival).
    restore(saved) {
        this.list = (Array.isArray(saved) ? saved : []).filter(n => n && n.title).map(n => ({
            id: String(n.id), key: n.key ?? null, level: n.level ?? 'info', title: String(n.title),
            detail: n.detail ?? '', gameTime: n.gameTime ?? 0, count: n.count ?? 1,
        }));
        this._prev = null;
        this._changed();
    }

    snapshot() {
        return this.list.map(n => ({ ...n }));
    }

    _changed() {
        this._version++;
        this.render();
    }

    // ── Watching for events ─────────────────────────────────────────────────

    _state() {
        const g = this.game, s = g.systems, fab = g.fabrication;
        const modules = {};
        // Every module, fitted or not: repairableKeys() leaves out one that isn't installed yet.
        Object.keys(this.MODULE_LABELS).forEach(key => {
            const sys = s[key];
            if (sys) modules[key] = { pct: sys.repairPct ?? 100, destroyed: !!sys.destroyed, installed: sys.installed !== false };
        });
        const boxes = (g.cargo?.boxes ?? []).map(b => ({ id: b.id, sealed: !!b.sealed, ready: fab.boxStatus(b) === 'ready', fillL: b.fillL ?? 0 }));
        return {
            saveId: g.saveId,
            statuses: Object.fromEntries(Object.keys(this.STATUS_LABELS).map(key =>
                [key, s[key] && s[key].installed !== false ? this.RANK[s[key].status] ?? 0 : 0])),
            crew: (g.crewManifest ?? []).map(m => ({ id: m.id, status: g.crewManager.statusFor(m) })),
            modules,
            market: (g.market ?? []).map(l => ({ id: l.id, name: l.name, repairPct: l.repairPct })),
            supplies: { ...(g.cargo?.items ?? {}) },
            boxes,
            blackWater: s.blackWater.current,
            credits: g.credits,
        };
    }

    // The reading behind a status change, in a few words.
    _statusDetail(key) {
        const s = this.game.systems[key];
        const r = (v, dp = 0) => Number(v ?? 0).toFixed(dp);
        switch (key) {
            case 'o2':          return `Cabin oxygen at ${r(s.pct, 1)}%.`;
            case 'co2':         return `CO₂ at ${Math.round((s.pct ?? 0) * 10000).toLocaleString()} ppm.`;
            case 'power':       return `Battery at ${r(s.level)}%.`;
            case 'fuel':        return `${r(s.current, 1)} L of fuel left.`;
            case 'freshWater':  return `${r(s.current, 1)} L of fresh water left.`;
            case 'blackWater':  return `Waste tank ${r(s.level)}% full.`;
            case 'transceiver': return 'Out of range of the local network.';
            case 'waterMaker':  return 'Below 50% condition.';
            default:            return '';
        }
    }

    // Called at the end of every dashboard redraw (main.js updateDisplay).
    check() {
        const g = this.game;
        if (!g.gameActive) { this._prev = null; return; }
        const now  = this._state();
        const prev = this._prev;
        this._prev = now;
        if (!prev || prev.saveId !== now.saveId) return;

        const spent  = prev.credits - now.credits;
        const earned = -spent;

        // Systems getting worse. Getting better again isn't listed (as it isn't heard).
        Object.entries(now.statuses).forEach(([key, rank]) => {
            if (rank <= prev.statuses[key]) return;
            if (g.systems[key].destroyed) return; // listed as "destroyed" below instead
            const label = this.STATUS_LABELS[key];
            this.add({
                key: `status:${key}`,
                level: rank >= 2 ? 'critical' : 'warning',
                title: `${label} ${rank >= 2 ? 'critical' : 'warning'}`,
                detail: this._statusDetail(key),
            });
        });

        // Crew health crossing into a worse band.
        now.crew.forEach((m, i) => {
            const before = prev.crew.find(p => p.id === m.id);
            if (!before || this.CREW_RANK[m.status] <= this.CREW_RANK[before.status]) return;
            const who = `Crew ${i + 1}`;
            const text = {
                warning:     [`${who}'s health is falling`, 'warning', 'Open Crew to see what is hurting them.'],
                critical:    [`${who}'s health is critical`, 'critical', 'Below 20% they can no longer work.'],
                unconscious: [`${who} is unconscious`, 'critical', 'They can\'t work until their health recovers above 20%.'],
                dead:        [`${who} has died`, 'critical', ''],
            }[m.status];
            if (text) this.add({ key: `crew:${m.id}`, title: text[0], level: text[1], detail: text[2] });
        });

        // Market purchase: a listing gone and credits spent. Buying a module fits it,
        // so that is one entry rather than "bought" and "fitted".
        const bought = spent > 0 ? prev.market.filter(l => !now.market.some(n => n.id === l.id)) : [];
        bought.forEach(l => {
            const condition = l.repairPct != null ? ` Fitted in ${Math.round(l.repairPct)}% condition.` : '';
            this.add({ level: 'info', title: `Bought ${l.name}`, detail: `${spent} credits.${condition}` });
        });

        // Modules: replaced, destroyed, or a repair stage landing.
        Object.entries(now.modules).forEach(([key, mod]) => {
            const before = prev.modules[key];
            if (!before) return;
            const name = this.MODULE_LABELS[key] ?? key;
            const fitted = (mod.installed && !before.installed) || (before.destroyed && !mod.destroyed);
            if (fitted) {
                if (bought.length) return; // listed as the purchase above
                this.add({ key: `module:${key}`, level: 'good', title: `${name} fitted`, detail: `In ${Math.round(mod.pct)}% condition.` });
            } else if (mod.destroyed && !before.destroyed) {
                this.add({ key: `module:${key}`, level: 'critical', title: `${name} destroyed`, detail: 'The repair failed. A replacement can be bought on the market.' });
            } else if (mod.installed && mod.pct - before.pct >= 5) {
                this.add({ key: `module:${key}`, level: 'good', title: `${name} repaired to ${Math.round(mod.pct)}%`, detail: '' });
            }
        });

        // Supplies bought.
        if (spent > 0) {
            const bought = Object.entries(now.supplies)
                .map(([item, n]) => ({ item, n: n - (prev.supplies[item] ?? 0) }))
                .filter(x => x.n > 0);
            if (bought.length) {
                const names = bought.map(({ item, n }) => `${n} × ${g.fabrication.ITEMS?.[item]?.name ?? item}`).join(', ');
                this.add({ level: 'info', title: 'Supplies bought', detail: `${names} — ${spent} credits.` });
            }
        }

        // Storage boxes: made, sealed, ready, sold.
        const newBoxes = now.boxes.filter(b => !prev.boxes.some(p => p.id === b.id));
        if (newBoxes.length) {
            this.add({ key: 'fab:storageBox', level: 'good', title: 'Storage box fabricated', detail: 'It is in the Cargo Hold.' });
        }
        now.boxes.forEach((b, i) => {
            const before = prev.boxes.find(p => p.id === b.id);
            if (!before) return;
            if (b.sealed && !before.sealed) {
                this.add({ level: 'info', title: `Storage Box ${i + 1} sealed`, detail: `Composting ${Math.round(b.fillL)} L of solid waste.` });
            }
            if (b.ready && !before.ready) {
                this.add({ level: 'good', title: `Compost ready in Storage Box ${i + 1}`, detail: 'Sell it on a planet with the local network in range.' });
            }
        });
        const sold = prev.boxes.filter(p => p.ready && !now.boxes.some(b => b.id === p.id && b.ready)).length;
        if (sold > 0 && earned > 0) {
            this.add({ level: 'good', title: 'Compost sold', detail: `+${earned} credits.` });
        }

        // Black water dumped (and fined).
        if (prev.blackWater - now.blackWater > 0.5 && spent > 0) {
            this.add({ level: 'warning', title: 'Black water dumped', detail: `Detected and fined ${spent} credits.` });
        }
    }

    // ── Header pill and panel ───────────────────────────────────────────────

    _bindPanel() {
        if (!this.pillEl || !this.panelEl) return;
        this.pillEl.addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
        this.clearEl.addEventListener('click', e => { e.stopPropagation(); this.clear(); });
        this.listEl.addEventListener('click', e => {
            const btn = e.target.closest('.notification-dismiss');
            if (!btn) return;
            e.stopPropagation();
            this.dismiss(btn.dataset.id);
        });
        // Clicking anywhere else closes it. (Escape does too — main.js's Escape
        // handler closes it instead of pausing.)
        document.addEventListener('click', e => {
            if (this.isOpen() && !this.panelEl.contains(e.target)) this.close();
        });
    }

    isOpen() { return !!this.panelEl && this.panelEl.style.display !== 'none'; }
    open()   { if (!this.panelEl) return; this.panelEl.style.display = ''; this.pillEl.setAttribute('aria-expanded', 'true'); this._renderedVersion = -1; this.render(); }
    close()  { if (!this.panelEl) return; this.panelEl.style.display = 'none'; this.pillEl.setAttribute('aria-expanded', 'false'); }
    toggle() { this.isOpen() ? this.close() : this.open(); }

    _worstLevel() {
        const order = ['critical', 'warning', 'good', 'info'];
        return order.find(level => this.list.some(n => n.level === level)) ?? null;
    }

    _fmtTime(seconds) {
        const day = Math.floor(seconds / 86400) + 1;
        const sec = seconds % 86400;
        const hh  = String(Math.floor(sec / 3600)).padStart(2, '0');
        const mm  = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        return `Day ${day} · ${hh}:${mm}`;
    }

    _esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    render() {
        if (!this.pillEl) return;
        const n = this.list.length;
        this.countEl.textContent = n;
        this.countEl.style.display = n ? '' : 'none';
        const worst = this._worstLevel();
        this.pillEl.classList.toggle('stat-critical', worst === 'critical');
        this.pillEl.classList.toggle('stat-warning', worst === 'warning');
        this.pillEl.title = n ? `${n} notification${n === 1 ? '' : 's'}` : 'No notifications';

        if (!this.isOpen() || this._renderedVersion === this._version) return;
        this._renderedVersion = this._version;
        this.clearEl.disabled = !n;
        this.listEl.innerHTML = n ? this.list.map(item => `
            <li class="notification notification-${this._esc(item.level)}" data-id="${this._esc(item.id)}">
                <span class="notification-dot" aria-hidden="true"></span>
                <div class="notification-body">
                    <div class="notification-title">${this._esc(item.title)}${item.count > 1 ? ` <span class="notification-repeat">×${item.count}</span>` : ''}</div>
                    ${item.detail ? `<div class="notification-detail">${this._esc(item.detail)}</div>` : ''}
                    <div class="notification-time">${this._fmtTime(item.gameTime)}</div>
                </div>
                <button class="notification-dismiss" data-id="${this._esc(item.id)}" title="Delete this notification" aria-label="Delete notification">&times;</button>
            </li>`).join('')
            : '<li class="task-empty">Nothing new. Warnings, repairs, sales and fines will be listed here.</li>';
    }
}
