// ── Static constants (not synced state) ─────────────────────────────────────
export const APP_VERSION = 'v3.66';
export const APP_NAME    = 'turndesk';
export const STAFF_PIN   = '1234'; // fallback when no front desk users are configured
export const LOGO_PATH   = '';     // no default logo — upload one in Settings

const ORIGIN = 'https://turndesk.musenailandspa.workers.dev';
export const SQUARE_PROXY = ORIGIN + '/square';
export const PHOTOS_PROXY = ORIGIN + '/photos';
export const STATE_PROXY  = ORIGIN + '/state';
export const AI_PROXY     = ORIGIN + '/ai';
export const PUSH_PROXY   = ORIGIN + '/push';
// Web Push VAPID public key (non-secret; the matching private key is the Worker's
// VAPID_PRIVATE_KEY secret). Used by the TurnDesk Staff app to subscribe for assignment
// notifications. base64url-encoded uncompressed P-256 point.
export const VAPID_PUBLIC_KEY = 'BCoL00zoZ6BMiurBxzhh05439KLXdDCgmd6z6bQzOl4r30VYBq7Xzvf5Xl5DqsuqUchNE7xnfcaCrvgUvfJ2uKk';

// Seeded into config.role_permissions on first run; also the fallback in canDo().
export const DEFAULT_ROLE_PERMISSIONS = {
  manager:   { historicalEntry: true,  deleteTransaction: true,  refund: true,  viewReports: true, manageStaff: true,  manageServices: true  },
  frontdesk: { historicalEntry: false, deleteTransaction: false, refund: false, viewReports: true, manageStaff: false, manageServices: false },
};

export const GROUP_COLORS = [
  '#1a5252','#785a1a','#5c3d8f','#1a5c7a','#7a2a1a',
  '#2a7a4f','#7a1a5c','#4f4f1a','#1a3a7a','#7a4f1a',
];

export const SCHEDULE_COLORS = {
  // Working is the common case → a soft light fill so the exceptions (Off/Sick/
  // Vacation) stand out when scanning the grid.
  working:  { bg: '#dcebea', text: '#15514f', label: 'Working'  },
  off:      { bg: '#f5c870', text: '#3a2800', label: 'Off'      },
  sick:     { bg: '#fa746f', text: '#ffffff', label: 'Sick'     },
  vacation: { bg: '#adb3b5', text: '#000000', label: 'Vacation' },
};
