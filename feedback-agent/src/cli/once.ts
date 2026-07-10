import { runOnce } from '../orchestrator.js';
import { sendSummaryEmail } from '../notify.js';

interface Flags {
  threadId?: string;
  dryRun: boolean;
  notify: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, notify: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--notify') flags.notify = true;
    else if (a.startsWith('--thread-id=')) flags.threadId = a.slice('--thread-id='.length);
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.threadId) {
    console.error('Usage: tsx src/cli/once.ts --thread-id=<id> [--dry-run] [--notify]');
    process.exit(2);
  }
  const report = await runOnce({
    apply: !flags.dryRun,
    threadId: flags.threadId,
  });
  console.log(JSON.stringify(report, null, 2));
  if (flags.notify) {
    await sendSummaryEmail(report);
    console.log('summary email sent.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
