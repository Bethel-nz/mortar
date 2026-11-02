/**
 * Real execution in a Vercel Sandbox VM that mirrors the MongoFs workspace.
 * Each run pushes the VFS into the VM, runs the command, and writes changed
 * files back. MongoFs stays the source of truth. Deletions in the VM are only
 * reported: deliberate removal is a gated workspace operation (delete_file,
 * move_file), and a shell in the VM must not get around that.
 */
import { Sandbox } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { MongoFs } from "@vyr-e/mongo-vfs";

// The VM's own cwd and $HOME is /vercel, full of dotfiles (.npmrc, .cache) that
// must not be mirrored or deleted, so the workspace gets a directory of its own.
export const ROOT = "/vercel/workspace";
const SKIP_DIRS = [
  "node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", ".pytest_cache", "target",
  // Build output: never mirrored, so a build's artifacts stay in the VM.
  ".next", ".turbo", "dist", ".output", ".nuxt", ".svelte-kit", ".vercel", "coverage", ".parcel-cache",
];
const MAX_SYNC_BYTES = 1024 * 1024;
// Lockfiles change wholesale on every install and routinely pass 1 MiB, so
// they sync at a higher per-file cap than ordinary files.
const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml",
  "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "composer.lock", "Gemfile.lock",
  "go.sum", "flake.lock", "mix.lock",
]);
const MAX_OUTPUT_CHARS = 20_000;
// Reads to Mongo and the VM API are round-trips; a formatter or codemod can
// touch dozens of files per run, so they go over the wire concurrently.
const READ_CONCURRENCY = 8;

const syncLimitFor = (path: string): number =>
  LOCKFILES.has(posix.basename(path)) ? MAX_LOCKFILE_BYTES : MAX_SYNC_BYTES;

// `find` prints sandbox-relative paths of syncable files; sha1sum hashes them.
// The size cap here is the largest per-file limit; each path's own limit is
// applied where the path is known, in push() and pull().
const LIST_SCRIPT = [
  `find . \\( ${SKIP_DIRS.map((d) => `-name '${d}'`).join(" -o ")} \\) -prune`,
  `-o -type f -size -${MAX_LOCKFILE_BYTES}c -print0 | xargs -0 -r sha1sum`,
].join(" ");

export interface SandboxRunnerOptions {
  fs: MongoFs;
  /** Stable sandbox name; the VM persists under it and resumes next session. */
  name: string;
  /** May this VFS path be copied into the VM? Protected paths must say no. */
  canPush: (path: string) => boolean;
  /** May the VM write this path back into the VFS? */
  canPull: (path: string) => boolean;
  /**
   * Write-back budget per run. Output dir names are a convention a build can
   * ignore (`--outDir`, a script, a renamed folder); the budget is not. A run
   * over either limit writes nothing back, and the next push clears its output
   * from the VM. Defaults: 100 files, 10 MiB.
   */
  maxPullFiles?: number;
  maxPullBytes?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** VFS paths the command created or changed, now written to MongoFs. */
  written: string[];
  /** Changed in the VM but refused by canPull or the VFS, so not written. */
  refused: string[];
  /** Deleted in the VM; still in the VFS and restored on the next run. */
  deletedInSandbox: string[];
  /** Over the per-file sync limit (1 MiB; lockfiles 10 MiB), so not mirrored. */
  oversized: string[];
  /** Set when the run went over the write-back budget, so nothing was written. */
  discarded?: string;
}

export class SandboxRunner {
  private sandbox: Promise<Sandbox> | undefined;
  /** sha1 per VFS path, keyed by the revision it was computed at. */
  private shas = new Map<string, { rev: number; sha: string }>();

  constructor(private readonly opts: SandboxRunnerOptions) {}

  async run(command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const sandbox = await this.connect();
    const before = await this.list(sandbox);
    const { expected, oversized } = await this.push(sandbox, before);

    // A workspace-relative cwd, resolved so "../../etc" cannot climb out of ROOT.
    const cwd = options.cwd ? posix.join(ROOT, posix.normalize(`/${options.cwd}`)) : ROOT;
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", command],
      cwd,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      signal: options.signal,
    });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);

    const pulled = await this.pull(sandbox, expected);
    return {
      exitCode: result.exitCode,
      stdout: clip(stdout),
      stderr: clip(stderr),
      ...pulled,
      oversized: [...new Set([...oversized, ...pulled.oversized])],
    };
  }

  /** Stop the VM. Its filesystem, installed dependencies included, is saved for next time. */
  async close(): Promise<void> {
    if (!this.sandbox) return;
    const sandbox = await this.sandbox.catch(() => undefined);
    this.sandbox = undefined;
    await sandbox?.stop().catch(() => {});
  }

  private connect(): Promise<Sandbox> {
    this.sandbox ??= Sandbox.getOrCreate({
      name: this.opts.name,
      timeout: 30 * 60_000,
      ...credentials(),
    }).then(async (sandbox) => {
      await sandbox.runCommand("mkdir", ["-p", ROOT]);
      return sandbox;
    }).catch((error) => {
      this.sandbox = undefined; // let the next run retry
      throw error;
    });
    return this.sandbox;
  }

  /**
   * VFS path → sha1 for every syncable file in the VM. Unpushable paths
   * (secrets) the VM made itself are left out, so they are never synced or deleted.
   */
  private async list(sandbox: Sandbox): Promise<Map<string, string>> {
    const result = await sandbox.runCommand({ cmd: "bash", args: ["-c", LIST_SCRIPT], cwd: ROOT });
    if (result.exitCode !== 0) throw new Error(`sandbox: listing failed: ${await result.stderr()}`);
    const files = new Map<string, string>();
    for (const line of (await result.stdout()).split("\n")) {
      const match = /^([0-9a-f]{40}) [ *]\.(\/.+)$/.exec(line);
      if (match && this.opts.canPush(match[2])) files.set(match[2], match[1]);
    }
    return files;
  }

  /** Make the VM match the VFS. Returns the hash every synced path should now have. */
  private async push(sandbox: Sandbox, inSandbox: Map<string, string>): Promise<{ expected: Map<string, string>; oversized: string[] }> {
    const expected = new Map<string, string>();
    const oversized: string[] = [];
    const writes: { path: string; content: Uint8Array }[] = [];

    const paths = this.opts.fs.getAllPaths().filter((path) => this.opts.canPush(path) && !skipped(path));
    const synced = await mapLimit(paths, READ_CONCURRENCY, async (path) => {
      const stat = await this.opts.fs.lstat(path);
      if (!stat.isFile) return undefined;
      if (stat.size >= syncLimitFor(path)) return { kind: "over" as const, path };
      const { sha, content } = await this.hash(path);
      return { kind: "sync" as const, path, sha, content, changed: inSandbox.get(path) !== sha };
    });
    for (const entry of synced) {
      if (!entry) continue;
      if (entry.kind === "over") {
        oversized.push(entry.path);
        continue;
      }
      expected.set(entry.path, entry.sha);
      if (entry.changed) {
        writes.push({ path: ROOT + entry.path, content: entry.content ?? (await this.opts.fs.readFileBuffer(entry.path)) });
      }
    }

    const stale = [...inSandbox.keys()].filter((path) => !expected.has(path));
    if (writes.length) await sandbox.writeFiles(writes);
    if (stale.length) {
      await sandbox.runCommand({ cmd: "rm", args: ["-f", "--", ...stale.map((p) => ROOT + p)] });
    }
    return { expected, oversized };
  }

  private async pull(sandbox: Sandbox, expected: Map<string, string>) {
    const after = await this.list(sandbox);
    const changed: string[] = [];
    const refused: string[] = [];

    for (const [path, sha] of after) {
      if (expected.get(path) === sha) continue;
      (this.opts.canPull(path) ? changed : refused).push(path);
    }
    const deletedInSandbox = [...expected.keys()].filter((path) => !after.has(path));

    // Read everything before writing anything: over budget means none of it lands.
    const maxFiles = this.opts.maxPullFiles ?? 100;
    const maxBytes = this.opts.maxPullBytes ?? MAX_LOCKFILE_BYTES;
    let discarded = changed.length > maxFiles ? `${changed.length} files changed, over the ${maxFiles}-file budget` : undefined;
    const oversized: string[] = [];
    const reads: { path: string; content: Uint8Array }[] = [];
    if (!discarded) {
      // One RPC per file, so a formatter's dozens of changes read concurrently;
      // a file removed or unreadable between listing and read is skipped.
      const fetched = await mapLimit(changed, READ_CONCURRENCY, (path) =>
        sandbox.readFileToBuffer({ path: ROOT + path }).then(
          (content) => ({ path, content }) as const,
          () => undefined,
        ),
      );
      let bytes = 0;
      for (const item of fetched) {
        if (!item?.content) continue;
        if (item.content.length >= syncLimitFor(item.path)) {
          oversized.push(item.path);
          continue;
        }
        bytes += item.content.length;
        if (bytes > maxBytes) {
          discarded = `more than ${maxBytes} bytes changed, over the write-back budget`;
          break;
        }
        reads.push({ path: item.path, content: item.content });
      }
    }
    if (discarded) return { written: [], refused: [...refused, ...changed], deletedInSandbox, oversized, discarded };

    const written: string[] = [];
    for (const { path, content } of reads) {
      try {
        await this.opts.fs.writeFile(path, content);
      } catch {
        refused.push(path); // e.g. the VFS has a directory at that path
        continue;
      }
      this.shas.set(path, { rev: await this.opts.fs.revision(path), sha: after.get(path)! });
      written.push(path);
    }
    return { written, refused, deletedInSandbox, oversized };
  }

  /** sha1 of a VFS file, cached by revision. Returns the bytes when it had to read them. */
  private async hash(path: string): Promise<{ sha: string; content?: Uint8Array }> {
    const rev = await this.opts.fs.revision(path);
    const cached = this.shas.get(path);
    if (cached?.rev === rev) return { sha: cached.sha };
    const content = await this.opts.fs.readFileBuffer(path);
    const sha = createHash("sha1").update(content).digest("hex");
    this.shas.set(path, { rev, sha });
    return { sha, content };
  }
}

function skipped(path: string): boolean {
  return path.split("/").some((segment) => SKIP_DIRS.includes(segment));
}

/** Runs fn over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
    }),
  );
  return results;
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n… ${text.length - MAX_OUTPUT_CHARS} chars elided …\n${text.slice(-half)}`;
}

/**
 * Access-token auth for non-Vercel environments. Without these three, the SDK
 * falls back to VERCEL_OIDC_TOKEN (from `vercel env pull` into .env.local).
 */
function credentials(): { token: string; teamId: string; projectId: string } | {} {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}
