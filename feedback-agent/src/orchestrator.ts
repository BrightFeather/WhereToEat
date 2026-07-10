import { listUnprocessedFeedback, markThreadProcessed, type FeedbackEmail } from './gmail.js';
import { parseFeedbackBody, type ParsedFeedback } from './parser.js';
import { triage, type TriageResult, type TriageClass } from './triage.js';
import { proposeAndApplyEdit } from './edit.js';
import { buildFixLoop, classifyChanges } from './builder.js';
import {
  commitAll,
  createWorktree,
  listChangedFiles,
  openPr,
  pushBranch,
} from './repo.js';
import { config } from './config.js';
import type { SummaryItem, SummaryReport } from './notify.js';
import fs from 'node:fs';
import path from 'node:path';

const ACTIONABLE: ReadonlySet<TriageClass> = new Set([
  'actionable_copy',
  'actionable_bug',
  'actionable_feature_small',
]);

export interface RunOptions {
  apply: boolean; // when false: dry-run (no edits, no PRs, no labels)
  threadId?: string; // when set: process only this thread
  limit?: number;
}

export async function runOnce(opts: RunOptions): Promise<SummaryReport> {
  const startedAt = new Date().toISOString();
  const limit = opts.limit ?? config.dailyPrCap * 5;
  let emails = await listUnprocessedFeedback(limit);
  if (opts.threadId) {
    emails = emails.filter((e) => e.threadId === opts.threadId);
  }

  const items: SummaryItem[] = [];
  let prsOpened = 0;
  let draftPrs = 0;
  let skipped = 0;
  let errors = 0;
  let totalTokens = 0;
  let actionableProcessed = 0;

  for (const email of emails) {
    if (actionableProcessed >= config.dailyPrCap) {
      items.push({
        threadId: email.threadId,
        feedbackPreview: parseFeedbackBody(email.body).feedback,
        triageClass: 'deferred',
        outcome: 'deferred',
        reason: `daily PR cap (${config.dailyPrCap}) reached`,
      });
      continue;
    }
    try {
      const item = await processOne(email, opts);
      totalTokens += item.tokensUsed ?? 0;
      items.push(item);
      switch (item.outcome) {
        case 'pr_opened':
          prsOpened++;
          actionableProcessed++;
          break;
        case 'draft_pr_needs_human':
          draftPrs++;
          actionableProcessed++;
          break;
        case 'skipped_vague':
        case 'skipped_noise':
        case 'over_cap':
          skipped++;
          break;
        case 'error':
        case 'budget_exceeded':
          errors++;
          break;
      }
    } catch (e) {
      errors++;
      items.push({
        threadId: email.threadId,
        feedbackPreview: parseFeedbackBody(email.body).feedback,
        triageClass: 'error',
        outcome: 'error',
        reason: (e as Error).message.slice(0, 300),
      });
    }
  }

  return {
    runStartedAt: startedAt,
    runFinishedAt: new Date().toISOString(),
    totalEmails: emails.length,
    prsOpened,
    draftPrs,
    skipped,
    errors,
    totalTokens,
    items,
  };
}

async function processOne(
  email: FeedbackEmail,
  opts: RunOptions,
): Promise<SummaryItem> {
  const parsed = parseFeedbackBody(email.body);
  const t = await triage(parsed);
  let tokens = t.usage.promptTokens + t.usage.completionTokens;

  if (t.klass === 'praise_or_noise') {
    if (opts.apply) await markThreadProcessed(email.threadId);
    return {
      threadId: email.threadId,
      feedbackPreview: parsed.feedback,
      triageClass: t.klass,
      outcome: 'skipped_noise',
      reason: t.rationale,
      tokensUsed: tokens,
    };
  }
  if (t.klass === 'vague') {
    if (opts.apply) await markThreadProcessed(email.threadId);
    return {
      threadId: email.threadId,
      feedbackPreview: parsed.feedback,
      triageClass: t.klass,
      outcome: 'skipped_vague',
      reason: t.rationale,
      tokensUsed: tokens,
    };
  }
  if (t.klass === 'actionable_feature_large') {
    return await openNeedsHumanDraft({
      email,
      parsed,
      triage: t,
      reason: 'feature exceeds size cap (large feature)',
      tokens,
      opts,
    });
  }
  if (!ACTIONABLE.has(t.klass)) {
    return {
      threadId: email.threadId,
      feedbackPreview: parsed.feedback,
      triageClass: t.klass,
      outcome: 'error',
      reason: `unknown triage class: ${t.klass}`,
      tokensUsed: tokens,
    };
  }

  const branch = makeBranchName(t, email);
  const wt = await createWorktree(branch);
  try {
    const editOutcome = await proposeAndApplyEdit({
      worktree: wt,
      feedback: parsed,
      triage: t,
    });
    if (!editOutcome.applied) {
      return await openNeedsHumanDraft({
        email,
        parsed,
        triage: t,
        reason: editOutcome.reason ?? 'edit not applied',
        tokens,
        opts,
        worktreeBranch: branch,
        worktreeChanged: editOutcome.files,
      });
    }

    // Apply succeeded; check diff cap before building.
    const stats = await listChangedFiles(wt);
    if (
      stats.files.length > config.diffCap.files ||
      stats.insertions + stats.deletions > config.diffCap.lines
    ) {
      return await openNeedsHumanDraft({
        email,
        parsed,
        triage: t,
        reason: `over diff cap: files=${stats.files.length} lines=${stats.insertions + stats.deletions}`,
        tokens,
        opts,
        worktreeBranch: branch,
        worktreeChanged: stats.files,
      });
    }

    // Build until green or retry cap.
    const area = classifyChanges(stats.files);
    const buildResult = await buildFixLoop({
      cwd: wt.path,
      area,
      feedback: parsed,
      triage: t,
      applyAgain: async (files) => {
        for (const f of files) {
          if (
            !f.path ||
            f.path.includes('..') ||
            path.isAbsolute(f.path)
          ) {
            throw new Error(`unsafe path: ${f.path}`);
          }
          const target = path.join(wt.path, f.path);
          if (!target.startsWith(wt.path + path.sep)) {
            throw new Error(`path escapes worktree: ${f.path}`);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, f.new_content);
        }
      },
    });

    if (!opts.apply) {
      return {
        threadId: email.threadId,
        feedbackPreview: parsed.feedback,
        triageClass: t.klass,
        outcome: buildResult.ok ? 'pr_opened' : 'draft_pr_needs_human',
        reason: buildResult.ok
          ? '(dry-run: would open PR)'
          : `(dry-run: would open draft, build failed after ${buildResult.attempts} retries)`,
        filesChanged: stats.files,
        buildAttempts: buildResult.attempts,
        tokensUsed: tokens,
      };
    }

    // Re-check diff cap (build-fix loop may have grown the change set).
    const finalStats = await listChangedFiles(wt);
    if (
      finalStats.files.length > config.diffCap.files ||
      finalStats.insertions + finalStats.deletions > config.diffCap.lines
    ) {
      return await openNeedsHumanDraft({
        email,
        parsed,
        triage: t,
        reason: `build-fix loop pushed past diff cap: files=${finalStats.files.length} lines=${finalStats.insertions + finalStats.deletions}`,
        tokens,
        opts,
        worktreeBranch: branch,
        worktreeChanged: finalStats.files,
        worktree: wt,
      });
    }

    const commitMsg = formatCommitMessage(t, email);
    await commitAll(wt, commitMsg);
    await pushBranch(wt);

    if (buildResult.ok) {
      const pr = await openPr({
        branch,
        title: t.proposedTitle ?? `feedback: ${t.klass}`,
        body: renderPrBody(parsed, t, email, finalStats.files, buildResult.attempts),
      });
      await markThreadProcessed(email.threadId);
      return {
        threadId: email.threadId,
        feedbackPreview: parsed.feedback,
        triageClass: t.klass,
        outcome: 'pr_opened',
        prUrl: pr.url,
        filesChanged: finalStats.files,
        buildAttempts: buildResult.attempts,
        tokensUsed: tokens,
      };
    } else {
      const pr = await openPr({
        branch,
        title: `[needs-human] ${t.proposedTitle ?? t.klass}`,
        body: renderPrBody(
          parsed,
          t,
          email,
          finalStats.files,
          buildResult.attempts,
          buildResult.finalOutput,
        ),
        draft: true,
        labels: ['needs-human'],
      });
      await markThreadProcessed(email.threadId);
      return {
        threadId: email.threadId,
        feedbackPreview: parsed.feedback,
        triageClass: t.klass,
        outcome: 'draft_pr_needs_human',
        prUrl: pr.url,
        filesChanged: finalStats.files,
        buildAttempts: buildResult.attempts,
        reason: `build failed after ${buildResult.attempts} retries`,
        tokensUsed: tokens,
      };
    }
  } finally {
    await wt.cleanup();
  }
}

async function openNeedsHumanDraft(args: {
  email: FeedbackEmail;
  parsed: ParsedFeedback;
  triage: TriageResult;
  reason: string;
  tokens: number;
  opts: RunOptions;
  worktreeBranch?: string;
  worktreeChanged?: string[];
  worktree?: { path: string; branch: string };
}): Promise<SummaryItem> {
  if (!args.opts.apply) {
    return {
      threadId: args.email.threadId,
      feedbackPreview: args.parsed.feedback,
      triageClass: args.triage.klass,
      outcome: 'draft_pr_needs_human',
      reason: `(dry-run) ${args.reason}`,
      filesChanged: args.worktreeChanged,
      tokensUsed: args.tokens,
    };
  }
  // Mark processed without opening a PR — the daily summary captures it.
  await markThreadProcessed(args.email.threadId);
  return {
    threadId: args.email.threadId,
    feedbackPreview: args.parsed.feedback,
    triageClass: args.triage.klass,
    outcome: args.triage.klass === 'actionable_feature_large' ? 'over_cap' : 'draft_pr_needs_human',
    reason: args.reason,
    filesChanged: args.worktreeChanged,
    tokensUsed: args.tokens,
  };
}

function makeBranchName(t: TriageResult, email: FeedbackEmail): string {
  const base = (t.proposedTitle ?? t.klass)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `feedback/${base}-${email.messageId.slice(0, 8)}`;
}

function formatCommitMessage(t: TriageResult, email: FeedbackEmail): string {
  const title = t.proposedTitle ?? `feedback: ${t.klass}`;
  return `${title}\n\nFeedback thread: ${email.threadId}\nTriage: ${t.klass}\n${t.rationale}`;
}

function renderPrBody(
  parsed: ParsedFeedback,
  t: TriageResult,
  email: FeedbackEmail,
  files: string[],
  buildAttempts: number,
  buildOutput?: string,
): string {
  const lines: string[] = [];
  lines.push(`## Feedback`);
  lines.push('');
  lines.push('> ' + parsed.feedback.replace(/\n/g, '\n> '));
  lines.push('');
  lines.push('## Source');
  lines.push('');
  lines.push(`- Gmail thread: \`${email.threadId}\``);
  lines.push(`- User id: \`${parsed.userId ?? 'unknown'}\``);
  lines.push(`- Reply-to: \`${parsed.replyTo ?? 'unknown'}\``);
  lines.push(`- App version: ${parsed.appVersion ?? 'unknown'}`);
  lines.push(`- Device: ${parsed.device ?? 'unknown'}  iOS: ${parsed.iosVersion ?? 'unknown'}`);
  lines.push('');
  lines.push('## Triage');
  lines.push('');
  lines.push(`- Class: \`${t.klass}\``);
  lines.push(`- Rationale: ${t.rationale}`);
  lines.push('');
  lines.push('## Files changed');
  lines.push('');
  for (const f of files) lines.push(`- \`${f}\``);
  lines.push('');
  lines.push(`Build attempts: ${buildAttempts}${buildAttempts > 0 ? ' (recovered after retries)' : ''}`);
  if (buildOutput) {
    lines.push('');
    lines.push('## Build output (failing)');
    lines.push('');
    lines.push('```');
    lines.push(buildOutput);
    lines.push('```');
  }
  lines.push('');
  lines.push('---');
  lines.push('Generated by feedback-agent. Review carefully before merging.');
  return lines.join('\n');
}
