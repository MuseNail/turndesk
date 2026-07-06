// ── Bootstrap ────────────────────────────────────────────────────────────────
// Wires the modular app: attaches handler functions to window (so the existing
// inline onclick= markup keeps working), defines navigation, subscribes the
// store to re-render on remote changes, and runs startup.

import './apptoken.js';   // §13 backend auth — installs the bearer-token fetch wrapper; keep FIRST
import * as reporter from './reporter.js';   // automatic error reporting — arm early so it catches boot-time throws
import './modal-guard.js';   // global backdrop-close guard (drag-select in a field no longer closes popups)
import * as store from './store.js';
import * as sync from './sync.js';
import * as session from './session.js';
import { APP_VERSION } from './config.js';
import * as utils from './utils.js';
import * as auth from './features/auth.js';
import * as photos from './features/photos.js';
import * as catalog from './features/catalog.js';
import * as sqCust from './features/square-customers.js';
import * as sqCat from './features/square-catalog.js';
import * as sqPos from './features/square-pos.js';
import * as staff from './features/staff.js';
import * as checkin from './features/checkin.js';
import * as statusMod from './features/status.js';
import * as queue from './features/queue.js';
import * as turns from './features/turns.js';
import * as reports from './features/reports.js';
import * as giftcards from './features/giftcards.js';
import * as settings from './features/settings.js';
import * as calendar from './features/calendar.js';
import * as floorplan from './features/floorplan.js';
import * as appearance from './features/appearance.js';
import * as servicetime from './features/servicetime.js';
import * as chat from './features/chat.js';
import * as apptReminders from './features/appt-reminders.js';
import * as recovery from './features/recovery.js';
import * as audit from './features/audit.js';
import * as cashdrawer from './features/cashdrawer.js';
import * as sms from './features/sms.js';
import * as timeclock from './features/timeclock.js';
import * as fdSchedule from './features/fd-schedule.js';
import * as helcim from './features/helcim.js';
import * as quicksale from './features/quicksale.js';
import * as search from './features/search.js';
import * as boSync from './features/backoffice-sync.js';
import * as guide from './features/guide.js';
import * as receipt from './features/receipt.js';
import * as diagnostics from './features/diagnostics.js';

// Expose every module's exports for inline onclick= handlers + cross-module glue.
[utils, auth, photos, catalog, sqCust, sqCat, sqPos, staff, checkin, statusMod, queue, turns, reports, giftcards, settings, calendar, floorplan, appearance, servicetime, chat, apptReminders, recovery, audit, cashdrawer, sms, timeclock, fdSchedule, helcim, quicksale, search, boSync, guide, receipt, diagnostics]
  .forEach(ns => Object.assign(window, ns));
window.dispatch     = sync.dispatch;
window.calEventsFor = calendar.getCalEvents;
window.reportError  = reporter.reportError;   // so any module/inline code can log a silent failure
window.breadcrumb   = reporter.breadcrumb;

// ── Modal registry ────────────────────────────────
// Single source of truth for every dismissible modal/overlay + its close fn. Drives BOTH the
// Escape key (close the first open one) AND closeAllModals() on navigation (so a screen change
// never leaves an orphaned modal floating over the new screen / silently eating nav taps).
// `pin-modal` is handled separately in the Esc handler.
const MODAL_CLOSERS = [
  ['tech-status-menu', turns.closeTechStatusMenu], ['group-assign-modal', queue.closeGroupAssignModal],
  ['manual-modal', queue.closeManualAdd], ['warn-modal', queue.closeWarnModal],
  ['turns-assign-modal', turns.closeTurnsAssignModal], ['turns-tech-modal', turns.closeTurnsTechModal],
  ['split-merge-modal', queue.closeSplitMergeModal], ['edit-services-modal', queue.closeEditServicesModal],
  ['service-modal', catalog.closeServiceModal], ['staff-modal', staff.closeStaffModal],
  ['staff-photo-modal', photos.closeStaffPhotoModal], ['schedule-picker', staff.closeSchedulePicker], ['week-fill-modal', staff.closeWeekFill],
  ['edit-checkin-modal', queue.closeEditCheckin], ['customer-dir-modal', sqCust.closeCustomerDir],
  ['edit-customer-modal', sqCust.closeEditCustomer], ['photo-crop-modal', photos.closePhotoCrop],
  ['delete-txn-modal', reports.closeDeleteTxnModal], ['refund-modal', reports.closeRefundModal],
  ['gc-modal', giftcards.closeGcModal], ['fduser-modal', auth.closeFdUserModal],
  ['appt-modal', calendar.closeApptModal], ['historical-modal', reports.closeHistoricalModal],
  ['square-confirm-modal', sqPos.closeSquareConfirm], ['admin-code-modal', auth.closeAdminCode],
  ['date-picker-modal', reports.closeDatePicker], ['compare-menu', reports.closeCompareMenu],
  ['day-picker-modal', reports.closeDayPicker], ['txn-merge-modal', reports.closeTxnMergeModal],
  ['rpt-drill-modal', reports.closeDrillDown], ['cash-register-modal', cashdrawer.closeCashRegister],
  ['square-modal', () => { const m = document.getElementById('square-modal'); m.classList.add('hidden'); m.style.display = ''; }],
  ['global-search-modal', search.closeGlobalSearch],
  ['whatsnew-modal', () => closeWhatsNew()],
  ['numpad-modal', utils.numpadConfirm],
];
// Generic force-hide on navigation (does NOT invoke each modal's close fn, so a programmatic/
// back nav isn't gated). User-initiated closes (Esc, backdrop tap, the X button) still run the
// per-modal logic, including the Edit Customer unsaved-changes guard.
function closeAllModals() {
  for (const [id] of MODAL_CLOSERS) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); el.style.display = ''; }
  }
}

// ── Navigation ────────────────────────────────────
// In-app back handling: the OS/browser back gesture used to reload the PWA
// (losing state). Instead we track screen history and return to the previous
// screen; back never unloads the page (we always keep a history entry to pop).
let _screenStack = [];
let _navBack = false;
function setupBackHandler() {
  history.pushState({ muse: true }, '');
  window.addEventListener('popstate', () => {
    const prev = _screenStack.pop();
    if (prev) { _navBack = true; goTo(prev); _navBack = false; }
    history.pushState({ muse: true }, '');
  });
}
function goTo(screenId, param) {
  closeAllModals();   // a screen change never leaves a modal orphaned over the new screen
  const prevScreen = document.querySelector('.screen.active')?.id;
  if (prevScreen && prevScreen !== screenId && !_navBack) {
    _screenStack.push(prevScreen);
    if (_screenStack.length > 30) _screenStack.shift();
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId)?.classList.add('active');
  window.scrollTo(0, 0);
  if (screenId === 'screen-checkin') {
    session.ui.currentCheckinType = param === 'appointment' ? 'appointment' : 'walkin';
    checkin.renderGuestsContainer();
    const label = document.getElementById('checkin-type-label');
    if (label) label.innerHTML = param === 'appointment'
      ? '<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px;color:#785a1a">calendar_today</span> Appointment Check-In</span>'
      : 'Walk-In Check-In';
  }
  if (screenId === 'screen-desk') { utils.updateDeskDate(); settings.initCalHoursSelectors(); maybeShowWhatsNew(); }
}

// ── "What's new" — one-time popup after a device loads a new version ──────────
// Shown on the staff dashboard (never the customer kiosk) when this device's last-seen version
// differs from the loaded APP_VERSION. Brand-new devices are recorded silently (no popup). Plain-
// English; add an entry (newest first) each release. To re-read it: window.showWhatsNew().
const WHATS_NEW = [
  { v: 'v5.39', items: [
    { icon: 'bug_report', t: 'The app now tells you when something quietly breaks', d: 'TurnDesk now captures errors automatically — even ones that don’t freeze the screen — so a failure you didn’t happen to notice isn’t lost. See them in Settings → Data & System → Diagnostics (newest first, with how many times each happened). Turn on “Bug alerts” there to get a push the moment something new or serious fails (like a card charge or a save that couldn’t reach the server) — deduped so one glitch can’t spam you. Nothing here changes your data; it’s just a safety net so problems surface instead of hiding.' },
  ] },
  { v: 'v5.38', items: [
    { icon: 'login', t: '“Sign in needed” is now clear, not a mystery “Offline”', d: 'If a device can’t sync because it needs a sign-in — a manager/fallback code that can’t sync, an expired session, or a removed user — it now shows “Sign in needed” (tap it to enter your PIN) instead of looking like a network problem. And if you unlock the app with a code that can’t sync, it tells you to sign in with your front-desk PIN.' },
  ] },
  { v: 'v5.37', items: [
    { icon: 'sticky_note_2', t: 'Customer note now shows in Assign & Price', d: 'When you open Assign & Price for a checked-in customer, the notes panel now shows the customer’s saved note (allergies, preferences) right above today’s visit note — so you see both while you price the ticket.' },
  ] },
  { v: 'v5.36', items: [
    { icon: 'sticky_note_2', t: 'Customer + visit notes in the Staff app', d: 'On the Staff app, a tech’s assigned-customer card can now show two notes: a Customer note that stays with the customer every visit (allergies, preferences), and a note for just today’s visit. Tap to edit in a pop-up. You control this per tech in Settings → Staff — view or edit the customer note, view or edit the visit note. Everyone starts able to see the visit note only; turn the rest on per tech.' },
  ] },
  { v: 'v5.33', items: [
    { icon: 'point_of_sale', t: 'Phone Reports app: drawer shows bill counts, hides cash-outs', d: 'In the phone Reports app, the Drawer view now lists the opening and closing bill counts for each drawer, and no longer shows cash-out entries. The main dashboard drawer view is unchanged.' },
  ] },
  { v: 'v5.31', items: [
    { icon: 'point_of_sale', t: 'Cash drawer in Reports, plus a counts-only print', d: 'You can now see the current cash drawer and past drawer history right in the Reports tab — and in the phone Reports app — with print buttons. Each closed drawer can print the full report, or just the opening and closing bill counts (no cash in/out or reconciliation).' },
  ] },
  { v: 'v5.30', items: [
    { icon: 'print', t: 'Cash drawer report prints clearly on the receipt printer', d: 'The printable cash drawer report now uses the same large, bold receipt-roll format as customer receipts, so it comes out crisp and readable on the 80mm receipt printer instead of tiny.' },
  ] },
  { v: 'v5.29', items: [
    { icon: 'receipt_long', t: 'Customer receipts now show the total only', d: 'Customer receipts no longer print the per-service / item breakdown by default — they show the grand total and how the customer paid (card, cash, tip). If you ever want the itemized lines back, turn on “Show charge breakdown on receipts” in Settings → Business → Receipt & Reviews.' },
    { icon: 'insights', t: 'Sales report is cleaner and easier to scan', d: 'The Sales report now puts the numbers you check most — money collected, guests, and card vs cash — right at the top, with the rest grouped tighter underneath. Each box shows its up/down change right next to the amount, and tips, retail, fees and gift cards sit in a compact grid.' },
  ] },
  { v: 'v5.28', items: [
    { icon: 'density_medium', t: 'Turns board fits more techs on busy days', d: 'The technician rows on the Turns board are now more compact, so more of your team fits on one screen when it’s busy. Each tech’s turn count sits right next to their name, and the cards size themselves to how many techs are working — roomier with a few, tighter with many. The technician who’s up next now shows a single “Next up” tag in place of the “Available” tag.' },
  ] },
  { v: 'v5.27', items: [
    { icon: 'desktop_windows', t: 'Desktop notifications for new chat messages', d: 'The front-desk computer can now pop a desktop notification when a new chat message comes in — so you see it even when you’re in another window. Open Chat and tap “Turn on desktop notifications,” then allow it in the browser. It won’t show while the customer check-in screen is up.' },
  ] },
  { v: 'v5.26', items: [
    { icon: 'auto_awesome', t: 'Bonus services stand out on the Turns board', d: 'A “Bonus” service now gets its own muted teal badge — the same kind of highlight a half-turn gets — so bonus work is easy to spot at a glance instead of blending in.' },
    { icon: 'mood', t: 'Emojis in chat', d: 'The staff chat composer now has an emoji button — tap the smiley to drop an emoji into your message. Works in the Team chat, Front Desk chat, and direct messages.' },
  ] },
  { v: 'v5.25', items: [
    { icon: 'event_available', t: 'Calendar: past days show who came in vs no-showed', d: 'On previous days, appointments no longer all look the same. Each one is checked against your sales records: if that customer was rung up that day it shows blue “Completed”; if they had a phone/check-in on file but no record, it shows red “No Show.” Bookings with no way to match (no phone, never checked in) stay neutral so a walk-in is never wrongly flagged. Today is unchanged — it still shows live status.' },
  ] },
  { v: 'v5.24', items: [
    { icon: 'visibility_off', t: 'Receipts: no last name or phone', d: 'Printed customer receipts now show only the customer’s first name — never their last name or phone number — for privacy.' },
    { icon: 'tune', t: 'Toggle the charge breakdown on receipts', d: 'New setting in Settings → Business → Receipt & Reviews: “Show charge breakdown on receipts.” Leave it on to print every service/item line, or turn it off to print just the total.' },
  ] },
  { v: 'v5.23', items: [
    { icon: 'format_size', t: 'Receipts print larger & darker', d: 'The detail lines on printed receipts (services, technician names, payment breakdown, footer) were too faint and small on the thermal printer. Receipt text is now bigger and bolder — both the customer receipt and the staff “80mm roll” — so everything is easy to read.' },
  ] },
  { v: 'v5.22', items: [
    { icon: 'print', t: 'Print receipts on a receipt-roll printer', d: 'You can now print on an 80mm thermal receipt printer. In Sales → a transaction, tap “Print” for a customer receipt (shop info, services, items, totals, tip, how they paid, and a thank-you). In Payroll → “Print staff receipts” there’s a new “80mm roll” button to print each tech’s billing on the roll to hand out. The old “Receipt” button still reprints the card slip on the Helcim terminal.' },
    { icon: 'qr_code_2', t: 'Review QR on receipts you can re-point any time', d: 'Customer receipts can show a “Leave us a review” QR code. It’s permanent — you never reprint it — but you decide where it sends people. Go to Settings → Business → Receipt & Reviews and paste your Google review link (or any link); change it whenever you want and even already-printed receipts follow the new link. The QR only prints once you’ve set a link.' },
  ] },
  { v: 'v5.21', items: [
    { icon: 'keyboard', t: 'Chat: keyboard no longer closes while typing', d: 'On the staff app, typing a message no longer gets interrupted — incoming messages now update the conversation without closing your keyboard or losing what you’ve typed.' },
  ] },
  { v: 'v5.20', items: [
    { icon: 'vertical_align_bottom', t: 'Chat: auto-scroll fixed + no more iPhone zoom', d: 'Opening a chat now scrolls straight to the newest message, and on iPhone the chat no longer zooms in when you open it.' },
  ] },
  { v: 'v5.19', items: [
    { icon: 'chat', t: 'Chat polish: live updates, auto-scroll, no double pings', d: 'The chat now updates in real time — a new message shows up without closing and reopening the window — and it scrolls straight to the latest message. Also fixed chat push notifications arriving twice on the same phone.' },
  ] },
  { v: 'v5.18', items: [
    { icon: 'notifications_off', t: 'Fix: chat button no longer shows a phantom “0”', d: 'On the staff app the chat button was always showing a red badge (even with no messages) and the count didn’t clear after reading — a styling bug kept it stuck on. It now shows only a real unread count and disappears once you’ve read your messages.' },
  ] },
  { v: 'v5.17', items: [
    { icon: 'mark_chat_read', t: 'Chat fixes: unread badge & turning on notifications', d: 'Opening the chat now clears the group unread badge (it would get stuck before), and a stale count clears when you reopen the app. Turning on notifications now tells you exactly what to do if it doesn’t work — most often it’s that notifications were blocked and need to be re-enabled in your phone’s Settings for the Muse Staff app.' },
  ] },
  { v: 'v5.16', items: [
    { icon: 'support_agent', t: 'Front Desk team chat', d: 'Chat now has a dedicated “Front Desk” channel that only front-desk staff see. Every message there pings all front-desk members’ phones — so it works as a real team-alert channel. The all-staff “Team” chat and direct messages are unchanged.' },
    { icon: 'notifications_active', t: 'Chat notifications reach phones reliably', d: 'Fixed chat push so a tagged or direct message reaches a technician’s phone right away (it now uses the same notification channel as assignment alerts). Reminder: each person needs the Muse Staff app installed on their phone with notifications turned on — on iPhone it must be added to the Home Screen first.' },
  ] },
  { v: 'v5.15', items: [
    { icon: 'forum', t: 'Staff chat — now with direct messages & @mentions', d: 'The chat is redesigned: a “Team” group plus private 1:1 messages to any staff member, each conversation with its own unread count. Type @ to tag someone in the Team chat. Bigger window with a maximize button, and the chat button is easier to tap.' },
    { icon: 'smartphone', t: 'Chat on the staff app + phone notifications', d: 'Technicians and front desk can open the same chat from the staff app (the chat button, bottom-right). When you’re @mentioned or sent a direct message, your phone gets a notification — so you don’t have to be watching the screen. The staff app now asks to turn on notifications.' },
  ] },
  { v: 'v5.14', items: [
    { icon: 'animation', t: 'Fix: the “bounce” when toggling a service', d: 'In Settings → Services, tapping a Check-in/Dashboard toggle made the whole row jump, and the switch knob over-sprang. The row no longer animates when you tap a control inside it, and the toggle slides smoothly — no more bounce.' },
  ] },
  { v: 'v5.13', items: [
    { icon: 'toggle_on', t: 'Fix: service toggles & buttons tap reliably again', d: 'A recent fix that stopped popups closing while you select text was too aggressive — it could swallow taps on buttons with small parts inside, like the Check-in / Dashboard toggles in Settings → Services (they’d “bounce” and not switch). Taps now register normally; only an actual drag still counts as “clicking outside”.' },
  ] },
  { v: 'v5.12', items: [
    { icon: 'sell', t: 'Fix: “Awaiting price” no longer looks Done on the Turns board', d: 'A service the front desk marked “Done — tech will price” was showing the blue “Done” color on the Turns board even though it still needs a price. It now shows a violet “Awaiting price” color (added to the legend), so it’s clear which finished services still need pricing.' },
  ] },
  { v: 'v5.11', items: [
    { icon: 'highlight_alt', t: 'Fix: selecting text in a popup no longer closes it', d: 'When you dragged to select text in a field (like a name) and let go over the dimmed area, the popup would close. Now popups only close on a real click outside — dragging to select text keeps them open. Applies everywhere across the app.' },
  ] },
  { v: 'v5.10', items: [
    { icon: 'event', t: 'Appointment marker on the Turns board', d: 'Customers who came from a booked appointment now show a small lavender “Appt” tag on their turn card (on the time/status line), so you can tell appointments from walk-ins at a glance — the same info the Queue already shows.' },
  ] },
  { v: 'v5.09', items: [
    { icon: 'design_services', t: 'Fix: unselecting a technician’s services', d: 'In Staff → edit a technician, tapping a service to turn it off now visibly clears it (it had stayed highlighted even though it was actually being removed). Selecting and unselecting services now shows the right on/off state every time.' },
  ] },
  { v: 'v5.08', items: [
    { icon: 'visibility', t: 'Turns board polish', d: 'The “Totals” button now shows an eye icon that closes when totals are hidden. Also fixed a half-turn count (like 4.5t) that could overlap the divider between a tech and their turns on some screens — it now tucks neatly under the status instead.' },
  ] },
  { v: 'v5.07', items: [
    { icon: 'attach_money', t: 'Hide tech dollar totals on the Turns board', d: 'The Turns board has a new “Totals” button in the toolbar. Tap it to hide the “$ billed” line under each technician — handy on a shared screen so staff aren’t comparing earnings. Turn counts stay visible. It’s set per device, so each iPad or computer remembers its own choice.' },
  ] },
  { v: 'v5.06', items: [
    { icon: 'view_week', t: 'Turns board — clearer split between tech and turns', d: 'On the Turns board the turn bubbles used to butt right up against each technician’s box. You can now add a little separation: go to Settings → Workflow → Turns Board Display and pick “Divider line” (a thin rule) or “Recessed lane” (the bubbles sit in a soft tinted track). It’s set per device, so each iPad or computer remembers its own choice.' },
  ] },
  { v: 'v5.05', items: [
    { icon: 'event_available', t: 'Past days no longer show false “No Show”', d: 'Earlier appointments were getting marked “No Show” automatically when a guest was checked in without being linked to their booking — so previous days filled up with no-shows that never happened. The app no longer auto-marks no-shows; only the “Mark No Show” button does. Past days now show calmly instead of all in red. To clean up the ones already marked, go to Settings → Data Recovery → “Calendar — past no-shows,” pick a start date, and tap “Clear past no-shows.”' },
  ] },
  { v: 'v5.04', items: [
    { icon: 'price_change', t: 'Customer Price Menu in the app', d: 'Tap your name (top-right) → “Price Menu” to pull up the full customer price list on the iPad, or tap “Print / Save as PDF” to print a fresh elegant copy. It includes the new Gel Manicure and notes the $2 cash discount.' },
    { icon: 'schedule', t: 'The queue shows who has waited too long', d: 'Each waiting guest now has a wait timer that turns amber after about 15 minutes and red after 25, so it’s obvious at a glance who needs attention. You can also tap anywhere on a guest’s card to open Assign & Price, and the filter tabs (Waiting, In Service, Done, Paid) show live counts.' },
    { icon: 'swap_vert', t: 'Turns board — who’s next, at a glance', d: 'The available technician due for the next walk-in is now flagged “Next up.” Turn counts are a little bigger, the boxes line up evenly, and the colors are clearer: green now always means “in service,” with Available, Working now, On break and Off easy to tell apart.' },
    { icon: 'grid_view', t: 'Clearer floor plan', d: 'On the floor plan, each technician’s photo or initial shows their status as a clean colored outline, and the next tech up for a walk-in gets a “Next” arrow.' },
    { icon: 'search', t: 'Search your Settings', d: 'Settings now has a search box at the top — type “turn,” “pay period,” “stations,” etc. to jump straight to any setting instead of hunting through the categories. Every setting also has an icon now.' },
  ] },
  { v: 'v5.03', items: [
    { icon: 'update', t: 'Apps update themselves', d: 'A device left open all day (like the front-desk iPad) now checks for new versions on its own every so often, so the “Update available” prompt shows up without anyone needing to close and reopen the app first.' },
  ] },
  { v: 'v5.02', items: [
    { icon: 'pending', t: 'Done now, price later', d: 'A tech can be finished with a service but still working on the same customer and not ready to give a price. Tap a service’s status in Assign & Price and choose “Done — tech will price”: it shows as “Awaiting price” (purple) and the tech enters the amount from their app — they get a notification and a reminder on their phone. Payment stays locked until it’s priced, and you can always type the price yourself to fill it in.' },
    { icon: 'lock_clock', t: 'Tech prices never get lost', d: 'If a ticket’s Assign & Price window was left open at the front desk while a tech updated a price on their app, that price could quietly get overwritten. It no longer does — the tech’s amount is kept, and the open window now updates to show it. A ticket left untouched for a few minutes also frees itself so another device can open it.' },
  ] },
  { v: 'v5.01', items: [
    { icon: 'system_update', t: 'Update prompts you won’t miss', d: 'When a new version is published, the app now pops up an “Update available” message with an Update button — instead of only a small ↻ on the version number that was easy to overlook. Tap Update to load the newest version; your data is never affected. The same prompt is now in every app (front desk, the tech app, Reports, and Back Office).' },
  ] },
  { v: 'v4.98', items: [
    { icon: 'menu_book', t: 'Help is in your account menu', d: 'Tap your name (top-right) for an App guide and a 1-page Quick reference — what each screen and button does and the front-desk flow. Open either one and tap “Print / Save as PDF” to print it or save a PDF. “What’s new” lives there too.' },
  ] },
  { v: 'v4.97', items: [
    { icon: 'undo', t: 'Refunds go back through Helcim', d: 'The Refund button now sends the card portion back through Helcim instead of Square. When you issue a refund, tick “Also refund to the card (Helcim)” and the money returns to the customer’s card; cash/Zelle and gift-card portions are recorded/returned as before. It’s safe to retry — the same refund won’t be sent twice.' },
  ] },
  { v: 'v4.96', items: [
    { icon: 'receipt_long', t: 'Receipt button works with Helcim', d: 'The transaction “Receipt” button no longer tries to use Square. Since Helcim doesn’t let apps trigger the terminal’s printer, for a Helcim card sale it now shows you how to reprint a copy on the terminal itself — open the terminal’s menu (≡) → Transactions, find the sale by its transaction number, and tap Reprint.' },
  ] },
  { v: 'v4.95', items: [
    { icon: 'savings', t: 'Cash drawer over/short syncs to the books', d: 'When you push a day’s sales to the Back Office books app, the cash drawer’s over/short (what you counted minus what was expected) now goes too — so the books reflect the cash you actually had, not just recorded sales. In Back Office, map “Cash drawer — over/short” to a Cash over/short account.' },
  ] },
  { v: 'v4.94', items: [
    { icon: 'dialpad', t: 'Cleaner phone keypad', d: 'When you tap a phone field at check-in, the on-screen keypad no longer shows the “AC” clear button that was covering the number on the iPad — the full phone number stays visible as you type. Use the backspace key to fix a digit.' },
  ] },
  { v: 'v4.93', items: [
    { icon: 'chair', t: 'Techs see the station', d: 'Each customer card in the tech app now shows which station they’re at, and the new-customer alert names the station too — so a tech knows exactly where to go.' },
    { icon: 'swap_horiz', t: 'Floor switcher stays put', d: 'The Turns / Queue / Floor Plan switcher now sits at the far left on all three tabs, so it stops jumping to a different spot when you switch between them.' },
    { icon: 'swipe_vertical', t: 'Checkout scrolls on the iPad', d: 'The Confirm Payment screen now scrolls properly — you can always see the services at the top and reach the “Already paid — record without charging” button at the bottom, even on a busy ticket.' },
  ] },
  { v: 'v4.92', items: [
    { icon: 'price_check', t: '“Already paid — record without charging” fixed', d: 'On the pay screen, the manager option to record a ticket as already paid (no card charge) now opens its confirmation properly instead of doing nothing.' },
  ] },
  { v: 'v4.91', items: [
    { icon: 'groups', t: 'Smarter tech suggestions', d: 'When a customer has more than one service, the Turns suggestions now spread the work across different techs instead of piling it on whoever’s next: the next-up tech gets the bigger service (full set → fill → dip → manicure → pedicure → polish change → kid pedicure), and wax / add-ons go first to the techs who can do them, keeping those specialists free for wax. Tip: set each tech’s services in Settings → Staff so this knows who can do what.' },
  ] },
  { v: 'v4.89', items: [
    { icon: 'view_column', t: 'Payroll header tidied up', d: 'On the Payroll tab the Reports/Payroll switch now sits in the center with the “clocked in now” box to its left, the pay-period arrows centered just below, and the Technicians/Front Desk switch beside them — less crowded and easier to find.' },
  ] },
  { v: 'v4.88', items: [
    { icon: 'badge', t: 'New “Reviewer” role', d: 'A role with the same limits as Front Desk but with Reports & Payroll access — for someone who reviews the numbers without running the register. Pick it when adding/editing a front-desk user; fine-tune any role under Settings → Staff & Access → Role Permissions.' },
    { icon: 'calendar_view_day', t: 'Unassigned view spreads out', d: 'Tapping “Unassigned” on the Calendar now widens the appointment cards to fill the column, so they’re actually easier to read.' },
    { icon: 'how_to_reg', t: 'Quick check-in stays put', d: 'Checking a guest in from the Turns upcoming-appointments strip no longer jumps you to the Queue tab — you stay on Turns.' },
    { icon: 'pin', t: 'See PINs inline', d: 'In Settings → Staff & Access, “View Login PINs” now reveals each front-desk PIN right next to the name instead of opening a separate list.' },
    { icon: 'contrast', t: 'Half turns stand out', d: 'A half-turn customer’s turn number (top-right of their card in the Turns tab) now sits in a small amber box, so you can spot half turns at a glance.' },
    { icon: 'more_time', t: 'Faster manual punches', d: 'Adding a punch to a timecard now defaults to today, 9:00 AM in and 5:00 PM out — less to change.' },
  ] },
  { v: 'v4.87', items: [
    { icon: 'schedule', t: 'Clock in/out moved', d: 'Your clock in / clock out button now lives inside your account menu (tap your name, top-right) so it’s harder to hit by accident.' },
  ] },
  { v: 'v4.86', items: [
    { icon: 'verified_user', t: 'Server lock — sign in with your PIN', d: 'The salon server can now require a sign-in before it hands out any data. Nothing new to learn: the first time you use a browser, enter your usual PIN and it stays signed in (~30 days). Works on any device or browser; wrong guesses get slowed down automatically. Nothing changes until the owner turns enforcement on.' },
    { icon: 'account_balance', t: 'Back Office sync', d: 'Push a day’s sales (and locked payroll periods) to the Back Office books app from Settings → Integrations → Back Office sync. Rows wait for approval over there — the books can never change anything here.' },
  ] },
  { v: 'v4.85', items: [
    { icon: 'event_available', t: 'Booking status on every column', d: 'A checked-in or paid appointment with multiple staff now shows its status on ALL of its calendar columns (including Unassigned) — no more “not checked in” on a paid booking.' },
  ] },
  { v: 'v4.84', items: [
    { icon: 'smartphone',   t: 'Muse Reports — on your phone', d: 'A new installable app at /reports.html: the full Reports + Payroll numbers, phone-sized and read-only. Front-desk PIN login; only roles with “View Reports & Payroll” can get in.' },
    { icon: 'payments',     t: 'Payroll page reworked',        d: 'Switch between Technicians and Front Desk pay; Front Desk now has a Check / Cash split (right-click to adjust) and is included when you lock a pay period. Only the table scrolls sideways now, and the period arrows moved up next to the clocked-in box.' },
    { icon: 'point_of_sale', t: 'Drawer tip payouts fixed',    d: 'Tips covered by Zelle or a gift card now record a drawer cash-out automatically when you pay the tech from the drawer — the drawer no longer comes up short on those.' },
    { icon: 'event_repeat', t: 'Cleaner appointment edits',    d: 'Editing an appointment — especially with multiple staff — no longer briefly shows duplicates or the old version on the calendar.' },
    { icon: 'tune',         t: 'Staff app controls per tech',  d: 'In the technician editor you can now switch off the PDF download, the History tab, or customer names in history for each tech’s Muse Staff app.' },
  ] },
  { v: 'v4.83', items: [
    { icon: 'palette',    t: 'Staff color key on week view', d: 'The weekly calendar now shows a color key above the grid, so you can tell whose appointments are whose at a glance.' },
    { icon: 'swap_horiz', t: 'Browse past updates',          d: 'Use the ‹ › arrows at the top of this popup to look back through earlier update notes (and a clearer Day | Week switch on the Calendar).' },
  ] },
  { v: 'v4.82', items: [
    { icon: 'calendar_view_week', t: 'Calendar week view',          d: 'A new Day | Week toggle on the Calendar. Week shows all 7 days side by side, colored by tech — tap a day to jump into it, tap a booking for the usual popup.' },
    { icon: 'event',              t: 'Techs see their appointments', d: 'The Muse Staff app has a new “Appts” tab — each tech sees their own upcoming appointments for the week, with services and notes.' },
    { icon: 'notifications_active', t: 'New-booking alerts for techs', d: 'When the front desk books an appointment for a tech, their phone gets a notification with the customer and time (uses the same alerts switch as assignment pings).' },
    { icon: 'badge',              t: 'Pick who to print',            d: 'Staff PDF now asks which staff receipts to print — check just the ones you need, with Select all / Deselect all.' },
    { icon: 'picture_as_pdf',     t: 'Payroll PDF fits the page',    d: 'The payroll PDF now prints 4 staff per page with headers repeated — nothing gets cut off on the right anymore.' },
    { icon: 'table_view',         t: 'Excel payroll export',         d: 'The CSV button is now Excel: a Totals tab plus a tab per staff with their pay summary, day-by-day numbers, and every service line itemized.' },
    { icon: 'lock_person',        t: 'Role permissions are live',    d: 'The toggles in Settings → Role Permissions now really control access — View Reports & Payroll, Manage Staff, Manage Services, and Mark Paid without charging.' },
  ] },
  { v: 'v4.80', items: [
    { icon: 'palette',       t: 'Clearer status colors',     d: 'In Service is now green and Done (waiting to pay) is now blue — easy to tell apart at a glance on the Turns and Queue boards.' },
    { icon: 'calculate',     t: 'Calculator in money fields', d: 'Type math right in any price/amount box — e.g. 40+5+10. On the iPad keypad use the + − × ÷ keys; on a computer just type it. A running tape shows the total; press Enter to confirm the number, Enter again to save.' },
    { icon: 'groups',        t: 'Per-person subtotals',      d: 'Assign & Price now shows each guest’s subtotal just above the Party Total.' },
    { icon: 'receipt_long',  t: 'Payment Mix counts',        d: 'Reports now shows how many tickets per payment type (e.g. Card · 16 tickets · $1,004).' },
    { icon: 'sync_alt',      t: 'Clearer reconcile',         d: 'Reconcile with Helcim now spells out the Fee Saver surcharge, so the app total and the Helcim total line up.' },
    { icon: 'history',       t: 'Better historical entries', d: 'Adding a past sale now lets you pick the payment method (and a reference/transaction #), and the customer name auto-fills as you type.' },
    { icon: 'price_check',   t: 'Record an outside payment', d: 'Managers can mark a ticket paid without charging — for a payment taken another way, like keyed straight on the terminal. Two-step confirm on the pay screen.' },
    { icon: 'verified',      t: 'Missed-charge safety net',  d: 'If a card charge went through but the ticket wasn’t marked paid, the app now finds the matching charge and offers to fix it — never charges again.' },
  ] },
];
let _whatsNewChecked = false;
function maybeShowWhatsNew() {
  if (_whatsNewChecked) return;
  // Staff dashboard only (never the customer kiosk). Don't mark checked until the desk is actually
  // active — so an early call while still on the welcome screen retries later instead of blocking.
  if (!document.getElementById('screen-desk')?.classList.contains('active')) return;
  _whatsNewChecked = true;
  let seen = null; try { seen = localStorage.getItem('turndesk_whatsnew_seen'); } catch {}
  if (seen === APP_VERSION) return;                                   // already saw this version
  const usedBefore = (() => { try { return !!(localStorage.getItem('turndesk_device_id') || localStorage.getItem('turndesk_state_cache')); } catch { return false; } })();
  const markSeen = () => { try { localStorage.setItem('turndesk_whatsnew_seen', APP_VERSION); } catch {} };
  if (seen == null && !usedBefore) { markSeen(); return; }            // brand-new device → record silently
  const idx = WHATS_NEW.findIndex(e => e.v === seen);
  const entries = idx > 0 ? WHATS_NEW.slice(0, idx) : (idx === 0 ? [] : [WHATS_NEW[0]]);   // everything newer than seen (or the latest)
  if (!entries.length) { markSeen(); return; }
  showWhatsNew(entries);
}
function showWhatsNew(entries) {
  _wnIdx = 0;
  _renderWhatsNew(entries || [WHATS_NEW[0]]);
  const m = document.getElementById('whatsnew-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
// ‹ › in the popup header page one release at a time, up to 5 releases back.
const WHATSNEW_MAX_BACK = 5;
let _wnIdx = 0;   // 0 = newest release
function whatsNewNav(delta) {   // +1 = older, -1 = newer
  const maxIdx = Math.min(WHATS_NEW.length, WHATSNEW_MAX_BACK) - 1;
  _wnIdx = Math.max(0, Math.min(maxIdx, _wnIdx + delta));
  _renderWhatsNew([WHATS_NEW[_wnIdx]]);
}
function _renderWhatsNew(list) {
  const body = document.getElementById('whatsnew-body'); if (!body) return;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  body.innerHTML = list.flatMap(e => e.items).map(it => `
    <div class="flex items-start gap-3">
      <span class="material-symbols-outlined text-primary flex-shrink-0" style="font-size:20px;margin-top:1px">${esc(it.icon)}</span>
      <div class="min-w-0"><div class="font-headline font-bold text-on-surface text-sm">${esc(it.t)}</div>
        <div class="text-[13px] font-body text-on-surface-variant leading-snug">${esc(it.d)}</div></div>
    </div>`).join('');
  body.scrollTop = 0;
  const vEl = document.getElementById('whatsnew-version'); if (vEl) vEl.textContent = '· ' + (list[0]?.v || APP_VERSION);
  const maxIdx = Math.min(WHATS_NEW.length, WHATSNEW_MAX_BACK) - 1;
  const prev = document.getElementById('whatsnew-prev'), next = document.getElementById('whatsnew-next');
  if (prev) prev.disabled = _wnIdx >= maxIdx;
  if (next) next.disabled = _wnIdx <= 0;
  const wrap = prev?.parentElement; if (wrap) wrap.style.display = maxIdx <= 0 ? 'none' : '';   // nothing to browse yet
}
function closeWhatsNew() {
  try { localStorage.setItem('turndesk_whatsnew_seen', APP_VERSION); } catch {}
  const m = document.getElementById('whatsnew-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; }
}
Object.assign(window, { showWhatsNew, closeWhatsNew, whatsNewNav });
// ── Grouped top nav (v4.74) ──────────────────────
// 5 tabs; grouped panels switch via the subnav segments under the header. The Reports group
// (Reports | Payroll) is gated by the viewReports role permission (Settings → Role
// Permissions) — the tab is hidden and direct opens are blocked.
const NAV_GROUPS = {
  floor:      { navId: 'nav-floor',      panels: [['turns','swap_vert','Turns'], ['queue','queue','Queue'], ['floorplan','grid_view','Floor Plan']] },
  money:      { navId: 'nav-money',      panels: [['transactions','receipt_long','Transactions'], ['giftcards','card_giftcard','Gift Cards']] },
  reportsgrp: { navId: 'nav-reportsgrp', panels: [['reports','bar_chart','Reports'], ['payroll','payments','Payroll']] },
  // Settings isn't a real group (its tab always opens Settings); 'admin' only renders the
  // Settings|Customers subnav while on the Customers panel so there's an obvious way back.
  admin:      { navId: 'nav-settings',   panels: [['settings','tune','Settings'], ['customers','contacts','Customers']] },
};
const groupOf = p => Object.keys(NAV_GROUPS).find(g => NAV_GROUPS[g].panels.some(t => t[0] === p));
const lastGroupView = {};
const canViewReportsGroup = () => session.canDo('viewReports');
function showDashGroup(g) { showDashPanel(lastGroupView[g] || NAV_GROUPS[g].panels[0][0]); }
function syncNavForRole() {
  const btn = document.getElementById('nav-reportsgrp');
  if (btn) btn.style.display = canViewReportsGroup() ? '' : 'none';
}
function renderDashSubnav(grp, activePanel) {
  document.querySelectorAll('.subnav-slot').forEach(s => { if (s.innerHTML) s.innerHTML = ''; });
  const global = document.getElementById('dash-subnav');
  if (!grp) { if (global) { global.classList.add('hidden'); global.innerHTML = ''; } return; }
  const html = '<div class="subnav-seg">' + NAV_GROUPS[grp].panels.map(([id, icon, label]) =>
    `<button class="subnav-btn${id === activePanel ? ' on' : ''}" onclick="showDashPanel('${id}')"><span class="material-symbols-outlined" style="font-size:17px">${icon}</span><span class="subnav-label">${label}</span></button>`).join('') + '</div>';
  const slot = document.getElementById('subnav-slot-' + activePanel);
  if (slot) { slot.innerHTML = html; if (global) { global.classList.add('hidden'); global.innerHTML = ''; } }
  else if (global) { global.classList.remove('hidden'); global.innerHTML = html; }   // fallback row (Customers)
}

function showDashPanel(panel) {
  if ((panel === 'reports' || panel === 'payroll') && !canViewReportsGroup()) { utils.showToast('Your role doesn’t have permission to view Reports & Payroll.'); return; }
  closeAllModals();
  ['queue','reports','transactions','payroll','turns','settings','giftcards','calendar','floorplan','customers'].forEach(p => {
    document.getElementById(`panel-${p}`)?.classList.remove('active');
  });
  ['nav-floor','nav-calendar','nav-money','nav-reportsgrp','nav-settings'].forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(`panel-${panel}`)?.classList.add('active');
  const grp = groupOf(panel);
  document.getElementById(grp ? NAV_GROUPS[grp].navId : `nav-${panel}`)?.classList.add('active');
  if (grp && grp !== 'admin') lastGroupView[grp] = panel;
  renderDashSubnav(panel === 'settings' ? null : grp, panel);
  syncNavForRole();
  // Re-render the panel being shown so it reflects the latest state. onStateChange only
  // re-renders the ACTIVE panel, so a queue change that landed while another tab was open
  // left the Queue panel stale (a check-in showed in Turns but not Queue until a refresh).
  if (panel === 'queue')        { queue.renderQueue(); queue.updateStats(); }
  if (panel === 'floorplan')    floorplan.renderFloorPlan();
  if (panel === 'reports')      reports.setReportRange('today');
  if (panel === 'transactions') reports.renderTransactions();
  if (panel === 'payroll')      reports.renderPayrollPage();
  if (panel === 'settings')     settings.renderSettingsPanel();
  if (panel === 'giftcards')    giftcards.renderGiftCards();
  if (panel === 'customers')    sqCust.renderCustomersTab();
  if (panel === 'calendar')     calendar.initCalendar();
  if (panel === 'turns') {
    const di = document.getElementById('turns-history-date'); if (di && !di.value) di.value = utils.todayStr();
    turns.renderTurns();
  }
  maybeShowWhatsNew();   // fallback trigger: catches the dashboard being reached by any path (gated to the desk screen)
}
function toggleStaffScheduleView() {
  const listView = document.getElementById('staff-list-view'), scheduleView = document.getElementById('staff-schedule-view'), btn = document.getElementById('schedule-view-btn');
  if (!listView || !scheduleView) return;
  const showingSchedule = !scheduleView.classList.contains('hidden');
  listView.classList.toggle('hidden', !showingSchedule);
  scheduleView.classList.toggle('hidden', showingSchedule);
  if (btn) { btn.style.background = showingSchedule ? '' : '#1a5252'; btn.style.color = showingSchedule ? '' : '#fff'; }
  if (!showingSchedule) staff.renderSchedule();
}
function showStaffListView() {
  document.getElementById('staff-list-view')?.classList.remove('hidden');
  document.getElementById('staff-schedule-view')?.classList.add('hidden');
  const btn = document.getElementById('schedule-view-btn'); if (btn) { btn.style.background = ''; btn.style.color = ''; }
}
Object.assign(window, { goTo, showDashPanel, showDashGroup, toggleStaffScheduleView, showStaffListView });

// Let a mouse wheel scroll the top nav horizontally when it overflows a narrow desktop window
// (touch already pans it; the scrollbar is hidden via .no-scroll). justify-content:safe center
// keeps both ends reachable when it overflows.
(() => {
  const nav = document.getElementById('dash-nav');
  if (!nav) return;
  nav.addEventListener('wheel', (e) => {
    if (!e.deltaY || nav.scrollWidth <= nav.clientWidth) return;   // only hijack a vertical wheel when it actually overflows
    e.preventDefault();
    nav.scrollLeft += e.deltaY;
  }, { passive: false });
})();

// Live-sync status pill: tapping it forces a reconnect + fresh snapshot (catches up any
// changes missed while the socket was asleep), then reports state.
window.forceSyncNow = () => {
  // If the block is a missing sign-in, retrying the sync just 401s again — open the PIN screen instead.
  if (store.getState().authNeeded) { window.showPinModal?.(); return; }
  sync.resync?.(); utils.showToast(store.getState().connected ? 'Live — syncing…' : 'Reconnecting…');
};

// ── Square auto-paid ──────────────────────────────
// The Square return tab writes turndesk_sq_paid on a successful charge; this (main)
// tab marks those customers Paid. Triggered by the storage event (return tab
// wrote it), regaining focus, and hydrate (covers a reopened app). IDs not yet in
// the hydrated queue are kept for a later pass; degrades to manual Mark Paid.
function applySquarePaidFlag() {
  let flag; try { flag = JSON.parse(localStorage.getItem('turndesk_sq_paid') || 'null'); } catch (e) { return; }
  if (!flag || !flag.ids || !flag.ids.length) return;
  if (Date.now() - (flag.at || 0) > 10 * 60 * 1000) { localStorage.removeItem('turndesk_sq_paid'); return; }
  const queue = store.getState().queue, remaining = [];
  flag.ids.forEach(id => {
    const e = queue.find(x => String(x.id) === String(id));
    if (!e) { remaining.push(id); return; }                 // not hydrated yet — retry on a later trigger
    if (!['paid', 'done'].includes(e.status)) window.updateStatus?.(String(id), 'paid');
  });
  if (remaining.length) localStorage.setItem('turndesk_sq_paid', JSON.stringify({ ids: remaining, at: flag.at }));
  else localStorage.removeItem('turndesk_sq_paid');
}
window.addEventListener('storage', e => { if (e.key === 'turndesk_sq_paid' && e.newValue) applySquarePaidFlag(); });
// NB: the day rollover is intentionally NOT triggered straight off visibilitychange — it would run
// on stale cached config before a resync lands (and could wrongly clear the roster). The resync
// fired on tab-visible pulls a fresh snapshot whose hydrate runs runDayRolloverIfNeeded with
// server-confirmed state (see onStateChange 'hydrate').
document.addEventListener('visibilitychange', () => { if (!document.hidden) { applySquarePaidFlag(); checkSquarePending(); checkAppVersion(); helcim.checkUnfinalizedCharges?.(); } });

// Installed-PWA fallback for the Square charge. On iOS a Home-Screen app is resumed
// after the Square hand-off WITHOUT the callback data, so the turndesk_sq_paid handoff
// above never fires (there's no return tab). But proceedSquarePayment stashed
// turndesk_sq_pending in this app's own storage right before launching Square, so on
// resume we ask the operator whether the charge went through — iOS gives us no way to
// know — and mark Paid on confirm. Handled once: the pending flag is cleared the moment
// we prompt, and we skip if the Safari return tab already wrote turndesk_sq_paid.
function checkSquarePending() {
  let pend; try { pend = JSON.parse(localStorage.getItem('turndesk_sq_pending') || 'null'); } catch (e) { return; }
  if (!pend || !pend.ids || !pend.ids.length) return;
  if (Date.now() - (pend.at || 0) > 8 * 60 * 1000) { localStorage.removeItem('turndesk_sq_pending'); return; }
  if (localStorage.getItem('turndesk_sq_paid')) return;   // Safari return tab is handling it
  localStorage.removeItem('turndesk_sq_pending');          // handle once
  const ids = pend.ids.map(String);
  const amt = pend.cents ? ` — $${(pend.cents / 100).toFixed(2)}` : '';
  const who = pend.names || 'this customer';
  const markPaid = () => {
    ids.forEach(id => { const e = store.getState().queue.find(x => String(x.id) === id); if (e && !['paid', 'done'].includes(e.status)) window.updateStatus?.(id, 'paid'); });
    utils.showToast('Marked paid');
  };
  if (window.showWarnModal) window.showWarnModal('Square payment complete?', `Mark ${who}${amt} as Paid? Tap Confirm if the charge went through in Square, or Cancel if it was canceled.`, markPaid);
}

// ── Store subscription → re-render the active panel on (remote) changes ───────
function updateSyncIndicator(state) {
  const dot = document.getElementById('conn-dot'), text = document.getElementById('conn-text');
  if (!dot) return;
  const pill = dot.parentElement;
  // "Sign in needed" is NOT the same as "Offline" — the server rejected this device for
  // lack of a valid session (wrong/fallback code, expired, or removed user). Say so, and
  // make the pill open the PIN screen, so nobody chases a network problem that isn't there.
  // Checked BEFORE failed-ops: signing in is the prerequisite to recovering anything, so the
  // label matches what a tap does (forceSyncNow opens the PIN screen when authNeeded).
  if (state.authNeeded) {
    dot.style.background = '#e8730a';   // amber — distinct from the red "Offline"
    if (text) text.textContent = 'Sign in needed';
    if (pill) pill.title = 'This device needs a sign-in — enter your front-desk PIN to reconnect. Tap to sign in.';
    return;
  }
  // A server-rejected/dead-lettered write is the next most urgent state — surface it instead of a green "Synced".
  const failed = (sync.failedOps?.() || []).length;
  if (failed > 0) { dot.style.background = '#fa746f'; if (text) text.textContent = `${failed} failed`; if (pill) pill.title = 'A change failed to save — open Settings → Data Recovery'; return; }
  const n = state.pendingCount || 0, queued = n === 1 ? '1 change queued' : `${n} changes queued`;
  if (state.connected) {
    dot.style.background = n > 0 ? '#f5c870' : '#2a7a4f';
    if (text) text.textContent = n > 0 ? `Syncing · ${n}` : 'Live';
    if (pill) pill.title = n > 0 ? `${queued} — sending now. Tap to force a sync.` : 'Connected — everything saved. Tap to force a sync.';
  } else {
    dot.style.background = '#fa746f';
    if (text) text.textContent = n > 0 ? `Offline · ${queued}` : 'Offline';
    if (pill) pill.title = n > 0 ? `${queued} — they'll send automatically when the connection returns. Tap to retry now.` : 'No connection — changes will queue and send when it returns. Tap to retry.';
  }
}
// One-time cleanup of a stray inert config key ('x') left by an ops probe on 2026-07-02.
// Nothing reads it; neutralize it to null once per session (self-heals across devices).
let _cfgXPurged = false;
function _purgeStrayConfigX() {
  if (_cfgXPurged) return;
  const c = store.getState().config || {};
  if (c.x != null) { _cfgXPurged = true; sync.dispatch('config.set', { key: 'x', value: null }); }
}
function onStateChange(state, changed) {
  updateSyncIndicator(state);
  if (changed === 'connection') return;
  if (changed === 'chat.append') chat.onChatSync();   // a new chat message — refresh the open panel + badge (its own op, not 'config')
  if (changed === 'hydrate') { applySquarePaidFlag(); runDayRolloverIfNeeded(); helcim.checkUnfinalizedCharges?.(); _purgeStrayConfigX(); }   // apply pending Square auto-paid + roll over the day; catch any unfinalized Helcim charge (throttled)
  if (changed === 'hydrate' || (changed && changed.startsWith('config'))) {
    photos.setLogo(); auth.updateLoggedInDisplay(); chat.onChatSync(); timeclock.renderClockButton(); helcim.syncProcessorClass();
    syncNavForRole();   // a role_permissions toggle (any device) can show/hide the Reports tab
    // The customer directory is now a DO entity — it hydrates from the snapshot like records,
    // so no Square auto-pull on boot. (A one-time "Import from Square" seeds it; see the
    // Customers tab.) square-customers.js rebuilds its directory caches on every store change.
  }
  const desk = document.getElementById('screen-desk');
  if (!desk || !desk.classList.contains('active')) return;
  queue.refreshOpenAssignFields?.();   // reflect a tech's synced price into an open Assign & Price modal
  const active = document.querySelector('.dash-panel.active'); if (!active) return;
  switch (active.id) {
    case 'panel-turns':        turns.renderTurns(); break;
    case 'panel-floorplan':    floorplan.renderFloorPlan(); break;
    case 'panel-queue':        queue.renderQueue(); queue.updateStats(); break;
    case 'panel-reports':      reports.runReport(); break;
    case 'panel-transactions': reports.renderTransactions(); break;
    case 'panel-payroll':      reports.renderPayrollPage(); break;
    case 'panel-giftcards':    giftcards.renderGiftCards(); break;
  }
}

// ── Version check (display + tap for a HARD reload; no auto-reload loop) ───────
// The version badge is always a hard-reload button: on an installed iPad app a plain
// reload can keep serving the cached version, so tapping it unregisters the service
// worker + clears the cache and reloads to force the newest version. Data is untouched.
let _autoPromptedVersion = null;   // newest version we've already auto-popped this session
async function checkAppVersion() {
  const badge = document.getElementById('app-version-badge');
  if (!badge) return;
  // Up to date → tapping the version shows the latest "What's new". When an update is available
  // (below) it becomes a reload button instead.
  badge.textContent = APP_VERSION;
  badge.title = 'What’s new in this version';
  badge.style.cursor = 'pointer';
  badge.classList.remove('update-pulse');
  badge.onclick = () => showWhatsNew();
  try {
    const res = await fetch('/turndesk/version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) {
      badge.textContent = data.version + ' ↻';
      badge.title = `Update ${data.version} available — tap to reload`;
      badge.classList.add('update-pulse');   // E2: make the update glyph discoverable
      badge.onclick = () => utils.showUpdatePopup(data.version);
      // The badge alone kept getting missed — pop a prominent prompt once per new version
      // (on boot and on every tab-resume until they update).
      if (_autoPromptedVersion !== data.version) { _autoPromptedVersion = data.version; utils.showUpdatePopup(data.version); }
    }
  } catch (e) {}
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/turndesk/sw.js').catch(e => console.warn('[SW] registration failed:', e));
}

// ── Daily rollover (self-healing, midnight boundary) ──────────────────────────
// Replaces the old fragile 4 AM `setTimeout` reset. The day boundary no longer affects data
// integrity (records are the source of truth — see buildCombinedRecords), so this is just
// board hygiene + new-day housekeeping. Runs on hydrate, on tab-visible, and on a timer
// armed to the next local midnight; idempotent, so running it repeatedly is safe.
function runDayRolloverIfNeeded() {
  const today = utils.todayStr();
  const st = store.getState();
  const recIds = new Set((st.records || []).filter(r => r.status !== 'deleted').map(r => String(r.id)));
  // Finished tickets from a previous day that are ALREADY saved as a record — safe to drop
  // from the live board (the record is the permanent copy). Computed BEFORE we clear, so the
  // archive below still sees them. Active or unrecorded entries are never auto-removed.
  const stale = (st.queue || []).filter(e =>
    (e.status === 'paid' || e.status === 'done') &&
    recIds.has(String(e.id)) &&
    utils.localDateStr(new Date(e.checkinTime)) < today);
  // New-day housekeeping — once per day GLOBALLY (gated on the SHARED, synced last_rollover_date,
  // not a per-device marker). This is the fix for "my selected technicians disappeared mid-day":
  // the housekeeping CLEARS the roster (rolloverTurns → setOrder([])), and that clear broadcasts to
  // every device. With the old per-device gate, any device first opened mid-day (its local marker
  // still on yesterday) would think it was a new day, run the clear, and wipe the roster everyone
  // was using. Reading the marker from synced config means a device that shows up mid-day sees
  // "already rolled over today" and leaves the roster alone. Only callers with FRESH server state
  // run this (hydrate + the midnight timer) — NOT the raw visibilitychange path, which can fire on
  // stale cached config before a resync lands.
  const globalLast = st.config?.last_rollover_date || '';
  const action = utils.rolloverAction(globalLast, today);
  let didRollover = false;
  if (action === 'seed') {
    // Marker absent (fresh DO, or upgrading from the per-device scheme): seed to today WITHOUT
    // clearing anything, so the upgrade itself can never wipe a live roster.
    sync.dispatch('config.set', { key: 'last_rollover_date', value: today });
  } else if (action === 'rollover') {
    sync.dispatch('config.set', { key: 'last_rollover_date', value: today });   // claim first (synced) so other devices skip
    try { turns.rolloverTurns(globalLast); } catch (e) {}                        // archive closed day + clear the rotation
    sync.dispatch('config.set', { key: 'turns_break', value: [] });
    sync.dispatch('config.set', { key: 'chat_log', value: [] });                 // staff chat starts fresh each day
    utils.showToast("New day — yesterday's history saved");
    didRollover = true;
  }
  // Safe board cleanup — runs every time (idempotent); also self-heals a stale entry that a
  // still-connected device re-pushed from its outbox after a clear.
  if (stale.length) {
    stale.forEach(e => sync.dispatch('queue.remove', { id: e.id }));
    window.logAudit?.('Day rollover', `Cleared ${stale.length} finished ticket(s) from a prior day`);
  }
  if (stale.length || didRollover) { queue.renderQueue(); queue.updateStats(); turns.renderTurns(); chat.renderChat(); chat.updateChatBadge(); }
}
// Arm a one-shot timer to the next local midnight (+30s); it re-arms itself after firing.
// Hydrate + visibilitychange are the real safety net (cover device sleep / clock changes);
// this timer only handles a device left open across midnight.
function armMidnightRollover() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  setTimeout(() => { runDayRolloverIfNeeded(); armMidnightRollover(); }, nextMidnight - now);
}

// ── PWA install ───────────────────────────────────
let _pwaInstallEvent = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _pwaInstallEvent = e; document.getElementById('pwa-install-banner')?.classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { _pwaInstallEvent = null; document.getElementById('pwa-install-banner')?.classList.add('hidden'); });
window.promptPwaInstall = () => { if (!_pwaInstallEvent) return; _pwaInstallEvent.prompt(); _pwaInstallEvent.userChoice.then(() => { _pwaInstallEvent = null; document.getElementById('pwa-install-banner')?.classList.add('hidden'); }); };

// ── Keyboard shortcuts ────────────────────────────
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      // A calc in progress (an amount field with a typed expression) → Enter CONFIRMS the number and
      // keeps the modal open. A second Enter (now a plain number) falls through to Save below.
      if (utils.commitAmountField(document.activeElement)) { e.preventDefault(); return; }
      const gm = document.getElementById('group-assign-modal');
      if (gm && !gm.classList.contains('hidden')) { e.preventDefault(); queue.saveGroupAssignments(); return; }
      const mm = document.getElementById('manual-modal');
      if (mm && !mm.classList.contains('hidden')) { const tag = document.activeElement?.tagName; if (tag !== 'SELECT' && tag !== 'TEXTAREA') { e.preventDefault(); queue.submitManualAdd(); return; } }
    }
    if (e.key === 'Escape') {
      for (const [id, fn] of MODAL_CLOSERS) { const el = document.getElementById(id); if (el && !el.classList.contains('hidden')) { fn(); return; } }
      const chatP = document.getElementById('chat-panel');
      if (chatP && !chatP.classList.contains('hidden')) { chat.closeChat(); return; }
      const calDD = document.getElementById('cal-selector-dropdown');
      if (calDD && !calDD.classList.contains('hidden')) { calendar.calSelectorCancel(); return; }
      const checkinScreen = document.getElementById('screen-checkin');
      if (checkinScreen && checkinScreen.classList.contains('active')) { goTo('screen-welcome'); return; }
      const pinModal = document.getElementById('pin-modal');
      if (pinModal && !pinModal.classList.contains('hidden')) { pinModal.classList.add('hidden'); pinModal.style.display = ''; }
    }
  });
}

// ── Square POS return handler ─────────────────────
// Square's mobile-web payment flow returns by opening callback_url in a NEW Safari
// tab — Apple's sandbox won't let an external app reuse an existing tab, so the tab
// itself is unavoidable (confirmed by Square). When we detect that return, show a
// tiny self-closing screen instead of booting a second live dashboard, and try to
// auto-close (best-effort; iOS usually blocks closing a non-script-opened tab).
function handleSquarePosReturn() {
  const fields = (s) => { const o = {}; try { new URLSearchParams(s).forEach((v, k) => { o[k] = v; }); } catch (e) {} return o; };
  const p = { ...fields(location.hash.replace(/^#/, '')), ...fields(location.search.replace(/^\?/, '')) };
  if (p.data) { try { Object.assign(p, JSON.parse(p.data)); } catch (e) {} }
  if (!['status', 'transaction_id', 'client_transaction_id', 'error_code'].some(k => k in p)) return false;

  const errored = p.status === 'error' || !!p.error_code;
  // On a successful charge, hand the stashed party off to the main tab to mark Paid.
  try {
    if (!errored) { const pend = JSON.parse(localStorage.getItem('turndesk_sq_pending') || 'null'); if (pend && pend.ids && pend.ids.length) localStorage.setItem('turndesk_sq_paid', JSON.stringify({ ids: pend.ids, at: Date.now() })); }
    localStorage.removeItem('turndesk_sq_pending');
  } catch (e) {}
  document.title = 'Muse — Payment';
  document.body.innerHTML = `
    <div style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#e8ecee;font-family:-apple-system,system-ui,sans-serif;">
      <div style="text-align:center;padding:32px;max-width:340px;">
        <div style="font-size:56px;line-height:1;margin-bottom:16px;">${errored ? '⚠️' : '✓'}</div>
        <div style="font-size:22px;font-weight:800;color:#1a5252;margin-bottom:8px;">${errored ? 'Payment not completed' : 'Payment complete'}</div>
        <div style="font-size:15px;color:#555;margin-bottom:24px;">You can close this tab and return to the Muse dashboard.</div>
        <button onclick="window.close()" style="background:#1a5252;color:#fff;border:none;padding:14px 28px;border-radius:14px;font-size:16px;font-weight:700;">Close tab</button>
      </div>
    </div>`;
  try { window.close(); } catch (e) {}
  setTimeout(() => { try { window.close(); } catch (e) {} }, 300);
  return true;
}

// ── Global error surface ──────────────────────────
// On a headless front-desk iPad nobody watches the console — an uncaught error/rejection
// would otherwise leave a frozen screen with no signal. Best-effort: log + a throttled toast.
let _lastErrToast = 0;
function _errToast() {
  const now = Date.now();
  if (now - _lastErrToast < 15000) return;   // don't spam if errors cascade
  _lastErrToast = now;
  try { utils.showToast('Something went wrong. If the screen seems stuck, tap the version badge to reload.'); } catch (e) {}
}
window.addEventListener('error', e => { try { console.warn('[error]', e?.error || e?.message); _errToast(); reporter.reportError('window.error', (e && (e.error || e.message)) || 'error'); } catch (x) {} });
window.addEventListener('unhandledrejection', e => { try { console.warn('[unhandledrejection]', e?.reason); reporter.reportError('unhandledrejection', (e && e.reason) || 'rejection'); } catch (x) {} });

// ── Boot ──────────────────────────────────────────
function boot() {
  if (handleSquarePosReturn()) return; // don't boot a 2nd live app in the Square return tab
  reporter.initReporter();            // flush any queued error reports + re-flush on reconnect
  auth.routeSignedOut();              // land on the business sign-in, or the kiosk on a front-desk device
  setupBackHandler();                 // OS back returns to the previous screen, never reloads the PWA
  sync.start();                       // connect to the DO, hydrate from cache + snapshot
  store.subscribe(onStateChange);
  appearance.applyUserTheme();        // default light palette until a user logs in

  utils.startClock();
  utils.updateDeskDate();
  utils.startElapsedTimer();
  checkin.renderGuestsContainer();
  photos.setLogo();
  queue.renderQueue();
  auth.updateLoggedInDisplay();
  chat.initChatDeskNotify();   // dashboard opts into desktop notifications for new chat messages
  chat.onChatSync();   // baseline the chat unread badge from cache on load
  apptReminders.startApptReminders();   // appointment reminder banners (30s timer)
  updateSyncIndicator(store.getState());

  // Confirm screen: tap anywhere to return to welcome
  const confirmScreen = document.getElementById('screen-confirm');
  if (confirmScreen) {
    const reset = () => { clearTimeout(window._confirmResetTimer); goTo('screen-welcome'); };
    confirmScreen.addEventListener('click', reset);
    confirmScreen.addEventListener('touchend', e => { e.preventDefault(); reset(); });
  }

  wireKeyboard();
  armMidnightRollover();
  utils.initAmountFieldCalc();   // desktop: evaluate "40+5" typed into an amount field on blur
  checkAppVersion();
  // Also poll periodically so an always-open front-desk iPad (which never fires a fresh
  // launch/visibilitychange) still notices a new deploy and prompts on its own. Skipped while
  // hidden — visibilitychange already covers the return-to-app case.
  setInterval(() => { if (!document.hidden) checkAppVersion(); }, 20 * 60 * 1000);
  registerServiceWorker();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
