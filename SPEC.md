# WhereToEat — iOS App Spec (v3, Final)

## Overview

A weekly-cadence restaurant discovery and reservation iOS app. Every Monday at 6pm it curates a swipeable list of restaurants for the upcoming weekend, handles reservations end-to-end with native payment, and sends day-before reminders.

---

## Onboarding (One-time)

| Field | Type | Notes |
|---|---|---|
| Dietary preferences | Structured multi-select | Ask once, stored permanently |
| Default party size | Int | 1–10+ |
| Default payment method | Apple Pay / card | Used for deposits |
| Notification permission | System prompt | Required for triggers |
| Location permission | Always-on | Daily ambient location |

**Dietary preference options:**
No restrictions · Vegetarian · Vegan · Halal · Kosher · Gluten-free · Dairy-free · Nut-free · No shellfish · No pork

**Cuisine preferences** — set weekly (part of Monday flow before cards load):
French · Italian · Japanese · Chinese · Korean · Mexican · American · Mediterranean · Thai · Indian · Vietnamese · Spanish · Middle Eastern · Peruvian · Other

---

## Location Configuration

- **Default:** device's current location (CoreLocation significant-change, updated daily)
- **Override:** user pins a specific city in Settings → persists until cleared
- **Eater city:** auto-resolved from current location or city override (no separate config)
- Active override shown as banner in-app: *"Showing restaurants in New York, NY"*

---

## Weekly Trigger Schedule

| Day | Time | Action |
|---|---|---|
| Monday | 6pm | Push: "Pick your weekend restaurants" |
| Tuesday | 6pm | Re-notify if Task 1 incomplete |
| Wednesday | 6pm | Re-notify if Task 1 still incomplete |
| Thursday+ | — | No more triggers this week |

**Skip this week:** available on notification and in-app banner — suppresses further triggers until next Monday.

**Resume anytime:** home screen always shows "Pick this weekend's restaurants" Mon–Sun, allowing the user to start or continue Task 1 at any time.

---

## Custom Restaurant List

### Input methods

**1. Share sheet (from other apps):**
User shares a link from Maps, Yelp, Xiaohongshu, Safari, etc. → WhereToEat appears as a share destination → import flow opens automatically.

**2. Paste-a-link (in-app):**
"+" button → "Add restaurant" → paste any URL → app detects source and parses.

**3. Website links (generic):**
Any URL that isn't a recognized platform → app extracts restaurant name, address, and description via Open Graph tags + HTML heuristics → user confirms or edits before saving.

### Supported sources & parsed data

| Source | Detected by | Parsed fields |
|---|---|---|
| Google Maps | `maps.app.goo.gl`, `goo.gl/maps`, `maps.google.com` | Name, address, coordinates, photos, rating, hours |
| Yelp | `yelp.com/biz/` | Name, address, rating, cuisine tags, photos |
| Xiaohongshu | `xiaohongshu.com`, `xhslink.com` | Name (from post), address (if mentioned), post content + photos |
| Generic website | Any other URL | Name, address (OG/schema.org), description, hero image |

Multiple source links can be attached to the same restaurant (e.g. Google Maps + Xiaohongshu review post). On add, WhereToEat checks for an existing restaurant by name + coordinates and offers to merge rather than duplicate.

### Storage schema

```
CustomRestaurant
  - id: UUID
  - name: String
  - address: String?
  - coordinates: CLLocationCoordinate2D?
  - cuisineTags: [CuisineTag]
  - dietaryTags: [DietaryTag]
  - priceRange: 1...4?
  - photos: [URL]
  - rating: Double?
  - hours: [DayHours]?
  - sourceLinks: [SourceLink]      // all original links preserved
  - notes: String?                 // user's personal notes
  - addedAt: Date
  - lastUpdated: Date

SourceLink
  - platform: google | yelp | xiaohongshu | website | other
  - url: URL
  - rawContent: String?            // snapshot at import time
```

---

## Task 1 — Discovery

### Step 0 — Weekly cuisine prompt
Before cards load: "What are you feeling this weekend?" → multi-select cuisine tags → "Show restaurants"

### Restaurant sources

| Source | Method | Notes |
|---|---|---|
| Custom list | Local DB | Always included; not filtered by cuisine unless user opts in |
| Yelp | Yelp Fusion search API | Filter by location, cuisine, dietary tags |
| Xiaohongshu | Scrape location-tagged food posts | Best-effort; parsed asynchronously |
| Eater | RSS + HTML scrape for detected city | "Best new restaurants", "Where to eat now" lists |
| Generic website | User-added links | Already in custom list |

**Deduplication:** fuzzy name match + distance < 50m → merge into one card, union of all source links.

**Ranking:**
1. Custom list restaurants (always surfaced first)
2. Popularity signal from Yelp rating × review count
3. Xiaohongshu post engagement (likes/saves) where available
4. Eater editorial recency

### Card enrichment (per restaurant)

| Data | Source |
|---|---|
| Name, address, hours, coordinates | Google Places API |
| Photos | Google Places + Yelp Fusion |
| Rating + review snippets | Google Places + Yelp Fusion |
| Xiaohongshu post excerpts | Scraped posts referencing this restaurant |
| Reservation availability badge | Resy → OpenTable → Tock (first hit wins) |
| Dietary / cuisine match indicator | Matched against user profile |

### Card UI

- **Card face:** hero photo, name, cuisine tags, neighborhood, price range, dietary match indicator, reservation platform badge
- **Expanded (tap):** photo carousel, map pin, full address + hours, rating summary, 3 review snippets (source-labeled), Xiaohongshu excerpts, all source links
- **Swipe right** → liked → go to Task 2
- **Swipe left** → disliked → next card; restaurant resurfaces next week by default
- **Long-press on card / button in expanded view** → "Block for 4 weeks" → restaurant hidden until that date
- **Deck exhausted** → "No more restaurants. Expand radius?" or shortcut to add custom restaurant

### Swipe history rules

| Action | Effect |
|---|---|
| Swipe left (dislike) | Hidden this week; reappears next week |
| Block | Hidden for 4 weeks from block date |
| Swipe right (like) → booked | Hidden for 4 weeks post-booking |
| Swipe right (like) → not booked | Reappears at top of deck next week |

---

## Task 2 — Reservation

### Flow

1. **Availability screen** — slots for Fri/Sat/Sun (default), filtered by default party size
   - User can adjust date range and party size inline
   - Time chips grouped by day
2. **Select slot** → confirmation screen:
   - Restaurant, date, time, party size
   - Deposit info if required: amount + refund policy
3. **Deposit payment (if required):**
   - Native Apple Pay sheet (primary)
   - Saved card via Stripe (fallback)
   - Must confirm before reservation is finalized
4. **Confirmed** → confirmation screen with:
   - Confirmation code
   - "Add to Calendar" (EventKit)
   - Reminder auto-scheduled (Task 3)

### Fallback paths

| Scenario | Behavior |
|---|---|
| No slots available | Message + "Back to restaurants" (Task 1) |
| User backs out | Return to card stack; restaurant marked *skipped* (not disliked, resurfaces next week) |
| No reservation API | Show phone + website; offer "Open in Maps" |
| Payment fails | Retry prompt → web handoff fallback |

---

## Task 3 — Reminder

- **Trigger:** local push notification 24 hours before reservation time
- **Content:** "[Restaurant] tomorrow at [time] — [party size] people · [neighborhood]"
- **Actions:**
  - "Directions" → Apple Maps
  - "View Booking" → in-app confirmation screen
  - "Cancel" → API cancellation if supported; otherwise shows cancellation policy + contact info

---

## Technical Architecture

### iOS App Stack
- **Language:** Swift
- **UI:** SwiftUI
- **Local storage:** Core Data
- **Networking:** async/await + URLSession
- **Scraping:** SwiftSoup (HTML parsing) + WKWebView for JS-rendered pages
- **Notifications:** UserNotifications (local scheduled)
- **Location:** CoreLocation (significant-change mode)
- **Payments:** PassKit (Apple Pay) + Stripe iOS SDK
- **Calendar:** EventKit

### Backend (Vercel)
Serverless functions (TypeScript / Node.js) handling:
- Stripe PaymentIntent creation (deposit flows)
- Resy and Tock API proxying (auth tokens server-side only)
- Xiaohongshu scraping jobs (server-side to avoid device IP blocks)
- Eater scraping jobs (cron or on-demand)

```
/api
  /stripe/create-payment-intent
  /reservations/resy/search
  /reservations/resy/book
  /reservations/opentable/search
  /reservations/opentable/book
  /reservations/tock/search
  /reservations/tock/book
  /scrape/xiaohongshu
  /scrape/eater
  /places/enrich          // Google Places + Yelp proxied calls
```

### External APIs

| API | Purpose | Access model |
|---|---|---|
| Google Places API | Enrichment: name, photos, hours, reviews | Public, paid |
| Yelp Fusion API | Discovery + reviews, ratings, photos | Public, free tier (500 req/day) |
| Resy | Availability + booking | Reverse-engineered mobile API, proxied via Vercel |
| OpenTable | Availability + booking | Public partner API |
| Tock | Availability + booking | Reverse-engineered, proxied via Vercel |
| Stripe | Deposit payment processing | SDK (iOS) + secret key on Vercel only |
| Xiaohongshu | Discovery + reviews | Scraping via Vercel (server-side) |
| Eater | Discovery | RSS + HTML scrape via Vercel |

---

## Full Data Model

```swift
// User
UserProfile
  - dietaryPreferences: [DietaryTag]   // set once
  - defaultPartySize: Int
  - locationOverride: City?            // nil = device location

// Location
DailyLocation
  - date: Date
  - coordinates: CLLocationCoordinate2D
  - resolvedCity: String

// Restaurant (unified)
Restaurant
  - id: UUID
  - name: String
  - address: String
  - coordinates: CLLocationCoordinate2D
  - cuisineTags: [CuisineTag]
  - dietaryTags: [DietaryTag]
  - priceRange: 1...4
  - photos: [URL]
  - rating: Double?
  - reviewSnippets: [Review]
  - hours: [DayHours]
  - sourceLinks: [SourceLink]
  - reservationSource: ReservationSource?
  - isCustom: Bool
  - notes: String?
  - enrichedAt: Date?

Review
  - platform: google | yelp | xiaohongshu
  - text: String
  - rating: Double?
  - date: Date?

SourceLink
  - platform: google | yelp | xiaohongshu | eater | website | other
  - url: URL
  - rawContent: String?

ReservationSource
  - platform: resy | opentable | tock | other
  - venueId: String
  - directBookingURL: URL?

// Weekly session
WeeklySession
  - weekOf: Date                       // Monday date
  - cuisinePreferences: [CuisineTag]   // set this week
  - status: pending | inProgress | completed | skipped
  - triggersSent: [Date]
  - swipedCards: [SwipeRecord]
  - reservations: [Reservation]

SwipeRecord
  - restaurantId: UUID
  - decision: liked | disliked | skipped | blocked
  - blockedUntil: Date?                // set when decision == .blocked
  - timestamp: Date

// Reservation
Reservation
  - id: UUID
  - restaurantId: UUID
  - datetime: Date
  - partySize: Int
  - confirmationCode: String
  - platform: resy | opentable | tock | other
  - depositAmount: Decimal?
  - depositPaid: Bool
  - stripePaymentIntentId: String?
  - reminderNotificationId: String
  - calendarEventId: String?
  - status: confirmed | cancelled
```

---

## Phased Rollout

### Phase 1 — Full Core Loop
- Onboarding (dietary, party size, Apple Pay)
- Location + city override
- Weekly cuisine prompt + trigger schedule (Mon/Tue/Wed 6pm, skip, resume)
- Yelp discovery (API) + Eater scraping + custom list
- Card UI with enrichment (Google Places + Yelp)
- Swipe left/right + Block for 4 weeks
- Custom list: paste-link + share sheet + website link import
- Reservation via Resy/OpenTable (native API or WebView fallback per platform)
- Native deposit payment (Apple Pay + Stripe via Vercel)
- Day-before reminder notification
- Calendar integration

### Phase 2 — Richer Discovery
- Xiaohongshu scraping (server-side via Vercel, stabilized)
- Cross-source deduplication improvements
- Swipe history-based ranking

### Phase 3 — Reliability & Polish
- Cancellation flow via API (Resy, OpenTable)
- Waitlist support (Resy)
- Tock native booking
- Expanded dietary/cuisine intelligence
