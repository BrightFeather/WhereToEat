# feedback-agent — agent rules

This sub-project is its own thing. When working in `feedback-agent/`, treat it
as a standalone Node TypeScript project, not an extension of the iOS app or the
backend.

## What this is

Daily Gmail → triage → branch + PR pipeline. Reads in-app feedback emails from
`onboarding@resend.dev` to `prompt.and.ship@gmail.com`, classifies with
DeepSeek, opens branches and PRs against the parent `WhereToEat` repo, sends a
summary email back to the same inbox.

## Stack and conventions

- Node 20+, TypeScript, ESM, strict mode, `tsx` for dev (no separate build step)
- DeepSeek via OpenAI Node SDK with `baseURL` override
- `googleapis` + `google-auth-library` for Gmail
- `gh` and `git` shell-out via `execFile`
- All git ops happen in a temp `git worktree`, never the user's checkout

## Hard rules

- **Always include `thinking: { type: 'disabled' }` in DeepSeek requests.**
  V4 models default to thinking-on, which silently eats `max_tokens` on
  reasoning. Single chokepoint is `src/llm.ts`.
- **No PRs auto-merge.** Every PR opens for review. Even literal copy changes.
- **Diff cap: 5 files / 100 lines.** Over → draft PR + `needs-human` label.
- **Build retry cap: 5.** Over → draft PR + `needs-human` + failing build
  output in PR body.
- **Daily PR cap: 10.** Rest queued, marked `deferred` in summary.
- **Idempotency = Gmail label `wte/processed`.** Single source of truth.
- **Branch base = `main`.** Branch name = `feedback/<slug>-<msgid8>`.
- **Operate in temp `git worktree`,** never the user's checkout. The user's
  WIP on other branches is sacrosanct.
- **Daily summary goes only to `prompt.and.ship@gmail.com`.** No replies to
  end users.

## Where stuff lives

```
feedback-agent/
├── package.json, tsconfig.json
├── README.md, CLAUDE.md (this file)
├── docs/                    # architecture, setup, cron, troubleshooting
├── gmail-oauth-client.json  # Desktop OAuth client (gitignored)
├── gmail-token.json         # refresh token, written by `npm run gmail:auth` (gitignored)
├── scripts/                 # launchd plist for local cron
└── src/
    ├── config.ts            # secret loader + paths + tunables
    ├── llm.ts               # DeepSeek client; thinking disabled
    ├── gmail.ts             # OAuth (interactive + headless), list/read/label/send
    ├── parser.ts            # Resend email body → ParsedFeedback
    ├── triage.ts            # classifier
    ├── edit.ts              # search → file selection → edit (full file rewrites, no diffs)
    ├── builder.ts           # build verify per-area + retry-with-LLM-fix loop
    ├── repo.ts              # worktree, commit, push, gh pr
    ├── notify.ts            # daily summary email
    ├── orchestrator.ts      # per-email pipeline + per-day report
    └── cli/
        ├── doctor.ts        # preflight check
        ├── gmail-auth.ts    # one-time OAuth dance
        ├── dry.ts           # dry-run: list + parse + triage, no edits
        ├── once.ts          # process one thread end-to-end
        └── run.ts           # daily run
```

The DeepSeek key lives at `~/.config/wte-feedback-agent/secrets.env`
(file `600`, parent dir `700`). Cloud (GH Actions) reads from `$DEEP_SEEK_API`
env var instead — `src/config.ts` checks env first.

## Build verify

`src/builder.ts` picks an area based on changed files:

- `ios/**` or `WhereToEat/**` → `xcodebuild` (Debug, generic iOS Simulator
  destination, code signing off — same flags as the main project's CLAUDE.md
  documents)
- `backend/**` → `npx tsc --noEmit` in `backend/`
- `feedback-agent/**` → `npx tsc --noEmit` in `feedback-agent/`

Build runs on this Mac locally. In GH Actions, the workflow uses
`macos-latest` so xcodebuild is available.

## When changing this project

- Add new tunables to `src/config.ts`. Don't sprinkle constants across modules.
- New CLI commands go under `src/cli/<name>.ts` and get a script in
  `package.json`.
- Don't touch the parent app's source from here unless it's via the orchestrator
  + worktree path — same gates as the agent itself.
