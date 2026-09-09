// ── Sync banner (pure model) ─────────────────────────────────────────────────
// Maps the app's already-computed sync state → a loud full-width banner shown under the header when
// offline / syncing a backlog / a write failed / sign-in needed, and hidden when everything is synced.
// It exists because the small header pill (updateSyncIndicator) was too easy to miss during the outage,
// so staff re-entered customers. PURE — no store/sync/DOM imports (keeps node tests from booting the
// socket). The render layer (main.js desk / staff.js tech) maps `action` → the surface's real handler.
//
// Priority mirrors updateSyncIndicator: authNeeded → failed → (connected ? pending>0 ? syncing : hidden
// : offline). `surface` ('desk'|'tech') only tailors the failed-state copy/action, since the tech app
// has no Data Recovery UI.

// Shared (pure) — the Material Symbol per state; used by both surfaces' render layers.
export function syncBannerIcon(kind) {
  return kind === 'failed' ? 'error' : kind === 'syncing' ? 'sync' : kind === 'authNeeded' ? 'lock' : 'wifi_off';
}

export function syncBannerModel(state = {}, surface = 'desk') {
  const connected = !!state.connected;
  const n = state.pendingCount || 0;
  const failed = state.failedCount || 0;
  const changes = n === 1 ? '1 change' : `${n} changes`;

  if (state.authNeeded) {
    return { kind: 'authNeeded', tone: 'amber', title: 'This device needs sign-in',
      sub: 'Sign in to reconnect and keep everything in sync.',
      action: surface === 'tech' ? 'signin' : 'pin', actionLabel: 'Sign in', pulse: false };
  }
  if (failed > 0) {
    const f = failed === 1 ? "A change didn't save" : `${failed} changes didn't save`;
    // Highest-priority state after sign-in → loud (saturated red + pulse), never softer than "offline".
    return { kind: 'failed', tone: 'red', title: f,
      sub: surface === 'tech' ? 'Let the front desk know so it can be recovered.' : 'Open Data Recovery to resend it.',
      action: surface === 'tech' ? '' : 'recovery', actionLabel: 'Data Recovery', pulse: true };
  }
  if (connected) {
    if (n > 0) return { kind: 'syncing', tone: 'blue', title: `Back online — syncing ${changes}…`,
      sub: 'Almost done — no need to do anything.', action: '', actionLabel: '', pulse: false };
    return { kind: 'hidden', tone: '', title: '', sub: '', action: '', actionLabel: '', pulse: false };
  }
  // offline → AMBER (attention, but the work is safe). Intentionally not red: red is reserved for a
  // write that actually FAILED. (The header pill uses a red dot for offline; the banner diverges on
  // purpose — amber reads as "caution, safe" vs the failed banner's louder red.)
  if (n > 0) return { kind: 'offline', tone: 'amber',
    title: `Working offline — ${changes} saved on this device`,
    sub: "They'll sync automatically when the internet's back. Don't re-enter these customers.",
    action: 'retry', actionLabel: 'Retry', pulse: true };
  return { kind: 'offline', tone: 'amber', title: 'Working offline',
    sub: "Your saved work is safe — new changes will sync when you're back.",
    action: 'retry', actionLabel: 'Retry', pulse: true };
}
