# Muse port log — TurnDesk features to back-port to musedashboard

TurnDesk is a fork of Muse (same architecture: vanilla ES modules, `dispatch`/`applyChange`
DO sync, config-as-synced-state). Features built here that the owner wants in Muse later are
logged below with enough detail to replay the port. **Muse is the live single-salon app —
port deliberately, re-test against Muse's own code (file paths match, but Muse may have
diverged).**

Convention per entry: what changed · exact files/functions touched · any data-model/config-key
additions (these need the same migration care in Muse) · Muse-specific gotchas.

---

## Batch 2026-07-16 — staff visibility, staff PII, calendar customer-coloring, notes-everywhere

Status: **in progress on TurnDesk** (not yet ported to Muse). Details filled in as each ships.

### 1. Hide deactivated staff
- Where: staff-management list (collapse behind a "Show deactivated" toggle), Assign & Price
  tech dropdown, and the staff schedule view. (Already excluded elsewhere: turn board, floor
  plan, calendar columns, active pickers.) **Kept visible in reports/payroll** (historical).
- (files/functions — TBD after build)

### 2. Staff contact / PII fields
- New fields on the staff object: phone, email, home address, SSN/tax ID.
- SSN masked to last-4 in the UI, full value owner/manager-only. Stored in synced config like
  other staff data → **same data-integrity + backup exposure as all staff info** (note for Muse).
- (config/data-model addition — TBD)

### 3. Calendar: color by customer (not tech)
- Replaces per-tech column coloring with a stable per-customer color; appointments colored by
  customer so the same person reads the same everywhere, incl. across multiple techs.
- (files/functions + the stable-color hash — TBD)

### 4. Notes editable everywhere
- Both the customer permanent note and the visit note editable from: check-in / Assign & Price
  modal, calendar appointment detail, customer directory profile, and the turn/floor card.
- (note storage: customer permanent note vs. visit note (`txnNote`) — surfaced via existing
  `customer.upsert` + `queue.entryPatch`; edit points — TBD)
