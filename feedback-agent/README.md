# feedback-agent

Daily pipeline that reads user feedback emails sent to `prompt.and.ship@gmail.com`
(via the in-app Resend feedback form), triages each one with an LLM, opens a
branch + PR with the proposed change, and emails a summary back to the same
inbox.

This is a separate project from the iOS app and the backend. It lives inside the
WhereToEat repo for convenience but has its own `package.json`, its own deploy
target, and its own secrets.

## Status

Phase 1–4 implemented. Verified end-to-end in dry-run on a real feedback email
("Change fire emoji to heart emoji") — agent located the right Swift files,
generated a minimal patch, and the iOS build passed with 0 retries in ~3.5 min
total. PR creation, build-fix retry loop, daily summary email, local launchd
cron, and GH Actions cron are all wired but **never fired with `apply: true`
yet**. The next step is a human-supervised first PR.

## Quick commands

```bash
npm run doctor                              # preflight check (secrets, OAuth, live ping)
npm run dry                                 # parse + triage all unprocessed emails
npm run run:dry -- --no-notify              # full pipeline, no edits/PRs/email
npm run once -- --thread-id=<id> --dry-run  # one thread, dry-run, prints JSON report
npm run once -- --thread-id=<id>            # one thread, live (opens PR, marks label)
npm run run                                 # full daily run (PRs + summary email)
```

## Read these in order

1. **`docs/architecture.md`** — what runs, where, in what order
2. **`docs/setup.md`** — secrets, OAuth, API keys, where everything lives
3. **`docs/cron.md`** — local cron now, GitHub Actions / Vercel cron later
4. **`docs/troubleshooting.md`** — common failures and how to recover

## Quick reference

| Thing | Where |
|---|---|
| DeepSeek API key | `~/.config/wte-feedback-agent/secrets.env` (`DEEP_SEEK_API=`) |
| Gmail OAuth client (Desktop type) | `feedback-agent/gmail-oauth-client.json` (gitignored) |
| Gmail OAuth refresh token | `feedback-agent/gmail-token.json` (created on first run, gitignored) |
| GitHub PRs | open via local `gh` CLI as your personal account |
| Daily summary recipient | `prompt.and.ship@gmail.com` |
| Cron time | 06:00 ET daily |
