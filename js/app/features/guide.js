// ── Guide — printable in-app documentation (Full + Quick reference) ────────────
// Opens a self-contained, print-friendly document in a new tab; "Print / Save as
// PDF" produces the PDF. Kept in code (not a committed binary) so it never drifts
// from the app. Exposed on window via main.js glue for the account-menu buttons.

const STYLE = `
*{box-sizing:border-box}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1c1c1c;max-width:820px;margin:0 auto;padding:0 24px 64px}
.bar{position:sticky;top:0;background:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #ddd;margin-bottom:14px}
.bar button{background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
h1{font-size:25px;margin:14px 0 2px}
h2{font-size:19px;margin:26px 0 6px;border-bottom:2px solid #eee;padding-bottom:4px}
h3{font-size:15.5px;margin:16px 0 3px}
p{margin:6px 0}ul,ol{margin:5px 0 5px 20px;padding:0}li{margin:3px 0}
.sub{color:#666;font-size:13px;margin-top:0}
code{background:#f1f1f1;border-radius:4px;padding:1px 5px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border:1px solid #dcdcdc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}
.step{background:#f7f5fe;border:1px solid #e2d9f7;border-radius:8px;padding:10px 14px;margin:8px 0}
.sw{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px;border:1px solid rgba(0,0,0,.15)}
.tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
@media print{.bar{display:none}body{max-width:none;padding:0}}
@page{margin:1.4cm}
`;

function openDoc(title, html) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to open the guide.'); return; }
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `<div class="bar"><strong>${title}</strong><button onclick="window.print()">Print / Save as PDF</button></div>` +
    html + `</body></html>`);
  w.document.close();
}

export function openAppGuide() { openDoc('Muse — App Guide', FULL); }
export function openAppQuickRef() { openDoc('Muse — Quick Reference', QUICK); }

// ── Customer Price Menu — the elegant two-page print menu (Hands · Feet & Waxing) ──
// Same idea as the guide: a self-contained, print-friendly doc opened in a new tab so
// the front desk can show it on the iPad or print a fresh copy. Logo loads from the
// app's own assets/ so it resolves whatever path GitHub Pages serves from.
export function openPriceMenu() {
  const logoUrl = new URL('assets/muse-wordmark.png', location.href).href;
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to open the price menu.'); return; }
  w.document.write(priceMenuDoc(logoUrl));
  w.document.close();
}

const PRICE_MENU_STYLE = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
@page{size:Letter;margin:0}
body{font-family:'Jost',sans-serif;color:#1a1a1a;background:#e9e6df}
.bar{position:sticky;top:0;z-index:5;background:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid #ddd}
.bar strong{font-size:14px;letter-spacing:1px}
.bar button{background:#15514f;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
.page{width:8.5in;height:11in;padding:0.5in 0.6in 0.45in;background:#ffffff;margin:18px auto;box-shadow:0 4px 18px rgba(0,0,0,.16);display:flex;flex-direction:column;overflow:hidden}
.logo{display:block;margin:0 auto;width:2.5in;height:auto}
.rule{border:0;border-top:1px solid #cccccc;width:1.3in;margin:0.12in auto 0}
.pagetitle{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:25px;color:#1a1a1a;text-align:center;margin:7px 0 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 0.55in;margin-top:0.16in;flex:1}
.sec{font-family:'Cormorant Garamond',serif;font-weight:700;font-size:19px;letter-spacing:3px;color:#15514f;text-transform:uppercase;margin:15px 0 7px;display:flex;align-items:center;gap:9px}
.col>.sec:first-child{margin-top:0}
.sec::after{content:"";flex:1;border-bottom:1px solid #cccccc}
.row{display:flex;align-items:baseline;gap:7px;margin:5px 0}
.nm{font-size:15.5px;font-weight:400;color:#1a1a1a}
.dots{flex:1;border-bottom:1px dotted #cccccc;transform:translateY(-4px)}
.pr{font-size:15.5px;font-weight:500;color:#15514f;white-space:nowrap}
.desc{font-size:12px;color:#1a1a1a;font-style:italic;margin:-2px 0 4px}
.foot{margin-top:0.16in;border-top:1px solid #cccccc;padding-top:0.12in}
.foot p{margin:6px 0;font-size:12.5px;line-height:1.5;text-align:center;color:#1a1a1a}
.foot .cash{font-weight:500;color:#15514f}
.foot .fix{font-size:11.5px;color:#1a1a1a;font-style:italic}
@media print{.bar{display:none}body{background:#fff}.page{margin:0;box-shadow:none}}
`;

function priceMenuDoc(logoUrl) {
  const logo = `<img class="logo" src="${logoUrl}" alt="Muse Nails & Spa">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse — Price Menu</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">` +
    `<style>${PRICE_MENU_STYLE}</style></head><body>` +
    `<div class="bar"><strong>MUSE NAILS &amp; SPA · PRICE MENU</strong><button onclick="window.print()">Print / Save as PDF</button></div>` +

    `<section class="page">${logo}<hr class="rule"><div class="pagetitle">Hand Services</div><div class="cols">` +
      `<div class="col">` +
        `<div class="sec">Manicures</div>` +
        `<div class="row"><span class="nm">Classic Manicure</span><span class="dots"></span><span class="pr">$25</span></div><div class="desc">regular color included</div>` +
        `<div class="row"><span class="nm">Gel Manicure</span><span class="dots"></span><span class="pr">$38</span></div><div class="desc">gel color included</div>` +
        `<div class="row"><span class="nm">Deluxe Manicure</span><span class="dots"></span><span class="pr">$40</span></div><div class="desc">sugar scrub, mask, paraffin &amp; hot towel</div>` +
        `<div class="sec">Full Sets &amp; Fills</div><div class="desc" style="margin-top:0">set / fill &nbsp;·&nbsp; gel color removal included</div>` +
        `<div class="row"><span class="nm">Acrylic</span><span class="dots"></span><span class="pr">$56 / 46</span></div>` +
        `<div class="row"><span class="nm">Pink &amp; White or Ombré</span><span class="dots"></span><span class="pr">$65 / 56</span></div>` +
        `<div class="row"><span class="nm">Builder Gel</span><span class="dots"></span><span class="pr">$65 / 56</span></div>` +
        `<div class="row"><span class="nm">Hybrid Gel</span><span class="dots"></span><span class="pr">$60 / 50</span></div>` +
        `<div class="row"><span class="nm">Gel-X</span><span class="dots"></span><span class="pr">$65 / 56</span></div>` +
        `<div class="row"><span class="nm">Dip Powder</span><span class="dots"></span><span class="pr">$50</span></div>` +
        `<div class="sec">Removals</div>` +
        `<div class="row"><span class="nm">Gel Removal (only)</span><span class="dots"></span><span class="pr">$10</span></div>` +
        `<div class="row"><span class="nm">Extension Removal</span><span class="dots"></span><span class="pr">$20</span></div><div class="desc">$10 with a new service</div>` +
      `</div>` +
      `<div class="col">` +
        `<div class="sec">Color Changes</div>` +
        `<div class="row"><span class="nm">Regular Polish</span><span class="dots"></span><span class="pr">$15</span></div>` +
        `<div class="row"><span class="nm">Gel Color</span><span class="dots"></span><span class="pr">$25</span></div>` +
        `<div class="row"><span class="nm">Gel Extension Color</span><span class="dots"></span><span class="pr">$32</span></div>` +
        `<div class="sec">Add-Ons</div>` +
        `<div class="row"><span class="nm">Chrome · Gel Ombré · Cat Eye</span><span class="dots"></span><span class="pr">$10</span></div>` +
        `<div class="row"><span class="nm">Matte Top Coat</span><span class="dots"></span><span class="pr">$5</span></div>` +
        `<div class="row"><span class="nm">French Tip</span><span class="dots"></span><span class="pr">from $7</span></div>` +
        `<div class="row"><span class="nm">Airbrush / Marble</span><span class="dots"></span><span class="pr">from $15</span></div>` +
        `<div class="row"><span class="nm">Hand-Painted &amp; Custom Art</span><span class="dots"></span><span class="pr">from $30</span></div>` +
        `<div class="row"><span class="nm">Gems · Charms · Stones</span><span class="dots"></span><span class="pr">from $3</span></div>` +
        `<div class="sec">Little Ones</div><div class="desc" style="margin-top:0">under 13</div>` +
        `<div class="row"><span class="nm">Color Change</span><span class="dots"></span><span class="pr">$10</span></div>` +
        `<div class="row"><span class="nm">Gel Color Change</span><span class="dots"></span><span class="pr">$15</span></div>` +
        `<div class="row"><span class="nm">Manicure + Flower Design</span><span class="dots"></span><span class="pr">$20</span></div>` +
      `</div>` +
    `</div>` +
    `<div class="foot"><p>Every service is one of a kind — length, shape &amp; artwork all affect the final price, and it's impossible to list them all. For an exact quote, please ask your technician before your service begins.</p>` +
    `<p class="fix">Fixes within 7 days are complimentary (except regular color); after 7 days, repair pricing applies.</p>` +
    `<p class="cash">All prices reflect our $2 cash discount · Card payments are $2 more per ticket.</p></div></section>` +

    `<section class="page">${logo}<hr class="rule"><div class="pagetitle">Foot Services &amp; Waxing</div><div class="cols">` +
      `<div class="col">` +
        `<div class="sec">Pedicures</div>` +
        `<div class="row"><span class="nm">Classic Pedicure</span><span class="dots"></span><span class="pr">$33</span></div>` +
        `<div class="row"><span class="nm">Signature Pedicure</span><span class="dots"></span><span class="pr">$43</span></div>` +
        `<div class="row"><span class="nm">Volcano Pedicure</span><span class="dots"></span><span class="pr">$60</span></div>` +
        `<div class="row"><span class="nm">Muse Deluxe Pedicure</span><span class="dots"></span><span class="pr">$65</span></div>` +
        `<div class="row"><span class="nm">The Royal Treatment</span><span class="dots"></span><span class="pr">$80</span></div>` +
        `<div class="sec">Pedicure Add-Ons</div>` +
        `<div class="row"><span class="nm">Gel Polish</span><span class="dots"></span><span class="pr">$13</span></div>` +
        `<div class="row"><span class="nm">Clear Gel</span><span class="dots"></span><span class="pr">$13</span></div>` +
        `<div class="row"><span class="nm">French Tip</span><span class="dots"></span><span class="pr">$5</span></div>` +
        `<div class="row"><span class="nm">Cat Eye</span><span class="dots"></span><span class="pr">$10</span></div>` +
        `<div class="row"><span class="nm">Paraffin Wax</span><span class="dots"></span><span class="pr">$12</span></div>` +
        `<div class="row"><span class="nm">Callus Treatment</span><span class="dots"></span><span class="pr">$7</span></div>` +
        `<div class="row"><span class="nm">Extra Massage · 10 min</span><span class="dots"></span><span class="pr">$15</span></div>` +
        `<div class="row"><span class="nm">Shiny Buff</span><span class="dots"></span><span class="pr">$5</span></div>` +
        `<div class="sec">Toe Enhancements</div>` +
        `<div class="row"><span class="nm">Full Set · Gel</span><span class="dots"></span><span class="pr">$56</span></div>` +
        `<div class="row"><span class="nm">Full Set · Regular</span><span class="dots"></span><span class="pr">$50</span></div>` +
        `<div class="row"><span class="nm">Toes Fill</span><span class="dots"></span><span class="pr">$40</span></div>` +
        `<div class="row"><span class="nm">Big Toe · each</span><span class="dots"></span><span class="pr">$5</span></div>` +
        `<div class="row"><span class="nm">Acrylic Removal · 2 toes</span><span class="dots"></span><span class="pr">$5</span></div>` +
        `<div class="row"><span class="nm">Acrylic Removal · full set</span><span class="dots"></span><span class="pr">$10 / 20</span></div><div class="desc">with service $10 · without $20</div>` +
      `</div>` +
      `<div class="col">` +
        `<div class="sec">Color Changes</div>` +
        `<div class="row"><span class="nm">Regular</span><span class="dots"></span><span class="pr">$15</span></div>` +
        `<div class="row"><span class="nm">Gel</span><span class="dots"></span><span class="pr">$30</span></div>` +
        `<div class="sec">Little Ones</div>` +
        `<div class="row"><span class="nm">Pedicure + Flower Design</span><span class="dots"></span><span class="pr">$28</span></div>` +
        `<div class="row"><span class="nm">Mani &amp; Pedi Combo</span><span class="dots"></span><span class="pr">$48</span></div>` +
        `<div class="sec">Waxing</div>` +
        `<div class="row"><span class="nm">Eyebrows</span><span class="dots"></span><span class="pr">$15</span></div>` +
        `<div class="row"><span class="nm">Lip · Chin · Sideburns</span><span class="dots"></span><span class="pr">$10</span></div>` +
        `<div class="row"><span class="nm">Full Face</span><span class="dots"></span><span class="pr">from $50</span></div>` +
        `<div class="row"><span class="nm">Underarms</span><span class="dots"></span><span class="pr">$20</span></div>` +
        `<div class="row"><span class="nm">Half / Full Arm</span><span class="dots"></span><span class="pr">$25 / 45</span></div>` +
        `<div class="row"><span class="nm">Half / Full Leg</span><span class="dots"></span><span class="pr">$40 / 60</span></div>` +
        `<div class="row"><span class="nm">Chest</span><span class="dots"></span><span class="pr">from $40</span></div>` +
        `<div class="row"><span class="nm">Back</span><span class="dots"></span><span class="pr">from $60</span></div>` +
      `</div>` +
    `</div>` +
    `<div class="foot"><p>Every service is one of a kind — length, shape &amp; artwork all affect the final price, and it's impossible to list them all. For an exact quote, please ask your technician before your service begins.</p>` +
    `<p class="cash">All prices reflect our $2 cash discount · Card payments are $2 more per ticket.</p></div></section>` +

    `</body></html>`;
}

// ── Full guide — the detailed manual: every screen, button, symbol, and color ──
const FULL = `
<h1>Muse — App Guide</h1>
<p class="sub">The complete manual for the salon front-desk app: what every screen does, what each button does when you tap it, what every symbol and color means, and how text fields behave. The app runs on the front-desk iPad and on technician devices and syncs live across all of them.</p>

<h2>How to read the screen</h2>

<h3>Symbols &amp; icons</h3>
<table>
<tr><th>Symbol</th><th>Where</th><th>Meaning &amp; what tapping it does</th></tr>
<tr><td><code>↻</code> next to the version number</td><td>Top of the screen, on the version badge</td><td>An update is ready. <strong>Tap it</strong> to reload fresh (it signs the device out of the old cached files, clears the cache, and reloads so every file comes from the network). Tapping the version badge <em>any</em> time — with or without the <code>↻</code> — reopens <strong>What's new</strong>. If a screen ever looks stuck or stale, tapping here is the fix.</td></tr>
<tr><td>A small <strong>colored dot</strong></td><td>On every Queue, Turns, and Floor card, one per service</td><td>The service's status. The dot is a drawn circle (always the same size) so colors stay easy to compare. See the color table below.</td></tr>
<tr><td>A <strong>number</strong> on the top-right of a card</td><td>Queue / Turns cards</td><td>That customer's <strong>turn number</strong> — their place in the rotation. Not a button.</td></tr>
<tr><td>A small <strong>amber box</strong></td><td>Turns cards</td><td>This service counts as a <strong>half turn</strong> (a short/quick service) rather than a full turn, so rotation stays fair. Full turns show no box.</td></tr>
<tr><td>Outline line-icons</td><td>Nav and buttons (calendar, search, etc.)</td><td>Decorative labels for the button next to them — they do whatever their button says.</td></tr>
</table>

<h3>Color codes — the status system</h3>
<p>Every service shows its status with <strong>three cues at once</strong> — a colored dot, a text pill, and a row accent — so the floor can read state at a glance, and so it's clear even if you're color-blind. The flow is <strong>Waiting → In Service → Done → Paid</strong>.</p>
<table>
<tr><th>Color</th><th>Pill</th><th>Means</th></tr>
<tr><td><span class="sw" style="background:#f5c870"></span><strong>Amber</strong></td><td><span class="tag" style="background:#f5c870;color:#3a2800">Waiting</span></td><td>Checked in, service not started yet.</td></tr>
<tr><td><span class="sw" style="background:#2a7a4f"></span><strong>Green</strong></td><td><span class="tag" style="background:#2a7a4f;color:#fff">In Service</span></td><td>Actively being worked on. This is the only status that <strong>highlights the whole row</strong> with a colored bar and a light green tint — "the hot row" — so active work stands out on a busy board.</td></tr>
<tr><td><span class="sw" style="background:#1a5c7a"></span><strong>Blue</strong></td><td><span class="tag" style="background:#1a5c7a;color:#fff">Done</span></td><td>Service finished but <strong>payment not taken yet</strong>. It still counts and the technician has earned the turn — it's just waiting for checkout.</td></tr>
<tr><td><span class="sw" style="background:#8a9298"></span><strong>Slate / gray</strong></td><td><span class="tag" style="background:#5b6166;color:#fff">Paid</span></td><td>Sale finalized and recorded in Reports. The row <strong>fades</strong> and leaves the floor.</td></tr>
</table>
<p class="sub">Tip: a ticket can have several services at once, each with its own dot — so one card may show a mix (e.g. one service In Service, another still Waiting).</p>

<h3>Text fields &amp; formatting</h3>
<p>The app has free-text fields — customer notes (kept per phone number), the per-ticket memo/note, service and item names, etc. <strong>None of them use Markdown or any rich-text formatting.</strong> Whatever you type is stored and shown exactly as typed, as plain text, so symbols like <code>*</code>, <code>#</code>, or <code>**</code> appear literally rather than turning into bold or headings. Type normal words and numbers.</p>

<h2>The day in one line</h2>
<div class="step">Customer <strong>checks in</strong> → appears in the <strong>Queue</strong> → you <strong>Assign &amp; Price</strong> a technician and services → the service moves through its <strong>status</strong> (Waiting → In Service → Done) → <strong>Pay</strong> (cash, card, gift card, tips) → it becomes <strong>Paid</strong> and lands in <strong>Reports</strong>. <strong>Turns</strong> keeps rotation fair; the <strong>cash drawer</strong> is opened and closed each day.</div>

<h2>Header &amp; your account</h2>
<ul>
<li><strong>Your name (top-right)</strong> — tap it for your account menu: <strong>Clock in / out</strong>, <strong>App guide</strong> and <strong>Quick reference</strong> (this document and the short one, both printable to PDF), <strong>What's new</strong>, and <strong>Log out</strong>.</li>
<li><strong>Version badge</strong> — shows the app version; doubles as the reload/What's-new button (see the symbols table for <code>↻</code>).</li>
<li><strong>Search box</strong> — type a name or number to jump to a customer or a past ticket.</li>
</ul>

<h2>Check-in</h2>
<ul>
<li>Customers check themselves in at the kiosk, or you check them in from the front desk.</li>
<li><strong>Returning customers</strong> are matched by <strong>phone number</strong>; <strong>new</strong> customers are added to the directory on the spot.</li>
<li>Once checked in, the customer drops into the <strong>Queue</strong> as <strong>Waiting</strong> (amber).</li>
</ul>

<h2>Queue &amp; Assign &amp; Price</h2>
<ul>
<li>The <strong>Queue</strong> lists everyone Waiting or In Service, each as a card with its status dot/pill and turn number.</li>
<li><strong>Tap a card</strong> to open <strong>Assign &amp; Price</strong>. There you: choose the <strong>technician</strong>; add the <strong>services</strong>; add any <strong>items</strong> (with quantity) and <strong>fees</strong>; and set <strong>tips</strong> and a <strong>discount</strong>. This sets the ticket's price — the single source of truth for what's owed (services + items×qty + fees − discount). The total always reflects the live ticket; nothing is cached.</li>
<li><strong>Cross-device lock:</strong> while someone has a ticket open on another device, that ticket is <strong>locked</strong> so two people can't edit the same one at once. Wait for it to be released, or use the device that holds it.</li>
</ul>

<h2>Status flow (advancing a service)</h2>
<ul>
<li>Each service has a status button on its card. Advancing it moves <strong>Waiting → In Service → Done</strong>; checkout makes it <strong>Paid</strong>.</li>
<li>Starting <strong>In Service</strong> starts that service's work timer; marking <strong>Done</strong> stops it. (Going back to In Service and Done again adds the time correctly.)</li>
<li>If you advance a status by mistake, you can move it back — a correction restores the original timer rather than resetting it.</li>
<li>The same dot/pill/accent appears identically on Queue, Turns, and Floor cards.</li>
</ul>

<h2>Turns (rotation)</h2>
<ul>
<li>Tracks each technician's turn count so work is shared fairly — use it to decide who's "up" next.</li>
<li>A customer's <strong>turn number</strong> shows on the top-right of their card; a <strong>half turn</strong> (short service) shows in a small amber box and counts as half.</li>
<li>History is kept on a rolling window so you can see recent rotation.</li>
</ul>

<h2>Floor plan</h2>
<p>A visual map of the salon's stations with technician avatars. <strong>Drag a technician</strong> onto a station to seat them; each station type has its own capacity (set in Settings → Stations), so it won't let you over-fill a station type. Useful for seeing who's where at a glance.</p>

<h2>Pay / checkout</h2>
<ul>
<li>From a ticket, <strong>Confirm Payment</strong> opens checkout.</li>
<li><strong>Tenders:</strong> choose <strong>cash</strong>, <strong>card</strong>, or <strong>gift card</strong> — and <strong>split</strong> across more than one if needed (e.g. part gift card, part card).</li>
<li><strong>Tips</strong> and a <strong>gift-card redemption</strong> or discount are applied here.</li>
<li><strong>Card payments run on the Helcim Smart Terminal:</strong> confirm the amount in the app, the customer taps/inserts on the terminal, and the app waits for the result and records it automatically.</li>
<li><strong>Mark paid without charging a card</strong> — for cash already taken or an outside payment; it still records the sale.</li>
<li>Once paid, the service turns <strong>Paid</strong> (slate, fades) and the sale lands in Reports.</li>
<li><strong>Reprint a receipt</strong> and <strong>refund</strong> are available from the transaction afterward (see Reports). Card refunds go back to the original card via Helcim.</li>
</ul>

<h2>Quick Sale</h2>
<p>Sell a retail item or a gift card <strong>without</strong> a service ticket — a fast, no-service checkout. Add the item(s) or gift card, take payment the same way as a normal ticket.</p>

<h2>Customers</h2>
<ul>
<li>The <strong>Customers</strong> tab is your directory and the app is the source of truth for it.</li>
<li><strong>Search</strong> by name/number; <strong>add</strong> or <strong>edit</strong> a customer; <strong>delete</strong>; <strong>de-dup</strong> (merge duplicates); <strong>import</strong> a list; and keep per-customer <strong>notes</strong> (tied to the phone number, plain text).</li>
</ul>

<h2>Gift cards</h2>
<p>Sell gift cards (paid by cash or card) and <strong>redeem</strong> them at checkout by choosing gift card as a tender. Balances are tracked in the app.</p>

<h2>Cash register / drawer</h2>
<ul>
<li><strong>Open</strong> the drawer at the start of the day with a starting count.</li>
<li>Record <strong>cash in / cash out</strong> during the day as needed (pay-outs, drops, etc.).</li>
<li><strong>Close</strong> the drawer with a counted total; the app reconciles it against the expected cash and records <strong>over/short</strong> (which also pushes to Back Office). A <strong>PDF</strong> summary is available.</li>
</ul>

<h2>Appointments (calendar)</h2>
<p>Appointments are backed by <strong>Google Calendar</strong> and shown in the app. You can adjust the visible <strong>columns</strong> and <strong>display hours</strong>. <strong>Appointment reminders</strong> can be sent to customers by text.</p>

<h2>Reports, payroll &amp; refunds</h2>
<ul>
<li><strong>Reports:</strong> pick a <strong>date range</strong>, <strong>compare</strong> periods, see a <strong>performance chart</strong>, and <strong>drill in</strong> to the day's numbers.</li>
<li><strong>Transactions:</strong> every sale. From a transaction you can <strong>view</strong> it, <strong>reprint</strong> the receipt, <strong>refund</strong> a card sale (back to the original card), or <strong>edit</strong> a historical record.</li>
<li><strong>Payroll:</strong> technician earnings derived from the records, plus a <strong>Front Desk — Hourly</strong> section (hours × rate) with a manager <strong>timecard editor</strong>.</li>
</ul>

<h2>Time clock (front desk)</h2>
<p>Front-desk staff <strong>clock in / out</strong> from the account menu (tap your name). Punches feed the hourly payroll section. Clocking is <strong>locked to the front-desk station</strong> so it can't be done from just any device.</p>

<h2>Settings</h2>
<p>One place for: the <strong>Services, Items &amp; Fees</strong> catalog; <strong>staff &amp; schedules</strong>; <strong>stations</strong> (including per-station-type capacity); <strong>appearance</strong>; the <strong>payment processor</strong>; <strong>texting</strong>; <strong>integrations</strong> (including the Back Office daily-sales sync); <strong>photos/logo</strong>; and <strong>data tools</strong>.</p>

<h2>Technician app</h2>
<p>Technicians sign in on their own device to see their queue/turns. Front-desk users get a <strong>read-only schedule + hours</strong> view there.</p>

<h2>End of day</h2>
<div class="step">Finish open tickets → <strong>close the cash drawer</strong> (count + reconcile) → check <strong>Reports</strong> for the day → daily totals sync to Back Office automatically.</div>

<h2>Good to know</h2>
<ul>
<li>Everything syncs <strong>live</strong> across devices; a device that goes offline catches up when it reconnects.</li>
<li>A ticket's price is <strong>always</strong> the live total (services + items×qty + fees − discount) — never a stale saved number.</li>
<li><strong>Done</strong> means the work is finished but money hasn't been taken yet; <strong>Paid</strong> is the finalized sale.</li>
<li>If anything looks stale or stuck, tap the version badge to reload.</li>
</ul>
`;

// ── Quick reference — the everyday overview (was the old App Guide) ─────────────
const QUICK = `
<h1>Muse — Quick Reference</h1>
<p class="sub">The salon front-desk app at a glance: the daily workflow, each screen, and the key buttons. It runs on the front-desk iPad and on technician devices, and syncs live across all of them. (For exact button-by-button detail, symbols, and color meanings, see the full App guide.)</p>

<h2>The day in one line</h2>
<div class="step">Customer <strong>checks in</strong> → appears in the <strong>Queue</strong> → you <strong>Assign &amp; Price</strong> a technician and services → the service moves through its <strong>status</strong> (waiting → in service → done) → <strong>Pay</strong> (cash, card, gift card, tips) → it lands in <strong>Reports</strong>. The <strong>Turns</strong> tab keeps tech rotation fair; the <strong>cash drawer</strong> is opened and closed each day.</div>

<h2>Header &amp; your account</h2>
<ul>
<li>Top-right shows who's signed in. <strong>Tap your name</strong> for your account menu: <strong>Clock in / out</strong>, the <strong>App guide</strong> and <strong>Quick reference</strong> (printable to PDF), <strong>What's new</strong>, and <strong>Log out</strong>.</li>
<li>The <strong>version number</strong> is the update button: it shows a <code>↻</code> when a new version is available — tap it to reload fresh. Tapping it any time also reopens <strong>What's new</strong>. If a screen ever seems stuck, tap the version badge to reload.</li>
<li>The <strong>search</strong> box finds customers and past tickets fast.</li>
</ul>

<h2>Check-in</h2>
<ul>
<li>Customers check themselves in at the kiosk (or you check them in at the front desk). Returning customers are matched by phone; new ones are added to the directory.</li>
<li>Checked-in customers drop into the <strong>Queue</strong> as waiting.</li>
</ul>

<h2>Queue &amp; Assign &amp; Price</h2>
<ul>
<li>The <strong>Queue</strong> lists everyone waiting or in service, each as a card with a status dot/pill.</li>
<li>Tap a card → <strong>Assign &amp; Price</strong>: choose the technician, add the services and any items/fees, set tips/discounts. This sets the ticket's price (the single source of truth for what's owed).</li>
<li>While someone has a ticket open on another device, it's locked to avoid two people editing the same ticket at once.</li>
</ul>

<h2>Status flow</h2>
<p>Each service shows a colored dot + pill so the floor can read state at a glance: <strong>waiting</strong>, <strong>in service</strong>, <strong>done</strong>. The same styling appears on Queue, Turns, and Floor cards.</p>

<h2>Turns (rotation)</h2>
<ul>
<li>Tracks each technician's turn count so work is shared fairly. A customer's turn number shows on the top-right of their card; <strong>half turns</strong> appear in a small amber box.</li>
<li>Use it to decide who's "up" next. History is kept on a rolling window.</li>
</ul>

<h2>Floor plan</h2>
<p>A visual map of stations with technician avatars. Drag a tech to a station; each station type has its own capacity. Good for seeing who's where at a glance.</p>

<h2>Pay / checkout</h2>
<ul>
<li>From a ticket, <strong>Confirm Payment</strong> opens checkout: choose the tender(s) — <strong>cash</strong>, <strong>card</strong>, <strong>gift card</strong> — split across tenders if needed, add <strong>tips</strong>, and apply a <strong>gift-card redemption</strong> or discount.</li>
<li><strong>Card payments run on the Helcim Smart Terminal</strong>: confirm the amount on the app and the customer taps/inserts on the terminal; the app waits for the result and records it.</li>
<li>You can also <strong>mark a ticket paid without charging a card</strong> (e.g. cash already taken) — it still records the sale.</li>
<li><strong>Reprint a receipt</strong> from the transaction; <strong>refunds</strong> for card sales go back to the original card.</li>
</ul>

<h2>Quick Sale</h2>
<p>Sell a retail item or a gift card without a service ticket — a fast no-service checkout.</p>

<h2>Customers</h2>
<p>The <strong>Customers</strong> tab is your directory: search, add, edit, de-dup, import, and per-customer notes (kept by phone number). The app is the source of truth for the directory.</p>

<h2>Gift cards</h2>
<p>Sell gift cards (cash or card) and redeem them at checkout. Balances are tracked in the app.</p>

<h2>Cash register / drawer</h2>
<ul>
<li><strong>Open</strong> the drawer with a starting count at the start of the day; record <strong>cash in / out</strong> as needed.</li>
<li><strong>Close</strong> the drawer with a counted total to reconcile against expected cash; over/short is recorded (and pushed to Back Office). A PDF summary is available.</li>
</ul>

<h2>Appointments (calendar)</h2>
<p>Appointments are backed by Google Calendar and shown in the app. Columns and display hours are adjustable. Appointment reminders can be sent by text.</p>

<h2>Reports, payroll &amp; refunds</h2>
<ul>
<li><strong>Reports</strong>: pick a date range, compare periods, see a performance chart, and drill into the day's transactions.</li>
<li><strong>Transactions</strong>: every sale, with the ability to view, reprint, refund, or edit a historical record.</li>
<li><strong>Payroll</strong>: technician earnings from the records, plus a <strong>Front Desk — Hourly</strong> section (hours × rate) with a manager timecard editor.</li>
</ul>

<h2>Time clock (front desk)</h2>
<p>Front-desk staff clock in/out from their account menu (tap your name). Punches feed the hourly payroll section; clocking is locked to the front-desk station.</p>

<h2>Settings</h2>
<p>Services, items &amp; fees catalog; staff &amp; schedules; stations; appearance; payment processor; texting; integrations (including the Back Office daily-sales sync); photos/logo; and data tools.</p>

<h2>Technician app</h2>
<p>Technicians sign in on their own device to see their queue/turns and (for front-desk users) a read-only schedule + hours view.</p>

<h2>End of day</h2>
<div class="step">Finish open tickets → <strong>close the cash drawer</strong> (count + reconcile) → check <strong>Reports</strong> for the day → daily totals sync to Back Office automatically.</div>

<h2>Good to know</h2>
<ul>
<li>Everything syncs live across devices; if a device goes offline it catches up when it reconnects.</li>
<li>A ticket's price is always the live total — services + items×qty + fees − discount.</li>
<li>If anything looks stale or stuck, tap the version badge to reload.</li>
</ul>
`;
