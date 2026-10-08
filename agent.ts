#!/usr/bin/env bun
import { createOpenAI } from "@ai-sdk/openai";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import { Bash } from "just-bash";
import { createInterface } from "node:readline/promises";
import { MongoFs, mongoBashDefense } from "@vyr-e/mongo-vfs";
import { attachMentionMenu } from "./mention-menu.ts";
import { commandTouchesProtectedPath, createPermissions, fsDeny, permissionsPrompt, toolName } from "./permissions.ts";
import { SandboxRunner } from "./sandbox.ts";
import { expandTags, suggestTags, tagsToPaths } from "./tags.ts";
import { createTools } from "./tools.ts";
import * as ui from "./ui.ts";

const DEFAULT_MODEL = "muse-spark-1.3-contributor";
const MONGO_URI = "mongodb://127.0.0.1:27017";
const WORKSPACE = "mortar";
const MAX_STEPS = 40;

const apiKey = process.env.META_API_KEY;
if (!apiKey) {
  ui.failure("META_API_KEY is not set — put your Meta API key in mortar/.env");
  process.exit(1);
}

const spinner = new ui.Spinner();
const turn = {
  text: new ui.TextRenderer(),
  last: "none" as "none" | "text" | "tools",
  beginText() {
    if (this.last === "tools") process.stdout.write("\n");
    this.last = "text";
  },
  beginTools() {
    if (this.last === "tools") return;
    if (this.text.end()) process.stdout.write("\n");
    this.last = "tools";
  },
  end() {
    this.text.end();
    this.last = "none";
  },
};

let asking = false;

async function onApproval({ action, input }: { action: string; input: unknown }): Promise<boolean> {
  if (process.env.AUTO_APPROVE) return true;
  asking = true;
  spinner.stop();
  turn.beginTools();
  const answer = await rl.question(ui.approvalQuestion(toolName(action), input as Record<string, unknown>));
  asking = false;
  return answer.trim().toLowerCase() === "y";
}

const { gate, canRead, canWrite } = createPermissions(onApproval);

const fs = await MongoFs.open(MONGO_URI, { db: "vfs", workspace: WORKSPACE, deny: fsDeny });
const bash = new Bash({ fs, cwd: "/", defenseInDepth: mongoBashDefense });
const sandbox = new SandboxRunner({ fs, name: `mortar-${WORKSPACE}`, canPush: canRead, canPull: canWrite });
const tools = createTools({ fs, bash, sandbox, gate });
const tagSource = { fs, canRead };

const model = createOpenAI({ baseURL: "https://api.meta.ai/v1", apiKey }).responses(
  process.argv[2] ?? process.env.MORTAR_MODEL ?? DEFAULT_MODEL,
);

const system = [
  `You are mortar, a coding agent working inside a MongoDB-backed virtual filesystem mounted at /.`,
  `Use tools only when the request needs them. Answer greetings, small talk, and general questions directly, without looking at the workspace.`,
  `The workspace may already hold files. Look at them only when the task is about them; don't explore up front.`,
  `Prefer search_replace over write_file for edits — it sends only the changed bytes.`,
  `bash is a simulated shell over the VFS: good for ls, cat, grep, but it cannot run programs. Use run to execute code, install packages, or run tests in a real Linux VM; its file changes land back in the workspace.`,
  `Inside run, the workspace root is the working directory, not /. Use relative paths there: python3 hello/main.py, not python3 /hello/main.py.`,
  `The user can tag files as @path. Tagged files arrive inline in <tagged-files> blocks, current as of that message, so don't re-read them unless they may have changed.`,
  "",
  permissionsPrompt,
].join("\n");

const messages: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });
attachMentionMenu(rl, (partial) => suggestTags(tagSource, partial));

let stdinClosed = false;
let busy = false;
rl.on("close", () => {
  stdinClosed = true;
  setImmediate(() => busy || void shutdown());
});

ui.banner();

for (;;) {
  let input: string;
  try {
    input = await rl.question(ui.PROMPT);
  } catch {
    break;
  }
  if (!input.trim()) continue;

  busy = true;
  if (input.trimStart().startsWith("!")) await shellCommand(input.trimStart().slice(1).trim());
  else await agentTurn(input);
  busy = false;
  if (stdinClosed) break;
}
await shutdown();

async function agentTurn(input: string): Promise<void> {
  let printed = false;
  try {
    const { content, tags } = await expandTags(input, tagSource);
    ui.tagResults(tags);
    messages.push({ role: "user", content });
    process.stdout.write("\n");
    spinner.start("thinking");

    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      providerOptions: { openai: { forceReasoning: true, reasoningEffort: "medium", systemMessageMode: "system" } },
      onError: () => {},
    });

    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        spinner.stop();
        printed ||= part.text.trim() !== "";
        turn.beginText();
        turn.text.write(part.text);
      } else if (part.type === "tool-call") {
        turn.beginTools();
        if (!asking) spinner.start(`running ${part.toolName}`);
      } else if (part.type === "tool-result" || part.type === "tool-error") {
        spinner.stop();
        printed = true;
        turn.beginTools();
        const toolInput = part.input as Record<string, unknown>;
        if (part.type === "tool-result") ui.toolResult(part.toolName, toolInput, part.output);
        else ui.toolError(part.toolName, toolInput, part.error);
        spinner.start("thinking");
      } else if (part.type === "error") {
        spinner.stop();
        printed = true;
        turn.end();
        ui.failure(firstLine(part.error));
      }
    }
    spinner.stop();
    turn.end();
    messages.push(...(await result.responseMessages));
    if (!printed) ui.notice("(the model returned an empty response — send it again)");
  } catch (error) {
    spinner.stop();
    turn.end();
    if (!printed) ui.failure(firstLine(error));
  }
  process.stdout.write("\n");
}

async function shellCommand(typed: string): Promise<void> {
  if (!typed) return;
  const command = await tagsToPaths(typed, fs);
  if (commandTouchesProtectedPath(command)) {
    ui.failure("that command touches a protected path (/.vault, .env)");
    return;
  }
  try {
    const result = await bash.exec(command);
    ui.shellOutput(result);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 20_000);
    messages.push({
      role: "user",
      content: `I ran \`${command}\` in the workspace shell (exit ${result.exitCode}):\n\`\`\`\n${output}\n\`\`\``,
    });
  } catch (error) {
    ui.failure(firstLine(error));
  }
}

async function shutdown(): Promise<never> {
  spinner.stop();
  await sandbox.close();
  await fs.close();
  process.exit(0);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
