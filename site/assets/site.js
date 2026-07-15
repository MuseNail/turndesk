// TurnDesk marketing site — shared behavior (scroll-reveal, active tab, mobile menu).
// Plain JS, no build step, no service worker — fully separate from the app.
(function () {
  // ── Scroll-reveal ──────────────────────────────────────────────────────────
  // Scroll-listener based (not IntersectionObserver) for maximum reliability: on any
  // scroll/resize, reveal the .reveal elements now in view. Content is visible by
  // default (only .has-js hides it, set in the page <head>), so if JS ever fails
  // nothing is stuck invisible. A safety timeout reveals everything regardless.
  const els = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (els.length) {
    const vh = () => window.innerHeight || document.documentElement.clientHeight || 800;
    const inView = el => { const r = el.getBoundingClientRect(); return r.top < vh() * 0.95 && r.bottom > 0; };
    // Reveal the in-view elements, staggered in document order via JS (not CSS
    // transition-delay — a delay there can leave the transition stuck at opacity 0).
    const sweep = () => {
      const now = els.filter(inView);
      if (!now.length) return;
      for (const el of now) { const i = els.indexOf(el); if (i > -1) els.splice(i, 1); }
      now.forEach((el, k) => setTimeout(() => el.classList.add('in'), k * 70));
    };
    let ticking = false;
    const onScroll = () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { sweep(); ticking = false; if (!els.length) { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); } });
    };
    sweep();   // reveal whatever's already in view on load
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    setTimeout(() => els.forEach(el => el.classList.add('in')), 2500);   // safety: never stay hidden
  }

  // ── Active nav tab ─────────────────────────────────────────────────────────
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  document.querySelectorAll('[data-nav]').forEach(a => {
    const t = a.getAttribute('data-nav').toLowerCase();
    if (t === here || (here === '' && t === 'index.html')) a.classList.add('active');
  });

  // ── Mobile menu ────────────────────────────────────────────────────────────
  const btn = document.getElementById('menu-btn'), menu = document.getElementById('mobile-menu');
  if (btn && menu) {
    btn.addEventListener('click', () => btn.setAttribute('aria-expanded', String(!menu.classList.toggle('hidden'))));
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); }));
  }
})();
