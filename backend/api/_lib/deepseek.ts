import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger';

const SECRETS_PATH = path.join(os.homedir(), '.config/wte-feedback-agent/secrets.env');

function loadSecretsFile(): Record<string, string> {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

let fileSecrets: Record<string, string> | null = null;
function readSecret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (!fileSecrets) fileSecrets = loadSecretsFile();
  return fileSecrets[name];
}

export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = readSecret('DEEP_SEEK_API') ?? readSecret('DEEPSEEK_API_KEY');
    if (!apiKey) {
      throw new Error(
        `DEEP_SEEK_API not found. Set env var or add to ${SECRETS_PATH}.`,
      );
    }
    client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
  }
  return client;
}

/** Tolerant JSON extractor — strips fences / prose around a JSON value. */
export function parseJsonTolerant(raw: string): unknown {
  if (!raw) throw new Error('empty LLM response');
  let s = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    return JSON.parse(s);
  }
  const firstObj = s.indexOf('{'), lastObj = s.lastIndexOf('}');
  const firstArr = s.indexOf('['), lastArr = s.lastIndexOf(']');
  const candidates: string[] = [];
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(s.slice(firstObj, lastObj + 1));
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(s.slice(firstArr, lastArr + 1));
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error(`no parseable JSON in LLM response: ${raw.slice(0, 120)}…`);
}

const MAX_LLM_ATTEMPTS = 5;

export async function deepseekJson(
  systemInstruction: string,
  userPrompt: string,
  maxTokens = 1024,
): Promise<unknown> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await getClient().chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        // DeepSeek V4 defaults to thinking-on, which silently eats max_tokens.
        // Same chokepoint as feedback-agent/src/llm.ts.
        // @ts-expect-error — DeepSeek-specific extra; OpenAI SDK passes unknown fields through.
        thinking: { type: 'disabled' },
      });
      const content = res.choices[0]?.message?.content ?? '';
      return parseJsonTolerant(content);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const is429 = /\b429\b|rate[\s-]?limit|RESOURCE_EXHAUSTED|quota/i.test(msg);
      const is5xx = /\b5\d\d\b|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
      if ((!is429 && !is5xx) || attempt >= MAX_LLM_ATTEMPTS) throw e;
      const backoffMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      logger.warn('llm.retry', { attempt, backoffMs, msg: msg.slice(0, 200) });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
