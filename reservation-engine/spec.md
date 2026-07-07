# Mandos Reservation Engine — Data Model & Spec (v1)

The narrative decks describe *behaviour*. This file defines the **objects, states,
rules, permissions and policies** an engineer builds against. One rule of thumb
runs through everything: **there is no "bar system" and "club system" — there is a
Venue, a Schedule of Sessions, Tables, and Reservations. Mode is a property of a
Session, not of a venue.**

---

## 1. Core objects — the spine

```
Merchant ──owns──► Venue ──has──► Schedule ──contains──► Session
                     │                                      │
                     ├──owns──► Table ──published in──────► Session
                     │                                      │
Customer ──makes──► Reservation ──belongs to──────────────► Session
                                  └──assigned to──► Table (0..n)
                     Event ──is a special──► Session
                     Ticket / Deposit ──belong to──► Reservation
```

Belongs-to, stated plainly:

- A **Reservation** belongs to exactly one **Session** (and therefore one Venue + date).
- A **Session** belongs to one **Venue** and one date/day-of-week.
- A **Table** belongs to a **Venue** and is *published into* zero-or-more **Sessions**.
- An **Event** *is* a Session with `mode = event` (tickets + event tables).
- **Deposits / Tickets** belong to a **Reservation**.

This is the "one diagram that saves hundreds of questions."

---

## 2. Object definitions

**Venue** — `id, name, area, tags[] (Bar|Restaurant|Club|Lounge|Rooftop), openingHours, capabilities{regularBooking, eventBooking, tableManagement, deposits, approval}, accountType(Venue|Organiser)`. Tags **only** affect discovery/listing; behaviour comes from capabilities + sessions.

**Merchant** — the operator account. Type `Venue` or `Organiser` (an Organiser creates/runs events, possibly across venues).

**Schedule** — per venue, maps each date (or recurring day-of-week) to an ordered list of **Sessions**.

**Session** ⭐ (the object the old spec was missing) — a **time-block on a date with its own mode, inventory, rules and deposits**:
`id, venueId, date, start, end, mode(Regular|HappyHour|Event|Closed), publishedTableIds[], turnTime, buffer, depositPolicy, minSpendPolicy, capacity`.

**Table** — `id, venueId, name, category(Standard|VIP|Booth|Standing|PrivateRoom|HighTable), capacity, defaultDeposit, defaultMinSpend, status(published|hidden|blocked)`. Publish/deposit/min-spend can be **overridden per session** (a table can be Standard-priced at lunch and a VIP-deposit table at night).

**Reservation** — `id, ref, sessionId, customerId, tableIds[], guests, arrivalTime, duration, specialRequests, state, deposit, source(app|walk-in|enquiry|promoter)`.

**Ticket** (event sessions) — `id, reservationId, type, price, quantity, inventory`.

**Deposit** — `id, reservationId, amount, type(hold|request), state(none|held|requested|paid|captured|released|forfeited), expiry`.

**Customer** — `id, name, phone, email, tags(NightOwl…), history[]`.

---

## 3. Sessions — the concept in full

Every bookable moment lives inside a session. A day is a sequence of them:

```
FRIDAY 26 DEC
 Session 1   12:00–18:00   Regular      turn 1.5h · 24 tables · no deposit
 Session 2   19:00–22:00   Happy Hour   turn 2h   · 24 tables · no deposit
 (buffer)    22:00–23:00   —            regular closes; tables clear
 Session 3   23:00–04:00   Event        table-for-night · 12 published · deposit HK$1,000
```

**Priority / precedence.** When sessions would overlap (e.g. a Regular window running
into an Event start), the **higher-priority session wins its time** and the lower one
**auto-closes ahead of it by turn-time + buffer** so inventory clears. Precedence:
`Event > HappyHour > Regular`. A booking can never straddle a session boundary.

**Table membership.** A table is *published into* specific sessions. So a merchant can
publish all 24 tables for lunch but only 12 for the club night (the other 12 held for
walk-ins/VIPs/promoters). "Hide 50% of tables" = publish 12 of 24 into that session.

---

## 4. Reservation state machine

```
DRAFT ─► REQUESTED ─► PENDING ──(approve)──► CONFIRMED ─► CHECKED_IN ─► COMPLETED
  │           │           │                     │
  │           │           ├──(reject)──► REJECTED
  │           │           └──(deposit requested)──► AWAITING_DEPOSIT ─►(paid) CONFIRMED
  │           └──(abandon)──► DRAFT (discarded)
  └────────────────────────────► CANCELLED  (customer or merchant)
CONFIRMED / CHECKED_IN ─►(grace passes) NO_SHOW
Any hold not resolved in window ─► EXPIRED (deposit released)
```

- **Deposit is a hold, not a charge** — money moves only on capture (no-show/forfeit) or is released on reject/expire.
- **Inventory is committed on `CONFIRMED`** (accept), never on request → no double-booking.
- `CANCELLED` / `NO_SHOW` / `REJECTED` free the inventory immediately.
- Merchant can **force-cancel** (unreachable guest); it stays visible on the day for tracking.

---

## 5. Reservation engine — inputs & outputs

**Availability(session, party, time) is a pure function of:**
```
published tables in session      (inventory)
 + table capacity ≥ party
 + turn time (duration)
 + buffer (before & after)
 + session/opening hours
 − existing bookings (overlap, incl. buffer)
 − merchant blocks (blocked tables / dates / stop-sell)
 − higher-priority session windows (event auto-close)
```

**Overlap rule** (per table, per date):
`aStart < bStart + bDur + buffer  AND  bStart < aStart + aDur + buffer` → conflict.
(A club "table for the night" simply has `duration = until session close`, so one party
holds it the whole session — one-party-per-table-per-night falls out of the same rule.)

**Outputs** (per time / per session):
`AVAILABLE` · `LIMITED` (few tables left) · `FULLY_BOOKED` (→ alt times / dates / call) ·
`MANUAL_ENQUIRY` (party over threshold → merchant allocates) · `WAITLIST` (future, opt-in).

**Concurrency:** accept must be transactional (row-lock / unique constraint on
`tableId + overlapping window`) so two devices can't confirm the same table. Overbooking
and waitlists are explicit future features, never the default.

---

## 6. Permissions

**Merchant can:** Accept · Reject (reason) · Assign/Move table · Extend duration · Block tables/dates · Stop-sell · Force-cancel · Create manual/walk-in booking · Request deposit · Publish/hide tables · Create/edit Sessions · Create/edit Events · Log compensation · Check-in (scan).

**Customer can:** Book · Cancel · **Modify request** (date/time/guests → back to Pending) · Pay deposit · Add special requests · View status.

---

## 7. Policies (venue-configurable)

| Policy | Default |
|---|---|
| Booking window — Regular | 30 days ahead |
| Booking window — Club/Event | 7 days ahead |
| Free-cancellation window | until 24h before |
| Late cancel / no-show | deposit forfeited |
| Merchant-cancel | compensation logged per booking |
| Deposit **hold** expiry | released if not confirmed in ~3h |
| Deposit **request** expiry | link expires 24h before the booking |
| Check-in window | opens at session start |
| Late-arrival grace | 20 min, then table released |
| No-show | marked after grace; deposit captured |
| Minimum spend | per table / per session |

---

## 8. Table types

`Standard · VIP · Booth · Standing · Private Room · High Table` — each carries
`capacity, deposit, minimum spend, category`, and a **per-session** publish + price override.

---

## 9. Merchant dashboard modules

`Dashboard · Reservations · Calendar · Sessions · Tables · Events · Booking Control ·
Scanner · Settings (+ Policies)` today; `Customers (CRM)` and `Analytics` are Phase 4.

---

## 10. Why one engine (future-proofing)

Because every venue reduces to **Venue → Schedule → Session → Table → Reservation**, the
same engine extends without new booking systems:
`Restaurant → Bar → Club → Lounge → Hotel → Beach Club → Golf Club → Wine Tasting`.
Only the sessions, table types, and policies differ — the objects and the engine don't.
