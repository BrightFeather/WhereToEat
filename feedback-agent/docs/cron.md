# Cron — local now, cloud later

## Local (Phase 3) — installed and live

macOS `launchd` job at 06:00 America/New_York daily.

Plist source: `feedback-agent/scripts/com.weijia.wte-feedback-agent.plist`
Installed location: `~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist`

Plist behavior:

- Runs `cd /Users/chenweijia/Documents/code/WhereToEat/feedback-agent && npm run run`
- StandardOutPath / StandardErrorPath → `~/Library/Logs/wte-feedback-agent.log`
- StartCalendarInterval: hour=6, minute=0 (machine local time)
- PATH is hard-coded to `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` so
  `npm`, `git`, and `gh` resolve under launchd's stripped-down environment.
- `EnvironmentVariables` is **not** used to inject secrets — the agent reads
  them from `~/.config/wte-feedback-agent/secrets.env` directly.

If the laptop is asleep at 06:00 ET, the run skips. Acceptable for now.

## Install / uninstall

```bash
# Install (one-time)
mkdir -p ~/Library/Logs
cp feedback-agent/scripts/com.weijia.wte-feedback-agent.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist

# Uninstall
launchctl unload ~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist
rm ~/Library/LaunchAgents/com.weijia.wte-feedback-agent.plist
```

After editing the plist source, reinstall by re-copying and `launchctl unload`
+ `launchctl load -w` again — launchd caches the plist contents at load time.

## Operational commands

```bash
# Is it loaded?
launchctl list | grep wte-feedback
# Output format: "<pid|->  <last-exit-code>  com.weijia.wte-feedback-agent"
# `-` in the pid column means not currently running (normal between fires).

# Detailed status (shows next firing time, last exit code, paths)
launchctl print gui/$(id -u)/com.weijia.wte-feedback-agent

# Fire now, out of schedule (handy for smoke-testing)
launchctl start com.weijia.wte-feedback-agent

# Live log
tail -f ~/Library/Logs/wte-feedback-agent.log

# Find the next scheduled fire time
launchctl print gui/$(id -u)/com.weijia.wte-feedback-agent | grep -E "next firing|state"
```

## Expected log output

A normal run with no new feedback:

```
> wte-feedback-agent@0.1.0 run
> tsx src/cli/run.ts
feedback-agent run starting (apply=true, notify=true)
done. seen=0 prs=0 drafts=0 skipped=0 errors=0 tokens=0
summary email sent.
```

A run with new feedback:

```
done. seen=N prs=K drafts=M skipped=X errors=0 tokens=…
  [pr_opened] actionable_copy thread=… pr=https://github.com/.../pull/N
  ...
summary email sent.
```

## Known harmless warning

The log will start with two lines like:

```
/Users/chenweijia/.bash_profile: line 87: …google-cloud-sdk/path.bash.inc: Operation not permitted
/Users/chenweijia/.bash_profile: line 90: …google-cloud-sdk/completion.bash.inc: Operation not permitted
```

These come from `bash -lc` sourcing `.bash_profile` under launchd's sandbox,
which can't read files inside `~/Downloads/`. The agent doesn't use gcloud at
runtime — the warning is cosmetic. To silence permanently: move the
google-cloud-sdk out of `~/Downloads/` (e.g. to `~/.local/google-cloud-sdk/`)
and update the source paths in `.bash_profile`.

## Cloud (Phase 4)

Two pieces:

1. **GitHub Actions workflow** in `.github/workflows/feedback-agent.yml`
   triggered by `workflow_dispatch` (manual) and `schedule` (cron). Runs on
   `macos-latest` so `xcodebuild` is available. Mirrors the local script
   exactly, but reads secrets from GH Actions secrets:
   - `DEEP_SEEK_API`
   - `GMAIL_OAUTH_CLIENT_JSON` (full JSON contents)
   - `GMAIL_TOKEN_JSON` (full JSON contents — we copy the locally-generated
     one once)
   - `GH_TOKEN` (auto-provided to the workflow)

2. **Vercel cron** (optional) that pings `workflow_dispatch` via the GitHub
   REST API at 06:00 ET. Only useful if we want to trigger from outside GH
   Actions' own scheduler — for now, GH Actions `schedule:` cron is enough
   and we can drop the Vercel piece.

## Why macOS runner

iOS-changing PRs need `xcodebuild` to verify the build is green before opening
the PR. macOS runners cost ~$0.08/min. A typical run with 5 PRs and a couple
of build-fix retries should fit in ~10 min → ~$24/month. Acceptable.

If cost becomes a problem later: split the workflow into two jobs — a Linux
job that does Gmail + triage + non-iOS PRs, and a macOS job that only spins up
when iOS files are touched.

## Migration checklist (Phase 4)

- [ ] Add `.github/workflows/feedback-agent.yml`
- [ ] Add the four GH secrets above
- [ ] Test with `workflow_dispatch` (manual run)
- [ ] Once stable, disable the local launchd plist (don't delete — keep as
      fallback if the GH Actions scheduler misses)
- [ ] Document monitoring: where logs land, how to alert on failures
