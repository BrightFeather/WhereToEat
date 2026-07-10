# Architecture

## What it does

Once a day, this agent:

1. Reads new feedback emails sent to `prompt.and.ship@gmail.com` from
   `WhereToEat <onboarding@resend.dev>` (in-app Resend feedback form).
2. Parses each email body into structured fields.
3. Asks DeepSeek to triage: is this an actionable code change, a vague request,
   or noise?
4. For each actionable item:
   - Greps the WhereToEat codebase to locate the relevant file(s)
   - Generates a minimal patch
   - Builds + tests until green (capped at 5 retries)
   - Opens a branch off `main`, commits, pushes, opens a PR
5. Marks the Gmail thread with the `wte/processed` label so it's never
   reprocessed.
6. Sends a single summary email back to `prompt.and.ship@gmail.com` with all
   the day's feedback + PR links + status.

## Email format the agent expects

```
From: WhereToEat <onboarding@resend.dev>
Subject: <something>

User id: D5E5FCCF-...
Name: emily li
Reply-to: ...@privaterelay.appleid.com
App version: 1.1
Device: iPhone
iOS: 26.3.1

---

<free-form feedback text>
```

The body above the `---` is metadata; the body below is the user's actual
message. The parser is strict about the metadata block and lenient about the
free-form text.

## Triage classes

| Class | Action |
|---|---|
| `actionable_copy` | Literal copy/emoji/string change → branch + PR (still requires review) |
| `actionable_bug` | Bug report with clear repro → branch + investigation PR |
| `actionable_feature_small` | Small feature ≤5 files / ≤100 lines → branch + PR |
| `actionable_feature_large` | Bigger than the cap → draft PR with plan only, `needs-human` label |
| `vague` | "It's slow", "I don't like the home screen" → skip + flag in daily summary |
| `praise_or_noise` | "Love this app!" → skip silently |

## Build-until-green loop

After each edit:

1. For `ios/**` changes: `xcodebuild` against the iPhone simulator (the same
   command CLAUDE.md documents).
2. For `backend/**` changes: `npm run build` and `npm test` in `backend/`.
3. For `feedback-agent/**` self-changes: `npm run build` in this folder.

On failure: feed the compiler/test output back into DeepSeek, ask for a
correction, re-apply, re-build. Cap at **5 retries**. If still red:

- Push the WIP branch
- Open a **draft** PR
- Add `needs-human` label
- Include the failing build output in the PR body
- List it in the daily summary as `[BLOCKED]`

## Why local first

`xcodebuild` only runs on macOS. The iOS examples in the user's feedback (e.g.
"change fire emoji to heart") will need a real iOS build to verify. So the
agent runs on this Mac for now, called by `launchd` at 06:00 ET. Cloud version
(GH Actions on `macos-latest` or self-hosted Mac runner) is in `cron.md` as
Phase 4.

## Component map

```
src/
├── index.ts        // entrypoint: orchestrates all phases
├── gmail.ts        // OAuth + list/read/label/send
├── parser.ts       // Resend email body → structured feedback
├── triage.ts       // DeepSeek call: classify + propose change
├── repo.ts         // git/gh ops: branch, edit, commit, push, PR
├── builder.ts      // build/test loop until green
├── notify.ts       // daily summary email
├── llm.ts          // DeepSeek client (OpenAI-SDK-compatible)
└── state.ts        // idempotency: read/write Gmail labels
```

## Model strategy

Two DeepSeek models, picked per call type:

| Call type | Model | Why |
|---|---|---|
| Triage classifier | `deepseek-v4-flash` | Cheap; classification doesn't need deep reasoning |
| Edit proposer | `deepseek-v4-pro` (until 2026-05-31, then `flash`) | Code edits need reasoning; pro is on a 75% promo until end of May, after which we move everything to flash |
| Build-fix loop | `deepseek-v4-pro` (until 2026-05-31, then `flash`) | Reading compiler errors and writing fixes also benefits from reasoning |

The model strings are in one place (`src/llm.ts`) so the May 31 swap is a
two-line change, not a hunt-and-replace.

### Thinking mode is OFF by default

DeepSeek v4 models default to thinking-on. That silently burns `max_tokens`
on `reasoning_content` and returns empty `content` if the budget runs out.
Live test confirmed: a triage prompt with `max_tokens: 16` returned
`content: ""` because all 16 tokens were spent on reasoning.

**Every request from this agent includes** `thinking: { type: "disabled" }`.
The same triage prompt then returns `content: "actionable_feature_small"` in
6 completion tokens flat. Cheaper, faster, deterministic.

If a future call genuinely needs reasoning (e.g. a hard build-fix loop),
flip thinking back on locally and bump `max_tokens` to ≥1024 to leave
budget for both reasoning and answer. Don't toggle thinking globally.

### Param gotchas

- `thinking: false` → HTTP 400 "expected struct ThinkingOptions". Use
  `thinking: { type: "disabled" }` (or `{"type":"enabled"}`).
- `reasoning_effort: "minimal"` → HTTP 400. Valid values: `low | medium |
  high | max | xhigh`. Use `low` as the floor.

## Cost estimate

~30 emails/day, with ~5 actionable PRs/day:

- Triage (flash): ~$0.005/day
- Edit + build-fix (pro, on promo): ~$0.06/day
- After May 31, all on flash: ~$0.02/day

Under $2/month either way.

## Hard limits

- **Diff cap:** 5 files / 100 lines. Over → draft PR + `needs-human`.
- **Retry cap:** 5 build-fix retries. Over → draft PR + `needs-human`.
- **Daily PR cap:** 10 PRs. Over → queue the rest, list as "deferred" in the
  summary.
- **Token budget per email:** ~50K total across triage + edit + build. Hard
  abort if exceeded; list as `[BUDGET_EXCEEDED]`.
