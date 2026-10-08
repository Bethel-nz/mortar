/**
 * Real execution in a Vercel Sandbox VM that mirrors the MongoFs workspace.
 * Each run pushes the VFS into the VM, runs the command, and writes changed
 * files back. MongoFs stays the source of truth. Deletions in the VM are only
 * reported: latch denies fs.rm, and a shell in the VM must not get around that.
 */
import { Sandbox } from "@vercel/sandbox";
import { createHash } from "node:crypto";
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
const MAX_OUTPUT_CHARS = 20_000;

// `find` prints sandbox-relative paths of syncable files; sha1sum hashes them.
const LIST_SCRIPT = [
  `find . \\( ${SKIP_DIRS.map((d) => `-name '${d}'`).join(" -o ")} \\) -prune`,
  `-o -type f -size -${MAX_SYNC_BYTES}c -print0 | xargs -0 -r sha1sum`,
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
   * from the VM. Defaults: 100 files, 1 MiB.
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
  /** Set when the run went over the write-back budget, so nothing was written. */
  discarded?: string;
}

export class SandboxRunner {
  private sandbox: Promise<Sandbox> | undefined;
  /** sha1 per VFS path, keyed by the revision it was computed at. */
  private shas = new Map<string, { rev: number; sha: string }>();

  constructor(private readonly opts: SandboxRunnerOptions) {}

  async run(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const sandbox = await this.connect();
    const before = await this.list(sandbox);
    const expected = await this.push(sandbox, before);

    const cwd = options.cwd ? `${ROOT}/${options.cwd.replace(/^\/+/, "")}` : ROOT;
    const result = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", command],
      cwd,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
    });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);

    const pulled = await this.pull(sandbox, expected);
    return { exitCode: result.exitCode, stdout: clip(stdout), stderr: clip(stderr), ...pulled };
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
  private async push(sandbox: Sandbox, inSandbox: Map<string, string>): Promise<Map<string, string>> {
    const expected = new Map<string, string>();
    const writes: { path: string; content: Uint8Array }[] = [];

    for (const path of this.opts.fs.getAllPaths()) {
      if (!this.opts.canPush(path) || skipped(path)) continue;
      const stat = await this.opts.fs.lstat(path);
      if (!stat.isFile || stat.size >= MAX_SYNC_BYTES) continue;
      const { sha, content } = await this.hash(path);
      expected.set(path, sha);
      if (inSandbox.get(path) !== sha) {
        writes.push({ path: ROOT + path, content: content ?? (await this.opts.fs.readFileBuffer(path)) });
      }
    }

    const stale = [...inSandbox.keys()].filter((path) => !expected.has(path));
    if (writes.length) await sandbox.writeFiles(writes);
    if (stale.length) {
      await sandbox.runCommand({ cmd: "rm", args: ["-f", "--", ...stale.map((p) => ROOT + p)] });
    }
    return expected;
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
    const maxBytes = this.opts.maxPullBytes ?? MAX_SYNC_BYTES;
    let discarded = changed.length > maxFiles ? `${changed.length} files changed, over the ${maxFiles}-file budget` : undefined;
    const reads: { path: string; content: Uint8Array }[] = [];
    let bytes = 0;
    for (const path of discarded ? [] : changed) {
      const content = await sandbox.readFileToBuffer({ path: ROOT + path });
      if (!content) continue; // removed between the listing and the read
      bytes += content.length;
      if (bytes > maxBytes) {
        discarded = `more than ${maxBytes} bytes changed, over the write-back budget`;
        break;
      }
      reads.push({ path, content });
    }
    if (discarded) return { written: [], refused: [...refused, ...changed], deletedInSandbox, discarded };

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
    return { written, refused, deletedInSandbox };
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
