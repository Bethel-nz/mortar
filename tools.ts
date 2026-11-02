import { tool } from "ai";
import type { Bash } from "just-bash";
import { LatchDeniedError, type LatchGate } from "@vyr-e/latch";
import { z } from "zod";
import type { MongoFs } from "@vyr-e/mongo-vfs";
import { commandTouchesProtectedPath } from "./permissions.ts";
import { ROOT as VM_ROOT, type SandboxRunner } from "./sandbox.ts";

interface ToolDeps {
  fs: MongoFs;
  bash: Bash;
  sandbox: SandboxRunner;
  gate: LatchGate;
}

export function createTools({ fs, bash, sandbox, gate }: ToolDeps) {
  const ls = gate.wrap(
    "fs.read",
    tool({
      description: "List a directory in the workspace. Paths are absolute, rooted at /.",
      inputSchema: z.object({ path: z.string().describe("Directory to list, e.g. / or /src") }),
      async execute({ path }) {
        const entries = await fs.readdirWithFileTypes(path);
        return entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n") || "(empty)";
      },
    }),
  );

  const read_file = gate.wrap(
    "fs.read",
    tool({
      description:
        "Read a text file from the workspace as numbered lines. Long files are clipped (default 300 lines); " +
        "read further ranges with offset and limit instead of asking for the whole file.",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path, e.g. /src/main.py"),
        offset: z.number().int().min(1).optional().describe("1-based line to start at (default 1)"),
        limit: z.number().int().min(1).max(500).optional().describe("Lines to return (default 300, max 500)"),
      }),
      async execute({ path, offset, limit }) {
        return numberedExcerpt(await fs.readFile(path), path, offset, limit);
      },
    }),
  );

  const write_file = gate.wrap(
    "fs.write",
    tool({
      description: "Create or overwrite a text file with a full body. Prefer search_replace for edits.",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path"),
        content: z.string().describe("Full file body"),
      }),
      async execute({ path, content }) {
        await fs.writeFile(path, content);
        return { wrote: path, bytes: Buffer.byteLength(content) };
      },
    }),
  );

  const search_replace = gate.wrap(
    "fs.search_replace",
    tool({
      description:
        "Edit a file by replacing an exact string. Cheapest write: sends only the old and new text. Fails with not_found when old has zero hits and not_unique when it has several.",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path"),
        old: z.string().min(1).describe("Exact text to find"),
        new: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace every occurrence (default: exactly one)"),
      }),
      async execute({ path, old, new: newText, replace_all }) {
        const result = await fs.searchReplace(path, old, newText, { replaceAll: replace_all });
        return { edited: path, rev: result.rev, size: result.size };
      },
    }),
  );

  const apply_patch = gate.wrap(
    "fs.apply_patch",
    tool({
      description: "Apply a unified diff to a file. Use when an edit spans several places.",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path"),
        diff: z.string().describe("Unified diff against the current file"),
      }),
      async execute({ path, diff }) {
        const result = await fs.applyPatch(path, diff);
        return { patched: path, rev: result.rev };
      },
    }),
  );

  const bashTool = gate.wrap(
    "bash.exec",
    tool({
      description: "Run a shell command against the workspace filesystem (ls, cat, grep, redirections).",
      inputSchema: z.object({ command: z.string().describe("The command line to run") }),
      async execute({ command }) {
        assertUnprotected("bash.exec", command);
        const result = await bash.exec(command);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
    }),
  );

  const delete_file = gate.wrap(
    "fs.rm",
    tool({
      description:
        "Delete a file or directory in the workspace, with human approval. This is the way to remove a path for real: " +
        "rm inside run only deletes the VM copy, and the next run restores it.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to remove"),
        recursive: z.boolean().optional().describe("Remove a directory tree (default: refuse non-empty directories)"),
      }),
      async execute({ path, recursive }) {
        await fs.rm(path, { recursive });
        return { deleted: path };
      },
    }),
  );

  const move_file = gate.wrap(
    "fs.mv",
    tool({
      description:
        "Move or rename a file or directory in the workspace, with human approval — e.g. utils.js to utils.ts. " +
        "mv inside run only renames the VM copy; the original returns on the next run.",
      inputSchema: z.object({
        source: z.string().describe("Absolute path to move"),
        dest: z.string().describe("Absolute destination"),
      }),
      async execute({ source, dest }) {
        await fs.mv(source, dest);
        return { moved: source, to: dest };
      },
    }),
  );

  const run = gate.wrap(
    "sandbox.exec",
    tool({
      description:
        "Run a real command (node, bun, python, npm, tests) in an isolated Linux VM holding a copy of the workspace. " +
        `The workspace root is the command's working directory (${VM_ROOT} in the VM), not /: use relative paths, ` +
        "so workspace file /hello/main.py is hello/main.py here. " +
        "Files the command creates or changes are written back to the workspace; node_modules, .git, and other dependency dirs stay in the VM. " +
        "Files 1 MiB or larger do not sync (lockfiles up to 10 MiB are excepted) and come back reported, not written. " +
        "Do not run builds: build output (dist, .next, .output, …) is never written back, and a run that changes more than " +
        "100 files or 10 MiB writes nothing back at all.",
      inputSchema: z.object({
        command: z.string().describe("Shell command, run with bash -lc, e.g. `npm install && npm test`"),
        cwd: z.string().optional().describe("Workspace directory to run in, e.g. /app (default /)"),
        timeout_seconds: z.number().int().positive().max(1800).optional().describe("Kill after this long (default 300)"),
      }),
      async execute({ command, cwd, timeout_seconds }, { abortSignal }) {
        assertUnprotected("sandbox.exec", command);
        return sandbox.run(command, { cwd, timeoutMs: timeout_seconds && timeout_seconds * 1000, signal: abortSignal });
      },
    }),
  );

  return { ls, read_file, write_file, search_replace, apply_patch, bash: bashTool, delete_file, move_file, run };
}

const READ_LINES = 300;
// Matches what an @tag inlines, so a file costs the model the same either way.
const READ_CHARS = 50_000;

/** `path lines X-Y of N` plus numbered lines, clipped to limit lines and READ_CHARS. */
function numberedExcerpt(body: string, path: string, offset = 1, limit = READ_LINES): string {
  const lines = body.split("\n");
  const total = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const start = Math.min(offset, total + 1);
  const slice = lines.slice(start - 1, start - 1 + limit);
  if (!slice.length) return `${path}: no line ${offset} (the file has ${total} lines)`;

  const shown: string[] = [];
  let chars = 0;
  let clippedLines = 0;
  for (let i = 0; i < slice.length; i++) {
    const line = `${start + i}\t${slice[i]}`;
    if (chars + line.length > READ_CHARS) {
      clippedLines = slice.length - i;
      break;
    }
    shown.push(line);
    chars += line.length + 1;
  }
  const shownTo = start - 1 + shown.length;
  const notes = [
    clippedLines ? `${clippedLines} very long lines held back by the ${READ_CHARS}-char cap` : "",
    total - shownTo > 0 ? `${total - shownTo} more lines — call again with offset=${shownTo + 1}` : "",
  ].filter(Boolean).join("; ");
  return `${path} lines ${start}-${shownTo} of ${total}${notes ? ` (${notes})` : ""}\n${shown.join("\n")}`;
}

function assertUnprotected(action: string, command: string): void {
  if (commandTouchesProtectedPath(command)) {
    throw new LatchDeniedError(action, "the command touches a protected path (/.vault, .env)");
  }
}
