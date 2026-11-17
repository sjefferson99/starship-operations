// Anchor — keeps a floating message next to the element it is about.
//
// Callouts (the crew's idle complaint, the status toast after an action) are
// laid over the page rather than in its flow, so showing or hiding one never
// pushes the layout around, and each points at its own element wherever that
// element has moved to. Nothing keeps track of coordinates: an attached
// callout is re-measured against its target every animation frame while it is
// visible.
//
//   Anchor.attach(el, target)   target: an element, a CSS selector, or a
//                               function returning either (re-resolved each frame)
//   Anchor.detach(el)
//
// The callout gets `position: fixed` (class `anchored`), sits below its target
// (above if there's no room), and `--arrow-x` tells its CSS pointer where the
// target's centre is. A callout whose target isn't on screen is hidden with it.

class Anchor {
    static attach(el, target, { gap = 10, margin = 8 } = {}) {
        if (!el) return;
        Anchor._items.set(el, { target, gap, margin });
        el.classList.add('anchored');
        Anchor._place(el);
        Anchor._run();
    }

    static detach(el) {
        Anchor._items.delete(el);
    }

    static _resolve(target) {
        const t = typeof target === 'function' ? target() : target;
        return typeof t === 'string' ? document.querySelector(t) : t;
    }

    static _place(el) {
        const item = Anchor._items.get(el);
        if (!item || getComputedStyle(el).display === 'none') return;
        const target = Anchor._resolve(item.target);
        const shown  = target && target.getClientRects().length > 0;
        el.classList.toggle('anchored-lost', !shown);
        if (!shown) return;

        const r  = target.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const w  = el.offsetWidth, h = el.offsetHeight;
        const { gap, margin } = item;

        const centre = r.left + r.width / 2;
        const left   = Math.max(margin, Math.min(vw - w - margin, centre - w / 2));
        const below  = r.bottom + gap + h <= vh - margin || r.top - gap - h < margin;
        const top    = below ? r.bottom + gap : r.top - gap - h;

        el.style.left = left + 'px';
        el.style.top  = top + 'px';
        el.style.setProperty('--arrow-x', Math.max(12, Math.min(w - 12, centre - left)) + 'px');
        el.classList.toggle('anchored-above', !below);
    }

    // One rAF loop for every callout; it stops itself when none is attached.
    static _run() {
        if (Anchor._frame) return;
        const step = () => {
            Anchor._frame = null;
            if (!Anchor._items.size) return;
            Anchor._items.forEach((_, el) => {
                if (!el.isConnected) { Anchor._items.delete(el); return; }
                Anchor._place(el);
            });
            Anchor._frame = requestAnimationFrame(step);
        };
        Anchor._frame = requestAnimationFrame(step);
    }
}

Anchor._items = new Map();
Anchor._frame = null;
