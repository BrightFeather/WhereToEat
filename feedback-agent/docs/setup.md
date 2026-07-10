# Setup

One-time setup for running `feedback-agent` locally. Cloud setup is in
`cron.md`.

## Secrets locations (single source of truth)

| Secret | Path | Perms | What for |
|---|---|---|---|
| DeepSeek API key | `~/.config/wte-feedback-agent/secrets.env` | `600` (file), `700` (parent) | LLM calls (triage + edit + build-fix) |
| Gmail OAuth client (Desktop) | `feedback-agent/gmail-oauth-client.json` | `600` | Step 1 of OAuth — identifies the app |
| Gmail OAuth refresh token | `feedback-agent/gmail-token.json` | `600` | Created on first interactive run; long-lived |
| Google ADC (existing) | `~/.config/gcloud/application_default_credentials.json` | gcloud-managed | Fallback for any google-auth-library default path |

The DeepSeek key is **not** in `~/.keys` anymore. The old file was world-readable
(`-rw-r--r--`) and mixed concerns; the new path is dedicated, mode `600`, in a
mode `700` parent directory. The agent loads it via:

```ts
const env = fs.readFileSync(`${process.env.HOME}/.config/wte-feedback-agent/secrets.env`, 'utf8');
const key = env.match(/^DEEP_SEEK_API=(.+)$/m)?.[1];
```

with a `process.env.DEEP_SEEK_API` short-circuit so cloud runs (GitHub Actions
secrets) bypass the file entirely.

## Step-by-step

### 1. DeepSeek API key

Already done. Located at `~/.config/wte-feedback-agent/secrets.env`. To rotate:

```bash
# Get a new key from https://platform.deepseek.com → API Keys
echo 'DEEP_SEEK_API=sk-NEW_KEY_HERE' > ~/.config/wte-feedback-agent/secrets.env
chmod 600 ~/.config/wte-feedback-agent/secrets.env
```

Set a spend cap on the DeepSeek dashboard so a runaway loop can't drain you.

### 2. Gmail OAuth (Desktop client, Application Default Credentials)

Already partially done — the OAuth client JSON is at
`feedback-agent/gmail-oauth-client.json`. The interactive consent dance happens
on the agent's first run; it writes `feedback-agent/gmail-token.json` with the
refresh token. After that, the agent runs unattended.

If you ever need to redo the OAuth dance:

```bash
rm feedback-agent/gmail-token.json
npm run gmail:auth   # to be added in Phase 1; opens browser for consent
```

Scopes requested:

- `https://www.googleapis.com/auth/gmail.readonly` — read incoming feedback emails
- `https://www.googleapis.com/auth/gmail.labels` — create/apply the `wte/processed` label
- `https://www.googleapis.com/auth/gmail.modify` — apply labels to threads
- `https://www.googleapis.com/auth/gmail.send` — send daily summary email

### 3. GitHub auth

The agent shells out to local `gh` and `git`. Make sure:

```bash
gh auth status
# Logged in to github.com as <your-personal-account>
```

PRs will be authored by your personal GitHub account.

### 4. Verify

```bash
cd feedback-agent
npm install         # to be added in Phase 1
npm run doctor      # to be added in Phase 1: prints status of every secret + auth
```

## What's gitignored

Everything sensitive:

- `gmail-oauth-client.json`
- `gmail-token.json`
- `.env` / `.env.local`
- `node_modules/`, `dist/`, `build/`

`~/.config/wte-feedback-agent/secrets.env` lives outside the repo entirely, so
it can't be committed by accident.
