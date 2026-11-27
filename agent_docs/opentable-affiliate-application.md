# OpenTable partner / affiliate application: draft notes

Drafted 2026-11-26 for TASKS § BAY-BOOK-3. Goal: get OpenTable booking links for our restaurants (NYC + SF Bay Area) through a **sanctioned** source, replacing the broken `backend/scripts/backfill-opentable.ts` (BAY-BOOK-2). Scraping OpenTable is off the table: it breaks their terms, and their bot protection means it would also be detection evasion.

## Where to apply

| What | URL | Verified? |
|---|---|---|
| Partner application form | https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/ | Listed in search results; not opened (the portal blocks headless browsers, so open it yourself) |
| Partner portal + FAQ | https://dev.opentable.com/partner-portal/faqs | The page exists but renders client-side only; content not read |
| API docs | https://docs.opentable.com/ | Says API access requires registering and being **approved as an integration partner** |
| Brand assets (logos, "Reserve" buttons) | opentable.design (per the docs) | Not opened |

**Before submitting, confirm on the portal:** which tier fits ("affiliate" = restaurant data + booking deeplinks vs the contracted Partner API = availability + reservations), the exact attribution wording, and the data caching/retention rules.

## What we know (secondhand, so treat as approximate)

- Approval is **case by case**; reported review time is ~3–4 weeks.
- New affiliates reportedly start as **non-revenue** partners (no commission), which is fine for us.
- Linking requires following OpenTable's **brand guidelines**; affiliate links reportedly need **"Powered by OpenTable"** attribution.
- One directory claims the affiliate program runs through **Partnerize**. That conflicts with the portal route, so check before applying twice.

## Honest fit assessment

WhereToEat is a **personal app** (one user, distributed via TestFlight) with no public traffic. OpenTable approves partners case by case, and a non-commercial single-user app may simply be declined. Don't inflate numbers. If declined, the fallback is what's already shipped: Resy / Tock links where we have them, otherwise **"Book on website"** (WEB-BOOK-1), plus hand-added OpenTable links for the few restaurants that matter most.

## Draft answers for the form

Adjust to the form's actual fields. Everything in **[FILL IN]** is yours to supply.

**Applicant / company:** [FILL IN: legal name, or "independent developer"], [FILL IN: contact email], [FILL IN: country]

**Product name:** WhereToEat (iOS app, currently in TestFlight beta)

**Product description:**
> WhereToEat is an iOS restaurant-discovery app for New York City and the San Francisco Bay Area. Each week it surfaces restaurants that diners are recommending on social media, adds Google Places details (address, photos, rating), and lets the user swipe through picks and book a table. For restaurants on OpenTable, we want the "Book" button to send the user to that restaurant's OpenTable booking page.

**Do you want users to make reservations at OpenTable restaurants?** Yes, by **deep-linking** to the restaurant's OpenTable page or booking widget. We aren't asking for in-app reservation creation or real-time availability at this stage.

**What data do we need?** For ~850 restaurants (NYC ~700, Bay Area ~135, refreshed weekly as new picks arrive): whether the restaurant is on OpenTable, its **restaurant ID (rid)**, and the official booking / profile **deeplink**. Matching would be by name + address, or by whatever lookup the affiliate data feed provides.

**How will OpenTable be shown?** On the restaurant detail screen the primary button reads "Book this one" with an OpenTable badge. We'll add **"Powered by OpenTable"** attribution and use the official Reserve button assets per the brand guidelines. Booking happens on OpenTable's own page (in the in-app browser or the OpenTable app via Universal Links).

**Expected volume:** Small: a personal / beta app with [FILL IN: honest number, e.g. "1–5"] users and a handful of booking clicks per week.

**Data handling:** We store only the rid and the deeplink per restaurant (columns `opentable_rid` and `opentable_booking_url` already exist), refresh them weekly, don't resell or redistribute OpenTable data, and will delete it on request. No scraping of OpenTable pages.

**Technical contact / platform:** iOS (SwiftUI) + a Vercel serverless backend with Neon Postgres. [FILL IN: contact]

## If approved: integration plan

1. Swap `backfill-opentable.ts` (broken headed-autocomplete approach) for the affiliate data feed or lookup. Write `opentable_rid` + `opentable_booking_url` for `city IN ('nyc','bay')`, local SQLite first, then `scripts/sync-runs-to-neon.ts` / a targeted Neon update.
2. Add "Powered by OpenTable" attribution next to the Book button when `reservationSource == .opentable` (`RestaurantDetailView.primaryActions`).
3. Re-check the "Only show bookable" filter numbers per city (Bay today: 23 / 133).
4. Record the program terms (attribution text, caching limits) in `backend/CLAUDE.md`.
