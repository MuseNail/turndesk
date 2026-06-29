// ── Modal backdrop-close guard ───────────────────────────────────────────────
// Every modal closes on a click whose target IS the backdrop itself
// (`onclick="if(event.target===this)close()"`). A text-selection drag that
// starts inside a field and ends out on the dim backdrop fires exactly such a
// click — closing the popup mid-selection. This is the app-wide cause of "the
// popup closes when I drag-select text in a field."
//
// Fix once, globally: a capture-phase guard that swallows a click ONLY when the
// pointer actually MOVED (a real drag) from a descendant out to an ancestor
// (the backdrop). A stationary tap is always left alone — including a tap on a
// nested button (label + switch + icon) whose click resolves to the button: the
// movement guard is what keeps those toggles/buttons working. Self-installs on
// import; import it once per page entry point.
const DRAG_PX = 10;   // movement beyond this = a drag, not a tap (allows finger jitter)
let _down = null;
document.addEventListener('pointerdown', e => { _down = { el: e.target, x: e.clientX, y: e.clientY }; }, true);
document.addEventListener('click', e => {
  const d = _down;
  _down = null;
  if (!d) return;
  const moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
  if (moved > DRAG_PX && d.el !== e.target && e.target instanceof Element && e.target.contains(d.el)) {
    e.stopPropagation();   // genuine drag-out → don't let it reach a backdrop close handler
  }
}, true);
