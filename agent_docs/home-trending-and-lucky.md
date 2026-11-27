# Home: Trending now + I'm feeling lucky (design)

Status: **design, not built** (2026-11-27). Decisions marked ✅ are proposed defaults; the open questions are at the end.

## Goals

1. **Trending now**: surface restaurants from the most recent *popular* posts, so Home has something that changes faster than the weekly picks.
2. **I'm feeling lucky**: one tap → one restaurant that fits what the user likes to eat and where they are. No swiping or filtering.

Both run entirely on the client from the `/weekly` payload already on the device. `sources[]` carries `likes` and `postCreatedAt` per post, and rows carry `latitude`/`longitude`. **No backend change, no new endpoint** (the Hobby 12-route cap doesn't matter).

## Home layout (top → bottom)

```
Good morning
No upcoming reservations yet.
[upcoming reservation cards, if any]

This week's picks            ← unchanged (3 slots / 1 with a booking)
  TOP PICK · NEW THIS WEEK · HIDDEN GEM

Trending now 🔥              ← NEW: horizontal rail, 6–8 cards
  [photo] [photo] [photo] →
  Name · 2.3k likes · 4d ago

🍽 N picks   📍 N saved

🎲 I'm feeling lucky          ← NEW: last thing on Home
```

**Removed (user, 2026-11-27):** the "Swipe through all N picks →" gradient button (`findAnotherRestaurantButton`). The deck stays one tap away through the Pick tab and the `🍽 N picks` stat, which already posts `.switchToPick`.

**Lucky at the bottom (user, 2026-11-27):** picks and Trending are what you browse; Lucky is the "still can't decide" exit at the end of the page. Trending is a rail (about 200 pt), so Home stays roughly one and a half screens.

## 1. Trending now

### Data (prod, 2026-11-27)

| City | XHS posts < 30 d | < 60 d | Restaurants with a post < 60 d |
|---|---|---|---|
| nyc | 46 | 69 | 63 |
| bay | 27 | 44 | 44 |

So there's enough for a rail of 6–8 in both cities. Two traps showed up in the data:

- **Roundup posts.** One 326-like Bay post lists 7 Italian restaurants. Ranked naively, the whole rail would be Italian from one post.
- **Viral outliers.** One NYC post has 90,300 likes vs a typical 300–1,200. Raw likes would pin it at #1 forever.

### Ranking ✅

For each 小红书 source with `postCreatedAt` within the window:

```
postScore = log10(1 + likes) × 0.5^(ageDays / 14) / sqrt(restaurantsInPost)
restaurantScore = max(postScore over its sources)
```

- `log10` tames outliers (90k likes ≈ 5.0 vs 1k ≈ 3.0).
- A 14-day half-life makes a 2-week-old post worth half of today's.
- `restaurantsInPost` = how many deck restaurants share that `postUrl`. A 7-restaurant roundup gives each one 1/√7 ≈ 0.38 of the weight.
- **Window:** 30 days, widened to 60 and then 90 if fewer than 4 restaurants qualify. If there are still fewer than 4, the section is hidden.
- **Diversity:** at most 2 restaurants per cuisine in the rail, and at most 1 per post.

### Filters ✅

The rail uses the same filter set as This week's picks: reserved, blocked, seen-today, swiped this week, the source toggles, show-only-reservable, and has a working photo (`verifyPickPhotos` guard). Restaurants already in This week's picks are excluded. Seen-today is **not** applied to the rail after first render, so a card the user opens doesn't vanish mid-scroll. Same "sticky" idea as TOP PICK.

### Card ✅

160 × 210 photo card: name, neighborhood, then a heat line `🔥 2.3k · 4d ago` (likes of the winning post, age of that post). Tap → `RestaurantDetailView`, same as a pick. No booking badge (keeps it compact); the detail view has the CTA.

## 2. I'm feeling lucky

### Flow ✅

1. **Card on Home** (visual pass, 2026-11-27, Option A recommended):
   - Deep indigo card (~150 pt tall, 20 pt corners) so it stands out from the cream page; the only dark surface on Home.
   - Right side: a fan of three tilted photo cards (real thumbnails from the candidate pool, the front one face-down with a "?").
   - Left: small caption "I'm feeling lucky", big title "Can't decide?", then two input chips: cuisine (`Japanese`) and place (`Near you` / `Manhattan`). Each chip opens the craving sheet at that section, replacing the separate "Change" link.
   - Amber pill button "🎲 Roll the dice" + "3 rolls left today". Tapping the button (or anywhere on the card outside the chips) rolls immediately.
   - The fan shuffles in place for the first ~0.6 s (photos swap and jiggle), then the full-screen result takes over.
   - Option B (alternative): a light amber "scratch-off ticket" with a dashed border, a dice tile that flips to the result photo, and a "Reveal my spot" button. Calmer, but blends in with the cream page.
2. **Roll animation** (~1.2 s): a full-screen cover shuffles 5–6 candidate photos like a slot machine, slowing down, then lands. Light haptic on each tick, success haptic on land.
3. **Result card**: big photo, name, `Japanese · East Village · 0.6 mi`, rating, top quote, and **Book this one** (opens the existing detail / booking flow) plus **Roll again** (max 2 re-rolls per day; on the 3rd tap: "That's your lucky three for today — swipe the deck for more").

### Cuisine input ✅ (inferred, overridable)

There is no saved cuisine preference today (`UserProfile` has dietary tags only). Infer one from what the user already did, newest-weighted:

| Signal | Weight |
|---|---|
| Confirmed reservation | 3 |
| Saved to My List / bookmark | 2 |
| Liked swipe (right) this month | 1 |

Take the top cuisine (normalized via `normalizedCuisine`, so `Japanese` = `japanese`). If there are fewer than 2 signals in total, use **Anything**. The craving sheet ("What are you craving?") shows the city's cuisines as chips with the inferred one pre-selected, plus "Anything". A manual pick is remembered for the day.

### Location input ✅

- **Near me** (default when GPS is inside the selected city): radius starts at 1 mi in NYC / 3 mi in the Bay, widens ×2 up to 3 times until there are at least 3 candidates, then falls back to the whole city. Distance is shown on the result.
- **GPS outside the city / denied**: use the borough/region chip on the sheet (default: the most common region in the user's history, else the whole city).
- Rows without coordinates are only candidates in the whole-city fallback.

### Picking ✅

Candidates = the This-week filter set ∩ cuisine ∩ location ∩ working photo, excluding restaurants already rolled today. Pick a **weighted random** restaurant, weight = `rankWeight × ratingWeight × (bookable ? 1.5 : 1)`. Rank comes from deck order, and rating is a Google rating of 4.5 or more ×1.3, under 4.0 ×0.6. Lucky should feel random but never bad. Seeded per roll (not per day), so re-roll gives something new.

If nothing matches the cuisine: "No Thai spots near you — here's the closest thing", widening location first, then dropping cuisine.

## Implementation sketch (for after approval)

- `HomeViewModel`: `trendingPicks: [TrendingPick]` (computed like `homePicks`), `luckyInputs`, `rollLucky() -> WeeklyRestaurant?`, `luckyRollsToday` in UserDefaults keyed by date and user.
- New views under `Views/Home/`: `TrendingRail.swift`, `LuckyCard.swift`, `LuckyRollView.swift` (full-screen cover), `CravingSheet.swift`. pbxproj IDs in `5FBAD0*`.
- `LocationService` already exposes the fix; distance via `CLLocation.distance(from:)`.
- No backend change. `SPEC.md § Home` gets two new subsections when built.

## Open questions

1. **Trending format**: horizontal rail (proposed), or vertical cards exactly like This week's picks (3 cards, taller page)?
2. **Lucky "one shot"**: 1 roll + 2 re-rolls per day (proposed), unlimited, or literally one per day?
3. **Lucky cuisine**: inferred from history with a sheet to change it (proposed), or ask every time?
4. **Trending window**: 30 days widening to 90 (proposed). The ingest is only as fresh as the last browser ingest run; if ingest stalls for a month the rail quietly hides.
