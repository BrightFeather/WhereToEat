import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRETS_PATH = path.join(os.homedir(), '.config/wte-feedback-agent/secrets.env');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export const paths = {
  repoRoot: REPO_ROOT,
  oauthClient: path.join(REPO_ROOT, 'gmail-oauth-client.json'),
  oauthToken: path.join(REPO_ROOT, 'gmail-token.json'),
  secretsEnv: SECRETS_PATH,
} as const;

function loadSecretsFile(): Record<string, string> {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const fileSecrets = loadSecretsFile();

function readSecret(name: string): string | undefined {
  return process.env[name] ?? fileSecrets[name];
}

export function requireSecret(name: string): string {
  const v = readSecret(name);
  if (!v) {
    throw new Error(
      `Missing secret ${name}. Set it as env var or in ${SECRETS_PATH}.`,
    );
  }
  return v;
}

export const config = {
  feedbackSender: 'onboarding@resend.dev',
  processedLabelName: 'wte/processed',
  summaryRecipient: 'prompt.and.ship@gmail.com',
  models: {
    triage: 'deepseek-v4-flash',
    edit: 'deepseek-v4-pro',
    buildFix: 'deepseek-v4-pro',
  },
  deepseekBaseUrl: 'https://api.deepseek.com',
  diffCap: { files: 5, lines: 100 },
  retryCap: 5,
  dailyPrCap: 10,
} as const;

export { readSecret };
