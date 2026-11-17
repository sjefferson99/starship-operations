// Fabrication & cargo domain logic: supplies bought on the market (basic
// components, composting agent), things engineers fabricate from them in the
// work queue (for now just storage boxes), and what boxes are used for (for
// now just composting the black water tank's solid matter into something that
// sells). Kept separate from main.js for the same reason RepairManager,
// CrewManager and CommsNav are: a self-contained domain the dashboard reads.
//
// State lives on the game as `game.cargo`:
//   { items: { basicComponents: n, compostingAgent: n },
//     boxes: [{ id, kind, fillL, sealed, compostHours }] }
//
// A storage box holds one kind of thing at a time. `kind` is null for an empty,
// unassigned box. Adding composting agent makes it a compost box (kind
// 'compost'), which solid waste can then be moved into. Sealing it (by hand, or
// automatically once full) starts the composting clock; once that has run the
// box holds compost, which can be sold on a planet. Selling empties the box
// back to unassigned, ready to be used for anything again.
//
// Fabrication jobs share the repair work queue (game.repairQueue) as tasks with
// `kind: 'fabricate'`. RepairManager works them like any other task and calls
// completeTask() when the hours are done.

class Fabrication {
    static _boxSeq = 0; // makes box ids unique within a page session

    constructor(game) {
        this.game = game;

        // Market supplies. Unlimited stock on any planet you can trade at.
        this.ITEMS = {
            basicComponents: {
                name: 'Basic Components', price: 60, massKg: 5, volumeM3: 0.02,
                blurb: 'Standard plate, fixings and seals. Engineers fabricate simple things from them.',
            },
            compostingAgent: {
                name: 'Composting Agent', price: 30, massKg: 1, volumeM3: 0.005,
                blurb: 'One dose readies an empty storage box to take solid waste and turn it into compost.',
            },
        };

        // What engineers can make. `components` basic components are taken
        // when the job is queued (and handed back if it's cancelled).
        this.RECIPES = {
            storageBox: { name: 'Storage Box', components: 1, hours: 4 },
        };

        // A box takes up the same space however full it is; its mass grows with
        // what's in it.
        this.BOX = { capacityL: 50, emptyMassKg: 6, volumeM3: 0.08, contentDensityKgPerL: 1.0 };

        this.COMPOST_HOURS       = 72; // game hours from sealing to compost
        this.COMPOST_PRICE_PER_L = 4;  // what a planet pays per litre of finished compost
        this.MIN_TRANSFER_L      = 0.01;
    }

    static defaultCargo() {
        return { items: { basicComponents: 0, compostingAgent: 0 }, boxes: [] };
    }

    _cargo() {
        if (!this.game.cargo) this.game.cargo = Fabrication.defaultCargo();
        return this.game.cargo;
    }

    count(itemKey) {
        return this._cargo().items[itemKey] ?? 0;
    }

    boxes() {
        return this._cargo().boxes;
    }

    _box(boxId) {
        return this.boxes().find(b => b.id === boxId) ?? null;
    }

    // ── Box lifecycle ───────────────────────────────────────────────────────

    // 'empty' → 'filling' → 'composting' → 'ready'
    boxStatus(box) {
        if (!box.kind) return 'empty';
        if (!box.sealed) return 'filling';
        return box.compostHours >= this.COMPOST_HOURS ? 'ready' : 'composting';
    }

    boxMassKg(box) {
        return this.BOX.emptyMassKg + (box.fillL ?? 0) * this.BOX.contentDensityKgPerL;
    }

    // Per-tick: sealed compost boxes work toward compost. Pure accumulation,
    // clamped, so one huge tick at 1000× is fine.
    update(dt) {
        const hours = dt / 3600;
        this.boxes().forEach(box => {
            if (box.kind === 'compost' && box.sealed && box.compostHours < this.COMPOST_HOURS) {
                box.compostHours = Math.min(this.COMPOST_HOURS, box.compostHours + hours);
            }
        });
    }

    hoursUntilCompost(box) {
        return Math.max(0, this.COMPOST_HOURS - (box.compostHours ?? 0));
    }

    doseBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind) return 'Already in use';
        if (this.count('compostingAgent') < 1) return 'No composting agent aboard';
        return null;
    }

    dose(boxId) {
        if (this.doseBlocker(boxId)) return false;
        const box = this._box(boxId);
        this._cargo().items.compostingAgent -= 1;
        box.kind = 'compost';
        box.fillL = 0;
        box.sealed = false;
        box.compostHours = 0;
        return true;
    }

    // How much solid waste could go into this box right now (litres). No mass
    // check: the tank gets lighter by exactly what the box gains.
    transferableL(box) {
        if (!box || box.kind !== 'compost' || box.sealed) return 0;
        const room   = Math.max(0, this.BOX.capacityL - box.fillL);
        const solids = Math.max(0, this.game.systems.blackWater.solidL);
        return Math.min(room, solids);
    }

    transferBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind !== 'compost') return 'Add composting agent first';
        if (box.sealed) return 'Sealed';
        if (box.fillL >= this.BOX.capacityL) return 'Full';
        if (this.game.systems.blackWater.solidL < this.MIN_TRANSFER_L) return 'No solid waste in the tank';
        return null;
    }

    // Moves as much solid waste as fits from the black water tank into the
    // box. A box that ends up full seals itself. Returns litres moved.
    transferSolids(boxId) {
        if (this.transferBlocker(boxId)) return 0;
        const box = this._box(boxId);
        const moved = this.transferableL(box);
        const black = this.game.systems.blackWater;
        black.solidL = Math.max(0, black.solidL - moved);
        this.game.syncBlackWaterLevel();
        box.fillL = Math.min(this.BOX.capacityL, box.fillL + moved);
        if (box.fillL >= this.BOX.capacityL - 1e-9) this.seal(boxId);
        return moved;
    }

    // The box solid waste goes into from the Black Water card: the fullest box
    // still taking it (so boxes fill one at a time), or null.
    transferTarget() {
        const open = this.boxes().filter(b => b.kind === 'compost' && !b.sealed && b.fillL < this.BOX.capacityL);
        if (!open.length) return null;
        return open.reduce((best, b) => (b.fillL > best.fillL ? b : best));
    }

    sealBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind !== 'compost') return 'Nothing to seal';
        if (box.sealed) return 'Already sealed';
        if (box.fillL < this.MIN_TRANSFER_L) return 'Empty — move some solid waste in first';
        return null;
    }

    seal(boxId) {
        const box = this._box(boxId);
        if (!box || box.kind !== 'compost' || box.sealed || box.fillL < this.MIN_TRANSFER_L) return false;
        box.sealed = true;
        box.compostHours = 0;
        return true;
    }

    salePrice(box) {
        return Math.round((box.fillL ?? 0) * this.COMPOST_PRICE_PER_L);
    }

    sellBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (this.boxStatus(box) !== 'ready') return 'Not compost yet';
        if (!this._canTrade()) return 'You have to be on a planet, with the local network in range, to sell';
        return null;
    }

    // Sells the compost; the box goes back to empty and unassigned.
    sell(boxId) {
        if (this.sellBlocker(boxId)) return 0;
        const box = this._box(boxId);
        const price = this.salePrice(box);
        this.game.credits += price;
        box.kind = null;
        box.fillL = 0;
        box.sealed = false;
        box.compostHours = 0;
        return price;
    }

    // ── Buying supplies ─────────────────────────────────────────────────────

    _canTrade() {
        return this.game.commsNav.canTradeAt(this.game.commsNav.home());
    }

    // null if the change fits in the ship, otherwise why not.
    spaceBlocker(addMassKg, addVolumeM3) {
        const cap = this.game._computeShipCapacity();
        if (addVolumeM3 > 0 && cap.freeVolumeM3 < addVolumeM3 - 1e-9) return 'Not enough free volume aboard';
        if (addMassKg > 0 && cap.freeMassKg < addMassKg - 1e-9) return 'Over the ship\'s mass limit';
        return null;
    }

    buyBlocker(itemKey) {
        const item = this.ITEMS[itemKey];
        if (!item) return 'Not sold here';
        if (!this._canTrade()) return 'You have to be on the planet to buy';
        if (this.game.credits < item.price) return 'Not enough credits';
        return this.spaceBlocker(item.massKg, item.volumeM3);
    }

    buy(itemKey) {
        if (this.buyBlocker(itemKey)) return false;
        this.game.credits -= this.ITEMS[itemKey].price;
        this._cargo().items[itemKey] = this.count(itemKey) + 1;
        return true;
    }

    // ── Fabrication jobs ────────────────────────────────────────────────────

    // Queued jobs already hold their components; the box they'll make is
    // counted against ship space from the moment it's queued.
    queuedJobs() {
        return (this.game.repairQueue || []).filter(t => t.kind === 'fabricate');
    }

    fabricateBlocker(recipeKey) {
        const recipe = this.RECIPES[recipeKey];
        if (!recipe) return 'Unknown recipe';
        if (this.count('basicComponents') < recipe.components) {
            return `Needs ${recipe.components} basic component${recipe.components === 1 ? '' : 's'} — buy them on the market`;
        }
        // The components leave the hold and a box takes their place.
        const comp = this.ITEMS.basicComponents;
        return this.spaceBlocker(
            this.BOX.emptyMassKg - comp.massKg * recipe.components,
            this.BOX.volumeM3    - comp.volumeM3 * recipe.components);
    }

    queueFabrication(recipeKey) {
        if (this.fabricateBlocker(recipeKey)) return null;
        const recipe = this.RECIPES[recipeKey];
        this._cargo().items.basicComponents -= recipe.components;
        const task = {
            // Unique id without a roll (see RepairManager.startRepair).
            id: `fab-${Date.now().toString(36)}-${++Fabrication._boxSeq}`,
            kind: 'fabricate',
            recipeKey,
            band: 'Fabricate',
            totalHours: recipe.hours,
            hoursRemaining: recipe.hours,
            status: 'queued',
        };
        this.game.repairQueue.push(task);
        return task;
    }

    // A cancelled job gives its components back.
    refund(task) {
        const recipe = this.RECIPES[task.recipeKey];
        if (recipe) this._cargo().items.basicComponents = this.count('basicComponents') + recipe.components;
    }

    completeTask(task) {
        if (task.recipeKey === 'storageBox') {
            this.boxes().push({
                id: `box-${Date.now().toString(36)}-${++Fabrication._boxSeq}`,
                kind: null, fillL: 0, sealed: false, compostHours: 0,
            });
        }
        task.status = 'done';
    }

    // ── Ship capacity rows ──────────────────────────────────────────────────

    capacityItems() {
        const rows = [];
        Object.entries(this.ITEMS).forEach(([key, item]) => {
            const n = this.count(key);
            if (n > 0) rows.push({ label: item.name, count: n, massKg: item.massKg * n, volumeM3: item.volumeM3 * n });
        });
        this.boxes().forEach((box, i) => {
            rows.push({ label: `Storage Box ${i + 1}`, count: 1, massKg: this.boxMassKg(box), volumeM3: this.BOX.volumeM3 });
        });
        const pending = this.queuedJobs().filter(t => t.recipeKey === 'storageBox').length;
        if (pending > 0) {
            rows.push({ label: 'Storage Box (being made)', count: pending, massKg: this.BOX.emptyMassKg * pending, volumeM3: this.BOX.volumeM3 * pending });
        }
        return rows;
    }
}
