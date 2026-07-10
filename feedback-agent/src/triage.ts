import { complete } from './llm.js';
import { config } from './config.js';
import type { ParsedFeedback } from './parser.js';

export type TriageClass =
  | 'actionable_copy'
  | 'actionable_bug'
  | 'actionable_feature_small'
  | 'actionable_feature_large'
  | 'vague'
  | 'praise_or_noise';

export interface TriageResult {
  klass: TriageClass;
  rationale: string;
  proposedTitle: string | null;
  rawResponse: string;
  usage: { promptTokens: number; completionTokens: number };
}

const SYSTEM_PROMPT = `You triage user feedback for an iOS app called WhereToEat.

Classify each piece of feedback into exactly one of these classes:
- actionable_copy: literal text/emoji/string change in the UI (e.g. "change fire emoji to heart")
- actionable_bug: clear bug report with a specific symptom (e.g. "the bookmark icon disappears after I tap it")
- actionable_feature_small: small feature ask, plausibly ≤5 files / ≤100 LOC (e.g. "add a sort by distance option")
- actionable_feature_large: bigger redesign or multi-screen feature
- vague: too unclear to act on (e.g. "the app is slow", "the home screen is bad")
- praise_or_noise: praise, thanks, off-topic, or empty

Reply with JSON only. No prose, no code fences. Schema:
{"klass":"...","rationale":"<≤120 chars>","proposed_title":"<≤60 chars or null>"}`;

export async function triage(feedback: ParsedFeedback): Promise<TriageResult> {
  const userPrompt = [
    feedback.appVersion ? `App version: ${feedback.appVersion}` : null,
    feedback.device ? `Device: ${feedback.device}` : null,
    feedback.iosVersion ? `iOS: ${feedback.iosVersion}` : null,
    '',
    'Feedback:',
    feedback.feedback || '(empty)',
  ]
    .filter((s) => s !== null)
    .join('\n');

  const result = await complete({
    model: config.models.triage,
    maxTokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const parsed = parseTriageJson(result.content);
  return {
    klass: parsed.klass,
    rationale: parsed.rationale,
    proposedTitle: parsed.proposedTitle,
    rawResponse: result.content,
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    },
  };
}

function parseTriageJson(raw: string): {
  klass: TriageClass;
  rationale: string;
  proposedTitle: string | null;
} {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return {
      klass: 'vague',
      rationale: `unparseable triage response: ${raw.slice(0, 80)}`,
      proposedTitle: null,
    };
  }
  const obj = json as Record<string, unknown>;
  const klassRaw = String(obj.klass ?? '').trim();
  const valid: ReadonlySet<TriageClass> = new Set([
    'actionable_copy',
    'actionable_bug',
    'actionable_feature_small',
    'actionable_feature_large',
    'vague',
    'praise_or_noise',
  ]);
  const klass = (valid.has(klassRaw as TriageClass)
    ? klassRaw
    : 'vague') as TriageClass;
  return {
    klass,
    rationale: String(obj.rationale ?? '').slice(0, 200),
    proposedTitle:
      typeof obj.proposed_title === 'string' && obj.proposed_title.length > 0
        ? obj.proposed_title.slice(0, 80)
        : null,
  };
}
