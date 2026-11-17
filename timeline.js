// Timeline — rewind checkpoints (docs/rewind-readiness.md).
//
// The server keeps a tree of full-state checkpoints per save. This class does
// the client side:
//   - taking them: one each time the game clock crosses a game hour
//     (`maybeCheckpoint`, called every tick), plus 'start' and 'save' ones that
//     main.js asks for;
//   - the Timeline screen (#timeline-screen, opened from the pause menu): the
//     tree drawn as inline SVG, one row per branch, and a "Go back to here"
//     button for the selected checkpoint.
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
        this._lastHour   = 0;     // last game hour a checkpoint was taken (or skipped) for
        this._busy       = false; // a checkpoint request is in flight

        document.getElementById('timeline-close-btn').addEventListener('click', () => this.close());
        this.treeEl.addEventListener('click', e => {
            const node = e.target.closest('[data-checkpoint-id]');
            if (!node) return;
            this._selectedId = node.dataset.checkpointId;
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

    // ── Rendering ───────────────────────────────────────────────────────────

    _formatTime(gameTime) {
        const day = Math.floor(gameTime / 86400) + 1;
        const sec = gameTime % 86400;
        const hh  = String(Math.floor(sec / 3600)).padStart(2, '0');
        const mm  = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        return `Day ${day}, ${hh}:${mm}`;
    }

    _render() {
        if (!this._tree) return;
        const nodes = this._nodes();
        const { cols, rows, byId } = this._layout(nodes);
        const x = n => this.PAD_X + n.col * this.COL_W;
        const y = n => this.PAD_Y + n.row * this.ROW_H;
        const width  = this.PAD_X * 2 + Math.max(0, cols - 1) * this.COL_W;
        const height = this.PAD_Y + Math.max(0, rows - 1) * this.ROW_H + 20;

        // Links: along the parent's row to the child's column, or, for a new
        // branch, down from the parent first.
        const links = nodes.filter(n => byId.has(n.parentId)).map(n => {
            const p = byId.get(n.parentId);
            const d = p.row === n.row
                ? `M ${x(p)} ${y(p)} L ${x(n)} ${y(n)}`
                : `M ${x(p)} ${y(p)} L ${x(p)} ${y(n) - 8} Q ${x(p)} ${y(n)} ${x(p) + 8} ${y(n)} L ${x(n)} ${y(n)}`;
            return `<path class="timeline-link${n.kind === 'live' ? ' timeline-link-live' : ''}" d="${d}"/>`;
        }).join('');

        // A day label above the first column of each game day.
        const firstOfDay = new Map();
        nodes.forEach(n => {
            const day = Math.floor(n.gameTime / 86400) + 1;
            if (!firstOfDay.has(day) || n.col < firstOfDay.get(day)) firstOfDay.set(day, n.col);
        });
        const dayLabels = [...firstOfDay].map(([day, col]) =>
            `<text class="timeline-day" x="${this.PAD_X + col * this.COL_W}" y="12">D${day}</text>`).join('');

        const dots = nodes.map(n => {
            const classes = ['timeline-node', `timeline-node-${n.kind}`];
            if (n.here) classes.push('timeline-node-here');
            if (n.id === this._selectedId) classes.push('timeline-node-selected');
            const r = n.kind === 'hourly' ? 5 : 7;
            const ring = n.here ? `<circle class="timeline-here-ring" cx="${x(n)}" cy="${y(n)}" r="${r + 5}"/>` : '';
            return `${ring}<circle class="${classes.join(' ')}" data-checkpoint-id="${n.id}" cx="${x(n)}" cy="${y(n)}" r="${r}">
                        <title>${this._formatTime(n.gameTime)} — ${this.KIND_LABELS[n.kind] ?? n.kind}</title>
                    </circle>`;
        }).join('');

        this.treeEl.innerHTML =
            `<svg class="timeline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${dayLabels}${links}${dots}</svg>`;
        this._renderDetails(byId.get(this._selectedId) ?? null);
    }

    _renderDetails(node) {
        if (!node) {
            this.detailsEl.innerHTML = '<p class="task-empty">Select a point on the timeline to go back to it.</p>';
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
