# Chase Merchant Services — Card Processing Feasibility & Options

**Date:** 2026-07-15
**Trigger:** Krystal Nails Lounge (beta salon, `krystal-nails-lounge`) already has an active Chase Merchant Services account/terminal and wants it usable with TurnDesk.
**Status:** Research/options only. No code written. Nothing chosen yet — this is the input for a decision.

---

## 1. The core problem: Chase isn't Helcim

TurnDesk's live processor (Helcim) works because Helcim gives any developer a free sandbox account, documented REST APIs, and a Smart-Terminal-plus-webhook model built for exactly this kind of self-serve integration. **Chase Merchant Services does not work that way.** Two different things hide under "Chase card processing," and neither is a drop-in swap for Helcim:

| | Helcim (today) | Chase QuickAccept / Card Reader | Chase Orbital Gateway (Chase Paymentech) |
|---|---|---|---|
| What it is | Smart Terminal + REST API + webhooks | Chase's own reader + Chase's own POS app | The actual programmable payment API behind Chase Merchant Services |
| Get API access | Free self-service sandbox, instant | **No public third-party API at all** — Chase's own docs say a reader paired with "a partner software solution may not be eligible," and only a short curated list of named partners (TouchBistro, Silver Essentials/NCR Voyix, Authorize.net) integrate with it | Requires Chase to issue you separate "connection" credentials, then a **formal certification process** (submit a documented test-case suite, get certified) before you get production credentials |
| Typical route in for a small integrator | Direct | Not possible for a custom app | Usually **through an already-certified gateway/aggregator** (NMI, Datacap, Authorize.net, Spreedly) rather than direct certification — direct certification is built for software vendors shipping to many merchants, not a one-off |
| Timeline for one salon | Days (already done) | N/A (closed system) | Weeks–months if going direct; days–weeks if riding an existing certified aggregator that already has a Chase relationship |
| Business relationship needed | None beyond a Helcim account | None — but TurnDesk can't plug in | Chase account-manager involvement, possibly a business/reseller agreement |

**Bottom line: this is a business/partnership problem before it's a coding problem.** There is no scenario where we just "add Chase like we added Helcim" in a few days.

---

## 2. What TurnDesk's architecture actually requires (confirmed in code)

- `js/app/features/helcim.js` + `cloudflare/worker.js` (`/helcim/*`, `/terminal/webhook`) is a clean **proxy → HMAC-verified webhook → per-salon DO broadcast over WebSocket** pattern. It works because Helcim's Smart Terminal pushes a webhook when the customer completes the tap/insert on the physical device.
- **There is no processor abstraction.** `activeProcessor()` (`helcim.js`) is if/else, not a pluggable interface. Helcim-specific concepts (device code, invoice-number format, customer code, its HMAC scheme, normalized status strings) are hardcoded into the client module **and** into ~10+ call sites across `square-pos.js`, `giftcards.js`, `reports.js`. Adding *any* second live processor means editing all of those, not just dropping in a new file.
- **Credentials are global Worker secrets today**, not per-salon (`HELCIM_API_TOKEN`, `HELCIM_WEBHOOK_VERIFIER`). Fine for one Chase pilot salon; would need a redesign (per-salon config keys in the DO) if more than one salon ever needed distinct Chase credentials.
- The whole flow assumes **card-present, terminal-initiated** payment (customer taps hardware, server gets pushed a result). There's no card-not-present/hosted-fields path in the codebase at all today.

So even setting aside Chase's access model, "wire in Chase" is real surgery, not a config flag — and only makes sense if Chase's own flow is also terminal-push (fits the existing broadcast pattern) rather than something synchronous/different.

---

## 3. Options, ranked by realism

### Option A — Manual record only (no integration) — *cheapest, ships this week*
Krystal Nails keeps charging cards on their existing Chase terminal/app exactly as they do now, completely separate from TurnDesk. TurnDesk just gains a "Chase" tender option on the ticket (same shape as the existing cash/manual tender), so reporting/reconciliation in TurnDesk is accurate — but nothing talks to Chase's API, nothing verifies the charge happened, no webhook, no automation.

- **Effort:** trivial — extend the existing tender-type list (`config.payment_processor`-adjacent UI, not the processor itself) to add a labeled manual tender. A few hours, one call site (checkout tender picker), no Worker changes, no secrets, no certification.
- **Risk:** none technically. The tradeoff is purely UX — staff has to complete the charge on a separate device and then tell TurnDesk it happened, same as the salon does today with any other terminal it doesn't automate.
- **This is the honest floor** every other option is measured against — if the salon is fine with "record it, don't automate it," everything below is optional.

### Option B — Ride an already-certified aggregator (NMI / Datacap / Authorize.net / Spreedly) — *middle ground*
Instead of Chase directly, integrate against a gateway that already has Chase Paymentech ("Orbital") certification and exposes its own developer-friendly API. Krystal Nails' existing Chase merchant account may or may not be reachable this way — **this needs to be confirmed with Chase/the aggregator**, since some of these route processing through their own relationship rather than passing through to an existing merchant's Chase account as-is.

- **Effort:** moderate. Assuming the aggregator has self-service dev credentials (most of NMI/Authorize.net do), this looks structurally like the Helcim build — a `chase.js`-equivalent client module, proxy routes, webhook handling if the aggregator supports terminal-push, plus the ~10+ call-site surgery to add a third processor branch. Realistically 1–3 weeks of engineering, *if* the account-routing question resolves favorably.
- **Risk:** the salon's existing Chase account may not carry over cleanly — this could mean re-underwriting through the aggregator, which the salon owner would need to initiate, not us.
- **Unknown until we ask:** whether Krystal Nails' existing terminal/account is even compatible with any of these aggregators, and what it costs.

### Option C — Direct Chase Orbital certification — *most control, least realistic for one salon*
Go through Chase's own certification path: get connection credentials, build to their Orbital API/JSON spec, submit the certification test suite, get approved for production.

- **Effort:** high. This is a process built for software vendors selling to many merchants, not tuned for a single-salon add-on. Realistically weeks-to-months, and requires an actual business relationship with a Chase account rep (not just a signup form).
- **Risk:** highest — this is the path most likely to stall on Chase's side regardless of our engineering effort.
- **Only worth it if** TurnDesk plans to support Chase for many future salons, not just Krystal Nails — otherwise the ROI doesn't close for one customer.

### Option D — Chase's own QuickAccept/POS app, fully outside TurnDesk
Functionally the same as Option A from TurnDesk's side (no integration), but explicitly acknowledges Chase's product is a closed loop — the salon runs Chase's own app/reader in parallel, TurnDesk doesn't even add a labeled tender type, staff just note "paid — Chase" in an existing free-text/notes field.
- **Effort:** zero.
- Only meaningfully different from Option A if you don't even want the small UI addition of a labeled tender type. Not recommended over A.

---

## 4. Recommendation

**Start with Option A (manual tender label) regardless of what else happens** — it's near-zero cost, ships immediately, and gives the salon accurate reporting today while any real integration (B or C) is evaluated on its own timeline. It also de-risks the decision: if Option A turns out to be "good enough" for Krystal Nails in practice, we may never need B or C at all.

**Before spending any engineering time on B or C**, two things need to happen that are the owner's/salon's to do, not ours:
1. Ask Krystal Nails' Chase rep directly: *"Can our software integrate with your existing merchant account via a third-party gateway (NMI/Authorize.net/Datacap), or only through Chase's own POS app?"* — this single answer eliminates most of the guesswork in Options B/C above.
2. Decide whether this is a one-off accommodation for Krystal Nails, or a real TurnDesk product decision to support Chase as a processor going forward (like Helcim). That changes whether Option C's heavier certification lift is ever worth it.

## 5. Open questions (need answers before further planning)

- [ ] What Chase product/terminal does Krystal Nails currently use — Chase Card Reader + Chase POS app, or a countertop terminal, or something else?
- [ ] Will Chase/their aggregator confirm the existing merchant account can be reached via a third-party gateway integration?
- [ ] Is this a one-salon accommodation or a standing TurnDesk product decision (multi-tenant Chase support)?
- [ ] If B or C become real, does Krystal Nails' account need re-underwriting through the chosen aggregator, and who owns that conversation (not TurnDesk engineering)?
