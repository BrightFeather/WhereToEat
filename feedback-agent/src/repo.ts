import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './config.js';

const exec = promisify(execFile);

// The agent lives at <repoRoot>/feedback-agent/, so the parent WhereToEat repo
// is one level up. Resolved once at startup.
export const repoRoot = path.resolve(paths.repoRoot, '..');

interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowedExitCodes?: number[];
}

export async function run(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const code = typeof err.code === 'number' ? err.code : 1;
    if (opts.allowedExitCodes?.includes(code)) {
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        code,
      };
    }
    const msg = `${cmd} ${args.join(' ')} exited ${code}\nstderr: ${err.stderr ?? ''}\nstdout: ${err.stdout ?? ''}`;
    throw new Error(msg);
  }
}

export interface Worktree {
  path: string;
  branch: string;
  cleanup: () => Promise<void>;
}

// Create a temp git worktree off origin/main. Operating in a separate worktree
// means the user's current checkout (with its WIP) is never touched. The worktree
// is deleted on cleanup() — call it in a finally block.
//
// Cleanup uses `rm -rf + git worktree prune` rather than `git worktree remove`
// because the latter was only added in git 2.17 (2018) and macOS often has
// older /usr/local/bin/git masking the system one. Prune works on git 2.5+.
export async function createWorktree(branch: string): Promise<Worktree> {
  // Prune any orphaned worktree entries from prior crashed runs so we don't
  // collide with a stale branch reservation.
  await run('git', ['worktree', 'prune'], { allowedExitCodes: [1] });
  // Delete a leftover branch from a prior crashed run; harmless if absent.
  await run('git', ['branch', '-D', branch], { allowedExitCodes: [1] });

  await run('git', ['fetch', 'origin', 'main', '--quiet']);
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wte-fb-'));
  // git worktree add fails if the dir exists (mkdtemp made it), so remove first.
  fs.rmdirSync(wtPath);
  await run('git', [
    'worktree',
    'add',
    '-B',
    branch,
    wtPath,
    'origin/main',
  ]);
  return {
    path: wtPath,
    branch,
    cleanup: async () => {
      // 1. Remove the worktree directory on disk.
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      // 2. Tell git the worktree is gone so the branch is no longer "checked out".
      try {
        await run('git', ['worktree', 'prune'], { allowedExitCodes: [1] });
      } catch {
        /* ignore */
      }
      // 3. Delete the local branch (now safe since worktree is pruned).
      try {
        await run('git', ['branch', '-D', branch], { allowedExitCodes: [1] });
      } catch {
        /* ignore */
      }
    },
  };
}

export async function commitAll(
  wt: Worktree,
  message: string,
): Promise<void> {
  await run('git', ['add', '-A'], { cwd: wt.path });
  await run('git', ['commit', '-m', message], { cwd: wt.path });
}

export async function pushBranch(wt: Worktree): Promise<void> {
  await run('git', ['push', '-u', 'origin', wt.branch], { cwd: wt.path });
}

export interface OpenPrArgs {
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

export async function openPr(args: OpenPrArgs): Promise<{ url: string }> {
  const ghArgs = [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    args.branch,
    '--title',
    args.title,
    '--body',
    args.body,
  ];
  if (args.draft) ghArgs.push('--draft');
  if (args.labels?.length) {
    for (const l of args.labels) ghArgs.push('--label', l);
  }
  const { stdout } = await run('gh', ghArgs);
  const url = stdout.trim().split('\n').pop() ?? '';
  return { url };
}

export async function listChangedFiles(
  wt: Worktree,
): Promise<{ files: string[]; insertions: number; deletions: number }> {
  const { stdout } = await run(
    'git',
    ['diff', '--numstat', 'HEAD'],
    { cwd: wt.path },
  );
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const ins = Number(parts[0]);
    const del = Number(parts[1]);
    const file = parts[2] ?? '';
    if (file) files.push(file);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
  }
  return { files, insertions, deletions };
}
