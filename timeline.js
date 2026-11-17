// Timeline — rewind checkpoints (docs/rewind-readiness.md).
//
// The server keeps a tree of full-state checkpoints per save. This class does
// the client side:
//   - taking them: one each time the game clock crosses a game hour
//     (`maybeCheckpoint`, called every tick), plus 'start' and 'save' ones that
//     main.js asks for;
//   - the Timeline screen (#timeline-screen, opened from the pause menu): the
//     tree drawn as inline SVG, one row per branch, and a "Go back to here"
//     button for the selected checkpoint. A long game is rolled up so the
//     screen stays small: months of 4 weeks, weeks of 7 days, then the
//     individual checkpoints of one day. Each roll-up dot is one branch's
//     checkpoints in that period; clicking it drills in, and the breadcrumb
//     climbs back out. Any checkpoint is a few clicks away.
//
// Going back never loses anything. The server keeps the state being left as a
// 'branch-end', and play after going back grows a new branch under the
// checkpoint, so every earlier line can still be reached.

class Timeline {
    constructor(game) {
        this.game = game;

        this.CHECKPOINT_EVERY_S = 3600; // one game hour

        // Drawing
        this.COL_W  = 30;  // one column per distinct checkpoint time
        this.ROW_H  = 34;  // one row per branch
        this.PAD_X  = 22;
        this.PAD_Y  = 30;  // room for the day labels above the first row

        // Roll-up periods, coarsest first. A month is 4 weeks so they nest exactly.
        this.DAY_S = 86400;
        this.UNITS = {
            month: { seconds: 28 * 86400, child: 'week', label: 'Month', short: 'M' },
            week:  { seconds: 7 * 86400,  child: 'day',  label: 'Week',  short: 'W' },
            day:   { seconds: 86400,      child: null,   label: 'Day',   short: 'D' },
        };
        this.SHOW_ALL_UP_TO_S = 2 * 86400; // a game this short shows every checkpoint at once

        this.KIND_LABELS = {
            'start':      'Start of the game',
            'hourly':     'Automatic checkpoint',
            'save':       'Saved game',
            'branch-end': 'Where you left off',
            'live':       'Now',
        };

        this.screen      = document.getElementById('timeline-screen');
        this.treeEl      = document.getElementById('timeline-tree');
        this.detailsEl   = document.getElementById('timeline-details');
        this._tree       = null;  // last { headId, checkpoints } from the server
        this._selectedId = null;
        this._path       = [];    // drill-down: [{ unit, start }], outermost first
        this._lastHour   = 0;     // last game hour a checkpoint was taken (or skipped) for
        this._busy       = false; // a checkpoint request is in flight

        document.getElementById('timeline-close-btn').addEventListener('click', () => this.close());
        this.treeEl.addEventListener('click', e => {
            const bucket = e.target.closest('[data-bucket-unit]');
            if (bucket) {
                this._path.push({ unit: bucket.dataset.bucketUnit, start: Number(bucket.dataset.bucketStart) });
                this._render();
                return;
            }
            const node = e.target.closest('[data-checkpoint-id]');
            if (!node) return;
            this._selectedId = node.dataset.checkpointId;
            this._render();
        });
        this.crumbsEl = document.getElementById('timeline-crumbs');
        this.crumbsEl.addEventListener('click', e => {
            const crumb = e.target.closest('[data-crumb]');
            if (!crumb) return;
            if (crumb.dataset.crumb === 'now') this._path = this._pathTo(this.game.gameTime);
            else this._path = this._path.slice(0, Number(crumb.dataset.crumb));
            this._render();
        });
        this.detailsEl.addEventListener('click', e => {
            if (e.target.closest('#timeline-restore-btn')) this.goBack(Number(this._selectedId));
        });
    }

    // ── Taking checkpoints ──────────────────────────────────────────────────

    // Call whenever the game clock is set from outside the tick loop (new game,
    // load, going back), so the next hourly checkpoint is the next hour crossed.
    resetClock() {
        this._lastHour = Math.floor(this.game.gameTime / this.CHECKPOINT_EVERY_S);
    }

    // Every tick: take an hourly checkpoint when the clock has crossed into a
    // new game hour. One big tick can cross several hours; that's still one
    // checkpoint, of the state as it is now.
    maybeCheckpoint() {
        const hour = Math.floor(this.game.gameTime / this.CHECKPOINT_EVERY_S);
        if (hour <= this._lastHour) return null;
        this._lastHour = hour;
        return this.checkpoint('hourly');
    }

    // Resolves to true if the checkpoint was stored. Failures are swallowed:
    // a missed checkpoint must never interrupt play.
    async checkpoint(kind) {
        if (this.game.saveId == null || this._busy) return false;
        this._busy = true;
        try {
            await GameState.addCheckpoint(this.game, kind);
            return true;
        } catch {
            return false;
        } finally {
            this._busy = false;
        }
    }

    // A save from before checkpoints existed has an empty tree. Give it a
    // first checkpoint on load so the timeline has somewhere to go back to.
    async onGameLoaded() {
        this.resetClock();
        try {
            const tree = await GameState.listCheckpoints(this.game.saveId);
            if (!tree.checkpoints.length) await this.checkpoint('save');
        } catch { /* the timeline just stays empty */ }
    }

    // ── Screen ──────────────────────────────────────────────────────────────

    isOpen() {
        return Overlay.isOpen(this.screen);
    }

    async open() {
        if (this.game.saveId == null) return;
        this._selectedId = null;
        this._tree = null;
        this._path = [];
        Overlay.show(this.screen);
        this.treeEl.innerHTML = '<p class="task-empty">Loading…</p>';
        this.detailsEl.innerHTML = '';
        await this.refresh();
    }

    close() {
        Overlay.hide(this.screen);
    }

    async refresh() {
        try {
            this._tree = await GameState.listCheckpoints(this.game.saveId);
        } catch {
            this.treeEl.innerHTML = '<p class="task-empty">Could not load the timeline — is server.js running?</p>';
            return;
        }
        this._render();
        const live = this.treeEl.querySelector('.timeline-node-here');
        if (live) live.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    async goBack(checkpointId) {
        if (!Number.isFinite(checkpointId)) return;
        try {
            await GameState.restoreCheckpoint(this.game, checkpointId);
        } catch (e) {
            alert(e.message);
            return;
        }
        this.resetClock();
        this.game.afterRewind();
        this.close();
    }

    // ── Layout ──────────────────────────────────────────────────────────────

    // Checkpoints plus a 'live' node for the game as it is right now, when
    // play has moved on from the head checkpoint.
    _nodes() {
        const { headId, checkpoints } = this._tree;
        const nodes = checkpoints.map(c => ({ ...c, id: String(c.id), parentId: c.parentId != null ? String(c.parentId) : null }));
        const head = nodes.find(n => n.id === String(headId));
        const g = this.game;
        if (head && head.gameTime === g.gameTime) {
            head.here = true;
        } else {
            nodes.push({
                id: 'live', parentId: head ? head.id : null, kind: 'live', here: true,
                gameTime: g.gameTime, credits: g.credits, crewCount: g.crewManager.aliveCount(),
            });
        }
        return nodes;
    }

    // Gives every node a column (its time's rank among all checkpoint times)
    // and a row (its branch). A node's earliest child stays on its row, so the
    // line first played runs straight; each later branch gets a new row below.
    _layout(nodes) {
        const times = [...new Set(nodes.map(n => n.gameTime))].sort((a, b) => a - b);
        const colOf = new Map(times.map((t, i) => [t, i]));
        const byId = new Map(nodes.map(n => [n.id, n]));
        const children = new Map();
        const roots = [];
        nodes.forEach(n => {
            n.col = colOf.get(n.gameTime);
            if (n.parentId != null && byId.has(n.parentId)) {
                if (!children.has(n.parentId)) children.set(n.parentId, []);
                children.get(n.parentId).push(n);
            } else {
                roots.push(n);
            }
        });

        let nextRow = 0;
        const place = (node, row) => {
            node.row = row;
            (children.get(node.id) ?? []).forEach((child, i) => place(child, i === 0 ? row : nextRow++));
        };
        roots.forEach(root => place(root, nextRow++));
        return { cols: times.length, rows: nextRow, byId };
    }

    // ── Roll-up ─────────────────────────────────────────────────────────────

    // The roll-up unit the whole timeline starts at, from how long it is.
    _topUnit(nodes) {
        const span = Math.max(0, ...nodes.map(n => n.gameTime));
        if (span < this.SHOW_ALL_UP_TO_S) return null;   // every checkpoint, no roll-up
        if (span < 14 * this.DAY_S) return 'day';
        if (span < 2 * this.UNITS.month.seconds) return 'week';
        return 'month';
    }

    // What the screen shows for the current path: a time window, and the
    // unit its dots stand for (null = individual checkpoints).
    _view(nodes) {
        if (!this._path.length) return { from: -Infinity, to: Infinity, unit: this._topUnit(nodes) };
        const { unit, start } = this._path[this._path.length - 1];
        return { from: start, to: start + this.UNITS[unit].seconds, unit: this.UNITS[unit].child };
    }

    // The drill-down path that ends on the day containing `gameTime`.
    _pathTo(gameTime) {
        const path = [];
        let unit = this._tree ? this._topUnit(this._nodes()) : null;
        while (unit) {
            const size = this.UNITS[unit].seconds;
            path.push({ unit, start: Math.floor(gameTime / size) * size });
            unit = this.UNITS[unit].child;
        }
        return path;
    }

    _periodName(unit, start) {
        const u = this.UNITS[unit];
        const index = Math.floor(start / u.seconds) + 1;
        if (unit === 'day') return `Day ${index}`;
        const firstDay = Math.floor(start / this.DAY_S) + 1;
        const lastDay  = firstDay + u.seconds / this.DAY_S - 1;
        return `${u.label} ${index} (days ${firstDay}–${lastDay})`;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _formatTime(gameTime) {
        const day = Math.floor(gameTime / 86400) + 1;
        const sec = gameTime % 86400;
        const hh  = String(Math.floor(sec / 3600)).padStart(2, '0');
        const mm  = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        return `Day ${day}, ${hh}:${mm}`;
    }

    // "All time › Week 2 › Day 9", each step clickable to climb back out,
    // plus a shortcut straight down to today.
    _renderCrumbs(nodes) {
        if (!this._topUnit(nodes)) { this.crumbsEl.innerHTML = ''; return; }
        const parts = [`<button class="timeline-crumb" data-crumb="0"${this._path.length ? '' : ' disabled'}>All time</button>`];
        this._path.forEach((p, i) => {
            const last = i === this._path.length - 1;
            parts.push(`<span class="timeline-crumb-sep">›</span><button class="timeline-crumb" data-crumb="${i + 1}"${last ? ' disabled' : ''}>${this._periodName(p.unit, p.start)}</button>`);
        });
        this.crumbsEl.innerHTML = `<div class="timeline-crumb-trail">${parts.join('')}</div>
            <button class="timeline-crumb timeline-crumb-now" data-crumb="now">Today</button>`;
    }

    _render() {
        if (!this._tree) return;
        const nodes = this._nodes();
        const { byId } = this._layout(nodes); // rows come from the whole tree, so branches keep their order
        const view = this._view(nodes);
        const inView = n => n.gameTime >= view.from && n.gameTime < view.to;
        this._renderCrumbs(nodes);

        // Dots: single checkpoints, or each branch's checkpoints in one period.
        const size  = view.unit ? this.UNITS[view.unit].seconds : null;
        const keyOf = n => view.unit ? `${n.row}:${Math.floor(n.gameTime / size)}` : n.id;
        const dots  = new Map();
        nodes.filter(inView).forEach(n => {
            const key = keyOf(n);
            if (!dots.has(key)) dots.set(key, {
                key, row: n.row, nodes: [],
                time: view.unit ? Math.floor(n.gameTime / size) * size : n.gameTime,
            });
            dots.get(key).nodes.push(n);
        });

        // Columns: one per distinct time (or period); rows: only the branches seen here.
        const all   = [...dots.values()];
        const times = [...new Set(all.map(d => d.time))].sort((a, b) => a - b);
        const colOf = new Map(times.map((t, i) => [t, i]));
        const rows  = [...new Set(all.map(d => d.row))].sort((a, b) => a - b);
        const rowOf = new Map(rows.map((r, i) => [r, i]));
        all.forEach(d => { d.col = colOf.get(d.time); d.r = rowOf.get(d.row); });

        const colW   = view.unit ? this.COL_W + 14 : this.COL_W;
        const x      = d => this.PAD_X + d.col * colW;
        const y      = d => this.PAD_Y + d.r * this.ROW_H;
        const width  = this.PAD_X * 2 + Math.max(0, times.length - 1) * colW;
        const height = this.PAD_Y + Math.max(0, rows.length - 1) * this.ROW_H + 20;

        // Links between dots, plus short stubs for a line that carries on past
        // the edge of the window (its parent before it, or its child after it).
        const links = new Map();
        const path  = (from, to) => from.r === to.r
            ? `M ${x(from)} ${y(from)} L ${x(to)} ${y(to)}`
            : `M ${x(from)} ${y(from)} L ${x(from)} ${y(to) - 8} Q ${x(from)} ${y(to)} ${x(from) + 8} ${y(to)} L ${x(to)} ${y(to)}`;
        nodes.forEach(n => {
            const p = byId.get(n.parentId);
            if (!p) return;
            const cls = `timeline-link${n.kind === 'live' ? ' timeline-link-live' : ''}`;
            const dn = dots.get(keyOf(n)), dp = dots.get(keyOf(p));
            if (inView(n) && inView(p)) {
                if (dn !== dp) links.set(`${dp.key}>${dn.key}`, `<path class="${cls}" d="${path(dp, dn)}"/>`);
            } else if (inView(n)) {
                links.set(`<${dn.key}`, `<path class="${cls}" d="M 4 ${y(dn)} L ${x(dn)} ${y(dn)}"/>`);
            } else if (inView(p)) {
                links.set(`${dp.key}>`, `<path class="${cls}" d="M ${x(dp)} ${y(dp)} L ${width - 4} ${y(dp)}"/>`);
            }
        });

        // Column labels: each roll-up column's period, or the day above the
        // first checkpoint of each day.
        const labels = [];
        if (view.unit) {
            times.forEach(t => labels.push(
                `<text class="timeline-day" x="${this.PAD_X + colOf.get(t) * colW}" y="12">${this.UNITS[view.unit].short}${Math.floor(t / size) + 1}</text>`));
        } else {
            const firstOfDay = new Map();
            times.forEach(t => {
                const day = Math.floor(t / this.DAY_S) + 1;
                if (!firstOfDay.has(day)) firstOfDay.set(day, colOf.get(t));
            });
            firstOfDay.forEach((col, day) => labels.push(`<text class="timeline-day" x="${this.PAD_X + col * colW}" y="12">D${day}</text>`));
        }

        const marks = all.map(d => view.unit ? this._bucketMark(d, x(d), y(d), view.unit) : this._nodeMark(d.nodes[0], x(d), y(d))).join('');
        this.treeEl.innerHTML =
            `<svg class="timeline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${labels.join('')}${[...links.values()].join('')}${marks}</svg>`;
        this._renderDetails(byId.get(this._selectedId) ?? null, !!view.unit);
    }

    _nodeMark(n, cx, cy) {
        const classes = ['timeline-node', `timeline-node-${n.kind}`];
        if (n.here) classes.push('timeline-node-here');
        if (n.id === this._selectedId) classes.push('timeline-node-selected');
        const r = n.kind === 'hourly' ? 5 : 7;
        const ring = n.here ? `<circle class="timeline-here-ring" cx="${cx}" cy="${cy}" r="${r + 5}"/>` : '';
        return `${ring}<circle class="${classes.join(' ')}" data-checkpoint-id="${n.id}" cx="${cx}" cy="${cy}" r="${r}">
                    <title>${this._formatTime(n.gameTime)} — ${this.KIND_LABELS[n.kind] ?? n.kind}</title>
                </circle>`;
    }

    // One branch's checkpoints in one period: a bigger dot showing how many,
    // which drills into that period when clicked.
    _bucketMark(d, cx, cy, unit) {
        const here     = d.nodes.some(n => n.here);
        const selected = d.nodes.some(n => n.id === this._selectedId);
        const classes  = ['timeline-bucket'];
        if (here) classes.push('timeline-bucket-here');
        if (selected) classes.push('timeline-bucket-selected');
        const count = d.nodes.filter(n => n.kind !== 'live').length;
        const ring  = here ? `<circle class="timeline-here-ring" cx="${cx}" cy="${cy}" r="16"/>` : '';
        const title = `${this._periodName(unit, d.time)}: ${count} checkpoint${count === 1 ? '' : 's'}${here ? ', and now' : ''}. Click to open.`;
        return `${ring}<g class="${classes.join(' ')}" data-bucket-unit="${unit}" data-bucket-start="${d.time}">
                    <circle cx="${cx}" cy="${cy}" r="11"/>
                    <text x="${cx}" y="${cy + 3.5}">${count || 'now'}</text>
                    <title>${title}</title>
                </g>`;
    }

    _renderDetails(node, rolledUp = false) {
        if (!node) {
            this.detailsEl.innerHTML = rolledUp
                ? '<p class="task-empty">Each dot is a stretch of time on one branch, with how many checkpoints it holds. Click one to open it, down to the checkpoints of a single day.</p>'
                : '<p class="task-empty">Select a point on the timeline to go back to it.</p>';
            return;
        }
        const crew = node.crewCount ?? 0;
        const canGoBack = !node.here;
        this.detailsEl.innerHTML = `
            <div class="save-info">
                <div class="save-title" id="timeline-selected-title">${this._formatTime(node.gameTime)}</div>
                <div class="save-meta">${this.KIND_LABELS[node.kind] ?? ''} &middot; ${Math.round(node.credits ?? 0)} credits &middot; ${crew} crew alive</div>
            </div>
            <div class="save-actions">
                ${canGoBack
                    ? '<button id="timeline-restore-btn" class="save-load-btn">Go back to here</button>'
                    : '<span class="timeline-here-note">You are here</span>'}
            </div>`;
    }
}
