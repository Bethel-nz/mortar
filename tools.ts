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
      description: "Read a text file from the workspace.",
      inputSchema: z.object({ path: z.string().describe("Absolute file path, e.g. /src/main.py") }),
      async execute({ path }) {
        return fs.readFile(path);
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

  const run = gate.wrap(
    "sandbox.exec",
    tool({
      description:
        "Run a real command (node, bun, python, npm, tests) in an isolated Linux VM holding a copy of the workspace. " +
        `The workspace root is the command's working directory (${VM_ROOT} in the VM), not /: use relative paths, ` +
        "so workspace file /hello/main.py is hello/main.py here. " +
        "Files the command creates or changes are written back to the workspace; node_modules, .git, and other dependency dirs stay in the VM. " +
        "Do not run builds: build output (dist, .next, .output, …) is never written back, and a run that changes more than " +
        "100 files or 1 MiB writes nothing back at all.",
      inputSchema: z.object({
        command: z.string().describe("Shell command, run with bash -lc, e.g. `npm install && npm test`"),
        cwd: z.string().optional().describe("Workspace directory to run in, e.g. /app (default /)"),
        timeout_seconds: z.number().int().positive().max(1800).optional().describe("Kill after this long (default 300)"),
      }),
      async execute({ command, cwd, timeout_seconds }) {
        assertUnprotected("sandbox.exec", command);
        return sandbox.run(command, { cwd, timeoutMs: timeout_seconds && timeout_seconds * 1000 });
      },
    }),
  );

  return { ls, read_file, write_file, search_replace, apply_patch, bash: bashTool, run };
}

function assertUnprotected(action: string, command: string): void {
  if (commandTouchesProtectedPath(command)) {
    throw new LatchDeniedError(action, "the command touches a protected path (/.vault, .env)");
  }
}
