import { runOnce } from '../orchestrator.js';
import { sendSummaryEmail } from '../notify.js';

interface Flags {
  dryRun: boolean;
  noNotify: boolean;
  limit?: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, noNotify: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-notify') flags.noNotify = true;
    else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length));
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `feedback-agent run starting (apply=${!flags.dryRun}, notify=${!flags.noNotify})`,
  );
  const report = await runOnce({
    apply: !flags.dryRun,
    limit: flags.limit,
  });
  console.log(
    `done. seen=${report.totalEmails} prs=${report.prsOpened} drafts=${report.draftPrs} skipped=${report.skipped} errors=${report.errors} tokens=${report.totalTokens}`,
  );
  for (const item of report.items) {
    console.log(
      `  [${item.outcome}] ${item.triageClass} thread=${item.threadId} pr=${item.prUrl ?? '-'}${item.reason ? ` reason=${item.reason}` : ''}`,
    );
  }
  if (!flags.noNotify) {
    try {
      await sendSummaryEmail(report);
      console.log('summary email sent.');
    } catch (e) {
      console.error('summary email failed:', (e as Error).message);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
