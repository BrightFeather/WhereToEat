# Troubleshooting

Common failures and how to recover.

## Gmail

**"invalid_grant" on first run** — the OAuth client at
`feedback-agent/gmail-oauth-client.json` doesn't match the project that the
saved refresh token came from. Fix:

```bash
rm feedback-agent/gmail-token.json
npm run gmail:auth
```

**Refresh token expired** — Google expires unused refresh tokens after 6
months for consumer Gmail. Same fix as above.

**`disabled_client` (HTTP 401) from `oauth2.googleapis.com/token`** —
distinct from `invalid_grant`: the OAuth client itself was disabled or
deleted in GCP Console, not just the token. `npm run gmail:auth` will NOT
fix this because the dance uses the same disabled client.

Recovery:

1. Open https://console.cloud.google.com/apis/credentials?project=feedback-agent-495003
2. Find the Desktop OAuth client `839457217032-...`. Two paths:
   - **Re-enable:** click the client → if Status shows Disabled, toggle it
     back on. (Google sometimes only surfaces this on certain failure modes.)
   - **Recreate:** if it's gone or stuck, "+ Create Credentials → OAuth
     client ID → Application type: Desktop app". Download the JSON,
     replace `feedback-agent/gmail-oauth-client.json` with it.
3. Confirm `prompt.and.ship@gmail.com` is still listed under
   https://console.cloud.google.com/auth/audience?project=feedback-agent-495003
   → Test users.
4. `rm feedback-agent/gmail-token.json && npm run gmail:auth` to redo the
   consent dance against the working client.

**The cron will silently fail** when the client is disabled — exit code 1,
no PRs, the daily summary email never gets sent. Detection: if no
`[wte-feedback]` summary lands in the inbox by ~06:30 ET, run
`tail ~/Library/Logs/wte-feedback-agent.log` and look for `disabled_client`.

**Label `wte/processed` doesn't exist** — the agent creates it on first run.
If somehow missing, the next run re-creates it; old emails won't be
re-processed because the dedup key is "label applied OR thread id seen
before in `state.ts`'s persistent log".

## DeepSeek

**`401 Unauthorized`** — key not loaded. Check:

```bash
test -r ~/.config/wte-feedback-agent/secrets.env && grep -c DEEP_SEEK_API ~/.config/wte-feedback-agent/secrets.env
```

Should print `1`.

**`429 Too Many Requests`** — DeepSeek's per-key RPM limit. Agent will
back off and retry; if it persists, lower the `--concurrency` flag or split
the day's emails across two runs.

**Model name not recognized** — DeepSeek deprecates models. Check the model
name in `src/llm.ts` matches what's listed at https://api-docs.deepseek.com/
under "Models & Pricing".

## Build loop

**5 retries exhausted** — agent already pushed a draft PR with
`needs-human`. Pull the branch, fix manually, push, mark ready for review.

**`xcodebuild` failed with code-signing error** — feedback-agent doesn't
need to sign; it just needs to compile. Make sure the build invocation uses
`CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO` (same flag set the main
CLAUDE.md documents).

**Wrong file edited** — triage misidentified the target file. Open the PR
on GitHub, leave a review comment with the correct path, mark
`needs-human`. Future improvement: feed PR comments back into the triage
prompt as negative examples.

## PRs

**`gh: command not found`** — install with `brew install gh`, then
`gh auth login`.

**PR opened against wrong base** — check `repo.ts` always passes
`--base main`. If a PR ends up on the wrong base, close it and the daily
re-run won't re-create (label is already applied) — manually re-run the
agent for that one thread by removing the label.

## Git worktree

**"is already checked out"** — a previous run's worktree wasn't cleaned up.
Recover:

```bash
cd /Users/chenweijia/Documents/code/WhereToEat
ls /var/folders/**/wte-fb-* 2>/dev/null    # find the orphaned dir
rm -rf /var/folders/.../wte-fb-XXXXXX
git worktree prune
git branch -D feedback/<the-orphan>
```

The agent's own `cleanup()` already does this, but a hard kill (Ctrl-C
during `xcodebuild`) can skip it.

**Stale `/usr/local/bin/git` masks the system git** — if `git --version`
shows anything older than 2.17, `git worktree remove` won't exist and other
tools will misbehave. Fix:

```bash
ls -la /usr/local/bin/git           # check the symlink target
brew install git                     # if you want a modern brew git
# or, if /usr/local/bin/git is from an old manual install:
sudo rm /usr/local/bin/git           # let the system /usr/bin/git win
```

The agent itself works around this (uses `worktree prune` instead of
`worktree remove`), but other tools may not be as forgiving.

## launchd / cron

**Log starts with `Operation not permitted` on `.bash_profile` lines** —
launchd's sandbox can't read files inside `~/Downloads/`. The user's
`.bash_profile` sources `google-cloud-sdk/path.bash.inc` from there, so
`bash -lc` complains under cron but keeps going. Cosmetic, not a real error.
Silence by moving the SDK out of `~/Downloads/`.

**`launchctl list | grep wte-feedback` shows pid `-` and exit code `0`** —
this is the steady state between fires. The job ran successfully and is now
waiting for the next 06:00 ET trigger. Pid `-` while exit code `1` or higher
is the "ran and failed" state.

**Plist edits don't take effect** — launchd caches the plist contents at
load time. After editing `feedback-agent/scripts/com.weijia.wte-feedback-agent.plist`,
re-copy it and reload:

```bash
cp feedback-agent/scripts/com.weijia.wte-feedback-agent.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist
launchctl load -w ~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist
```

**Manual fire to smoke-test** — `launchctl start com.weijia.wte-feedback-agent`
runs the job out of schedule. Use this after re-enabling Gmail OAuth or
after editing the plist.

**The job ran but no summary email arrived** — most likely cause is a
crashed Gmail send. Check `~/Library/Logs/wte-feedback-agent.log` for the
exit code line; non-zero means the run failed. The agent currently has no
fallback notification path (Slack, file-touch, etc.) — adding one is
backlog if the daily email proves unreliable.

## Daily summary

**Summary email never arrived** — Gmail send scope wasn't granted in the
OAuth dance. Re-run `npm run gmail:auth` and approve all four scopes.

**Summary email shows zero items but you know there were emails** — likely
all emails were classified as `praise_or_noise` and skipped silently.
Pass `--include-noise` to see them in the summary.
