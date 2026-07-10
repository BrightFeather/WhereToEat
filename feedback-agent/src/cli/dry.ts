import { listUnprocessedFeedback } from '../gmail.js';
import { parseFeedbackBody } from '../parser.js';
import { triage } from '../triage.js';

async function run(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const skipTriage = args.has('--no-triage');
  const limit = (() => {
    for (const a of process.argv.slice(2)) {
      const m = a.match(/^--limit=(\d+)$/);
      if (m) return Number(m[1]);
    }
    return 50;
  })();

  console.log(`Dry run — listing up to ${limit} unprocessed feedback emails…\n`);
  const emails = await listUnprocessedFeedback(limit);
  if (emails.length === 0) {
    console.log('No new feedback. Nothing to do.');
    return;
  }
  console.log(`Found ${emails.length} email(s).\n`);

  let totalTokens = 0;
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i]!;
    const parsed = parseFeedbackBody(e.body);
    const date = new Date(e.internalDate).toISOString();
    console.log(`──────────────────────────────────────────────`);
    console.log(`#${i + 1}  threadId=${e.threadId}`);
    console.log(`     received=${date}`);
    console.log(`     from=${e.from}`);
    console.log(`     subject=${e.subject}`);
    console.log(`     userId=${parsed.userId}`);
    console.log(`     name=${parsed.name}`);
    console.log(`     replyTo=${parsed.replyTo}`);
    console.log(`     appVersion=${parsed.appVersion}  device=${parsed.device}  iOS=${parsed.iosVersion}`);
    console.log(`     feedback:`);
    for (const line of (parsed.feedback || '(empty)').split('\n')) {
      console.log(`       | ${line}`);
    }

    if (skipTriage) continue;

    try {
      const t = await triage(parsed);
      totalTokens += t.usage.promptTokens + t.usage.completionTokens;
      console.log(`     triage: ${t.klass}`);
      console.log(`     rationale: ${t.rationale}`);
      if (t.proposedTitle) console.log(`     proposedTitle: ${t.proposedTitle}`);
      console.log(`     tokens: prompt=${t.usage.promptTokens} completion=${t.usage.completionTokens}`);
    } catch (err) {
      console.log(`     triage: ERROR ${(err as Error).message}`);
    }
  }

  console.log(`──────────────────────────────────────────────`);
  if (!skipTriage) {
    console.log(`Total triage tokens used: ${totalTokens}`);
  }
  console.log(`No PRs created (dry run). No labels applied.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
