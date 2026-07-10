import path from 'node:path';
import fs from 'node:fs';
import { run } from './repo.js';
import { complete } from './llm.js';
import { config } from './config.js';
import type { ParsedFeedback } from './parser.js';
import type { TriageResult } from './triage.js';

export interface BuildResult {
  ok: boolean;
  area: 'ios' | 'backend' | 'agent' | 'none';
  output: string;
}

const BUILD_FIX_PROMPT = `You are debugging a failed build. Your previous edit caused compile errors. Read the build output, then output a corrected proposal.

Same constraints as before:
- Touch at most ${config.diffCap.files} files
- Total changed lines must not exceed ${config.diffCap.lines}
- Output FULL replacement file contents — no diffs, no abbreviations

Reply with JSON only:
{
  "plan": "<≤200 chars on what you're fixing>",
  "files": [{"path": "<repo-relative>", "reason": "<≤120 chars>", "new_content": "<entire new file>"}]
}

If you cannot fix without exceeding the caps or you'd need files you can't see, return {"plan":"BAIL: ...", "files":[]}.`;

export interface BuildFixResult {
  ok: boolean;
  attempts: number;
  finalOutput: string;
  area: BuildResult['area'];
}

export function classifyChanges(files: string[]): BuildResult['area'] {
  const hasIos = files.some(
    (f) => f.startsWith('ios/') || f.startsWith('WhereToEat/'),
  );
  const hasBackend = files.some((f) => f.startsWith('backend/'));
  const hasAgent = files.some((f) => f.startsWith('feedback-agent/'));
  // Order of priority: iOS is the most expensive, do it last; if multiple,
  // we run iOS only because it's the slowest gate and the most likely to
  // surface real failures.
  if (hasIos) return 'ios';
  if (hasBackend) return 'backend';
  if (hasAgent) return 'agent';
  return 'none';
}

export async function buildArea(
  cwd: string,
  area: BuildResult['area'],
): Promise<BuildResult> {
  if (area === 'none') return { ok: true, area, output: '' };
  if (area === 'ios') return buildIos(cwd);
  if (area === 'backend') return buildBackend(cwd);
  if (area === 'agent') return buildAgent(cwd);
  return { ok: true, area, output: '' };
}

async function buildIos(cwd: string): Promise<BuildResult> {
  const projectPath = path.join(cwd, 'WhereToEat/WhereToEat.xcodeproj');
  if (!fs.existsSync(projectPath)) {
    return {
      ok: false,
      area: 'ios',
      output: `xcodeproj not found at ${projectPath}`,
    };
  }
  try {
    const { stdout, stderr } = await run(
      'xcodebuild',
      [
        '-project',
        projectPath,
        '-scheme',
        'WhereToEat',
        '-destination',
        'generic/platform=iOS Simulator',
        '-configuration',
        'Debug',
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        '-quiet',
        'build',
      ],
      { cwd, allowedExitCodes: [65, 70, 1] },
    );
    return {
      ok: true,
      area: 'ios',
      output: tail(stdout + stderr, 4000),
    };
  } catch (e) {
    return { ok: false, area: 'ios', output: tail((e as Error).message, 4000) };
  }
}

async function buildBackend(cwd: string): Promise<BuildResult> {
  const dir = path.join(cwd, 'backend');
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    return { ok: true, area: 'backend', output: '(no backend package.json — skipped)' };
  }
  try {
    const { stdout, stderr } = await run('npx', ['tsc', '--noEmit'], {
      cwd: dir,
    });
    return { ok: true, area: 'backend', output: tail(stdout + stderr, 2000) };
  } catch (e) {
    return {
      ok: false,
      area: 'backend',
      output: tail((e as Error).message, 4000),
    };
  }
}

async function buildAgent(cwd: string): Promise<BuildResult> {
  const dir = path.join(cwd, 'feedback-agent');
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    return { ok: true, area: 'agent', output: '(no feedback-agent — skipped)' };
  }
  try {
    const { stdout, stderr } = await run('npx', ['tsc', '--noEmit'], {
      cwd: dir,
    });
    return { ok: true, area: 'agent', output: tail(stdout + stderr, 2000) };
  } catch (e) {
    return {
      ok: false,
      area: 'agent',
      output: tail((e as Error).message, 4000),
    };
  }
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - n);
}

// Build-and-fix loop. The caller has already applied the first proposal and
// committed nothing yet. We rebuild; if it fails, we ask the LLM for a
// corrected file set (passed via applyAgain), re-build, retry up to
// config.retryCap times.
export async function buildFixLoop(args: {
  cwd: string;
  area: BuildResult['area'];
  feedback: ParsedFeedback;
  triage: TriageResult;
  applyAgain: (files: Array<{ path: string; new_content: string }>) => Promise<void>;
}): Promise<BuildFixResult> {
  let attempts = 0;
  let last: BuildResult = await buildArea(args.cwd, args.area);
  while (!last.ok && attempts < config.retryCap) {
    attempts++;
    const userPrompt = [
      `Triage class: ${args.triage.klass}`,
      `Feedback: ${args.feedback.feedback}`,
      '',
      `Build area: ${args.area}`,
      'Build output (tail):',
      last.output,
    ].join('\n');

    const r = await complete({
      model: config.models.buildFix,
      maxTokens: 8000,
      messages: [
        { role: 'system', content: BUILD_FIX_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    const cleaned = r.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    let parsed: { plan?: string; files?: Array<{ path: string; new_content: string }> } | null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.files || parsed.files.length === 0) break;
    if (parsed.plan?.startsWith('BAIL')) break;
    await args.applyAgain(parsed.files);
    last = await buildArea(args.cwd, args.area);
  }
  return {
    ok: last.ok,
    attempts,
    finalOutput: last.output,
    area: args.area,
  };
}
