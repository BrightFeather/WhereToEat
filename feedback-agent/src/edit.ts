import fs from 'node:fs';
import path from 'node:path';
import { complete } from './llm.js';
import { config } from './config.js';
import { run, type Worktree } from './repo.js';
import type { ParsedFeedback } from './parser.js';
import type { TriageResult } from './triage.js';

interface SearchPlan {
  searches: Array<{ pattern: string; rationale: string }>;
  initial_thoughts: string;
}

interface EditProposal {
  plan: string;
  files: Array<{ path: string; new_content: string; reason: string }>;
}

export interface EditOutcome {
  applied: boolean;
  reason?: string;
  files: string[];
  proposal: EditProposal | null;
  searchPlan: SearchPlan | null;
}

const SEARCH_PROMPT = `You are helping locate the right files in an iOS+TypeScript codebase to address a piece of user feedback.

Given the feedback, propose 3-7 grep patterns that would surface the most relevant code locations. Patterns should be specific enough to avoid hundreds of false matches.

Codebase notes:
- iOS app: Swift, SwiftUI views under ios/WhereToEat/Views/, view models under ViewModels/, models under Models/
- Backend: TypeScript in backend/api/
- Emoji literals appear directly in Swift strings (e.g. "🔥") — search for the literal character itself

Reply with JSON only. No prose, no code fences. Schema:
{"initial_thoughts":"<≤200 chars>","searches":[{"pattern":"<grep regex>","rationale":"<≤80 chars>"}]}`;

const EDIT_PROMPT = `You are an autonomous coding agent. Given user feedback and the contents of relevant files, produce a minimal edit.

Hard limits:
- Touch at most ${config.diffCap.files} files
- Total changed lines must not exceed ${config.diffCap.lines}
- For literal copy/emoji changes, the smallest possible change wins
- Keep all unchanged content byte-for-byte identical

Output FULL replacement file contents for every file you modify. Do NOT emit a diff. Do NOT abbreviate ("// ... rest unchanged" is forbidden).

Reply with JSON only. No prose, no code fences. Schema:
{
  "plan": "<2-5 sentence plan of what you're changing and why>",
  "files": [
    {
      "path": "<repo-relative path>",
      "reason": "<≤120 chars on why this file>",
      "new_content": "<entire new file contents>"
    }
  ]
}

If you cannot confidently make a minimal change with the files provided, return {"plan":"...", "files":[]} and explain in the plan.`;

export async function proposeAndApplyEdit(args: {
  worktree: Worktree;
  feedback: ParsedFeedback;
  triage: TriageResult;
}): Promise<EditOutcome> {
  const searchPlan = await proposeSearches(args.feedback, args.triage);
  if (!searchPlan || searchPlan.searches.length === 0) {
    return {
      applied: false,
      reason: 'no search plan produced',
      files: [],
      proposal: null,
      searchPlan,
    };
  }

  const matchedFiles = await runSearches(searchPlan, args.worktree.path);
  if (matchedFiles.length === 0) {
    return {
      applied: false,
      reason: 'no files matched the search patterns',
      files: [],
      proposal: null,
      searchPlan,
    };
  }

  const fileBlobs = await loadFiles(args.worktree.path, matchedFiles);
  const proposal = await proposeEdit(args.feedback, args.triage, fileBlobs);

  if (!proposal || proposal.files.length === 0) {
    return {
      applied: false,
      reason: proposal?.plan ?? 'edit proposer returned no files',
      files: [],
      proposal,
      searchPlan,
    };
  }

  if (proposal.files.length > config.diffCap.files) {
    return {
      applied: false,
      reason: `proposal exceeds file cap: ${proposal.files.length} > ${config.diffCap.files}`,
      files: proposal.files.map((f) => f.path),
      proposal,
      searchPlan,
    };
  }

  const applied = applyProposal(args.worktree.path, proposal);
  return {
    applied: applied.ok,
    reason: applied.reason,
    files: proposal.files.map((f) => f.path),
    proposal,
    searchPlan,
  };
}

async function proposeSearches(
  feedback: ParsedFeedback,
  triage: TriageResult,
): Promise<SearchPlan | null> {
  const userPrompt = [
    `Triage class: ${triage.klass}`,
    `Triage rationale: ${triage.rationale}`,
    `Proposed PR title: ${triage.proposedTitle ?? '(none)'}`,
    '',
    'Feedback body:',
    feedback.feedback,
  ].join('\n');

  const r = await complete({
    model: config.models.edit,
    maxTokens: 600,
    messages: [
      { role: 'system', content: SEARCH_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return parseJsonOrNull<SearchPlan>(r.content);
}

interface FileMatch {
  path: string;
  hits: number;
}

async function runSearches(
  plan: SearchPlan,
  cwd: string,
): Promise<string[]> {
  const tally = new Map<string, number>();
  for (const s of plan.searches) {
    if (!s.pattern) continue;
    try {
      const { stdout } = await run(
        'git',
        [
          'grep',
          '-l',
          '-I',
          '-E',
          s.pattern,
          '--',
          'ios/',
          'backend/',
          'WhereToEat/',
        ],
        { cwd, allowedExitCodes: [1] },
      );
      for (const f of stdout.trim().split('\n').filter(Boolean)) {
        tally.set(f, (tally.get(f) ?? 0) + 1);
      }
    } catch {
      /* skip bad pattern */
    }
  }
  const ranked: FileMatch[] = Array.from(tally.entries())
    .map(([p, hits]) => ({ path: p, hits }))
    .sort((a, b) => b.hits - a.hits);
  return ranked.slice(0, 12).map((r) => r.path);
}

interface FileBlob {
  path: string;
  content: string;
  truncated: boolean;
}

async function loadFiles(
  cwd: string,
  files: string[],
): Promise<FileBlob[]> {
  const out: FileBlob[] = [];
  for (const f of files) {
    const full = path.join(cwd, f);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (stat.size > 80_000) {
        out.push({
          path: f,
          content: fs.readFileSync(full, 'utf8').slice(0, 80_000),
          truncated: true,
        });
      } else {
        out.push({
          path: f,
          content: fs.readFileSync(full, 'utf8'),
          truncated: false,
        });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

async function proposeEdit(
  feedback: ParsedFeedback,
  triage: TriageResult,
  files: FileBlob[],
): Promise<EditProposal | null> {
  const filesPayload = files
    .map(
      (f) =>
        `=== FILE: ${f.path}${f.truncated ? ' (truncated to 80KB)' : ''} ===\n${f.content}\n=== END FILE ===`,
    )
    .join('\n\n');

  const userPrompt = [
    `Triage class: ${triage.klass}`,
    `Triage rationale: ${triage.rationale}`,
    `Proposed PR title: ${triage.proposedTitle ?? '(none)'}`,
    '',
    'Feedback body:',
    feedback.feedback,
    '',
    `App context: appVersion=${feedback.appVersion} device=${feedback.device} iOS=${feedback.iosVersion}`,
    '',
    'Candidate files:',
    filesPayload,
  ].join('\n');

  const r = await complete({
    model: config.models.edit,
    maxTokens: 8000,
    messages: [
      { role: 'system', content: EDIT_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return parseJsonOrNull<EditProposal>(r.content);
}

function applyProposal(
  cwd: string,
  proposal: EditProposal,
): { ok: boolean; reason?: string } {
  for (const f of proposal.files) {
    if (!f.path || f.path.includes('..') || path.isAbsolute(f.path)) {
      return { ok: false, reason: `unsafe path: ${f.path}` };
    }
    const target = path.join(cwd, f.path);
    if (!target.startsWith(cwd + path.sep)) {
      return { ok: false, reason: `path escapes worktree: ${f.path}` };
    }
    if (typeof f.new_content !== 'string') {
      return { ok: false, reason: `missing new_content for ${f.path}` };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.new_content);
  }
  return { ok: true };
}

function parseJsonOrNull<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
