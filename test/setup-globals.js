// Minimal browser-global shims so the app's ES modules import cleanly under Node.
// The app references localStorage (sync.js, at parse time) and document
// (utils.js registers a top-level click listener), so importing those modules in
// a bare Node process throws without these stubs. We only stub what runs at
// import time — the functions under test are pure and touch none of this.
// Import this FIRST in every test file (static imports evaluate in source order).
const _ls = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
  clear: () => _ls.clear(),
};
globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
};
globalThis.window ??= globalThis;
