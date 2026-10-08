/**
 * Terminal rendering for mortar. Inline and scrollback-friendly: no full-screen
 * mode. Uses the 16 ANSI colors so the user's theme decides the palette, and
 * drops all escapes when NO_COLOR is set or stdout is not a terminal.
 */

import type { TagResult } from "./tags.ts";

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const sgr = (open: number, close: number) => (text: string) => (tty ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
};

const out = (text: string) => process.stdout.write(text);

export const PROMPT = `${c.magenta("›")} `;

export function banner(): void {
  out(`\n${c.bold(c.magenta("mortar"))}\n`);
  out(`${c.dim("ctrl-c to exit")}\n\n`);
}

/** Braille spinner on its own line. Waits 200ms so fast steps never flash it. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private delay: ReturnType<typeof setTimeout> | undefined;
  private shown = false;

  start(label: string): void {
    this.stop();
    if (!tty) return;
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    let i = 0;
    this.delay = setTimeout(() => {
      this.shown = true;
      this.timer = setInterval(() => out(`\r  ${c.magenta(frames[i++ % frames.length])} ${c.dim(label)}`), 80);
    }, 200);
  }

  stop(): void {
    clearTimeout(this.delay);
    clearInterval(this.timer);
    if (this.shown) out("\r\x1b[2K");
    this.shown = false;
  }
}

/**
 * Streams model text a line at a time with light markdown: headings, bullets,
 * **bold**, `code`, and fenced blocks. Blank-line runs collapse to one, and
 * leading or trailing blanks around tool calls are dropped.
 */
export class TextRenderer {
  private line = "";
  private inFence = false;
  private wroteAny = false;
  private blank = false;

  write(delta: string): void {
    const parts = (this.line + delta).split("\n");
    this.line = parts.pop() ?? "";
    for (const part of parts) this.emit(part);
  }

  /** Flush the partial line. True when this block printed anything. */
  end(): boolean {
    if (this.line) this.emit(this.line);
    const wrote = this.wroteAny;
    this.line = "";
    this.inFence = false;
    this.wroteAny = false;
    this.blank = false;
    return wrote;
  }

  private emit(raw: string): void {
    if (!raw.trim() && !this.inFence) {
      this.blank = this.wroteAny;
      return;
    }
    if (this.blank) out("\n");
    this.blank = false;
    this.wroteAny = true;

    if (raw.trimStart().startsWith("```")) {
      this.inFence = !this.inFence;
      const lang = raw.trim().slice(3);
      out(`${c.dim(this.inFence ? `┌ ${lang}`.trimEnd() : "└")}\n`);
      return;
    }
    if (this.inFence) {
      out(`${c.dim("│")} ${c.cyan(raw)}\n`);
      return;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out(`${c.bold(inline(heading[1]))}\n`);
      return;
    }
    out(`${inline(raw.replace(/^(\s*)[-*]\s+/, `$1${c.dim("•")} `))}\n`);
  }
}

function inline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_, code) => c.cyan(code)).replace(/\*\*([^*]+)\*\*/g, (_, b) => c.bold(b));
}

type ToolInput = Record<string, unknown>;

/** The one-line headline for a call: tool name plus its key argument. */
export function describeCall(tool: string, input: ToolInput): string {
  const arg = String(input.command ?? input.path ?? "");
  const cwd = input.cwd && input.cwd !== "/" ? c.dim(` in ${input.cwd}`) : "";
  return `${c.bold(tool)}  ${oneLine(arg, 70)}${cwd}`;
}

export function toolResult(tool: string, input: ToolInput, output: unknown): void {
  const { meta, preview, ok } = summarize(tool, output);
  out(`  ${ok ? c.green("✓") : c.red("✗")} ${describeCall(tool, input)}${meta ? c.dim(`  · ${meta}`) : ""}\n`);
  for (const line of preview) out(`    ${c.dim("│")} ${ok ? c.dim(line) : c.red(line)}\n`);
}

export function toolError(tool: string, input: ToolInput, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  const denied = error instanceof Error && /Latch/.test(error.name);
  const mark = denied ? c.yellow("⊘") : c.red("✗");
  out(`  ${mark} ${describeCall(tool, input)}\n    ${c.dim("│")} ${denied ? c.yellow(message) : c.red(message)}\n`);
}

/** The y/N question latch asks before an approval-gated call. */
export function approvalQuestion(tool: string, input: ToolInput): string {
  return `  ${c.yellow("?")} ${describeCall(tool, input)}  ${c.yellow("allow?")} ${c.dim("[y/N]")} `;
}

/** One line per @tag under the user's message: what was attached, refused, or not found. */
export function tagResults(tags: TagResult[]): void {
  for (const tag of tags) {
    if (tag.kind === "missing") {
      out(`  ${c.dim(`? @${tag.tag} is not in the workspace`)}\n`);
    } else if (tag.kind === "denied") {
      out(`  ${c.yellow("⊘")} ${c.bold(tag.path)}  ${c.yellow("blocked by latch")}\n`);
    } else {
      const meta =
        tag.kind === "dir" ? `${tag.entries} entries`
        : tag.kind === "binary" ? `binary, ${tag.bytes} bytes`
        : `${tag.lines} lines${tag.truncated ? ", truncated" : ""}`;
      out(`  ${c.magenta("@")} ${c.bold(tag.path)}${c.dim(`  · ${meta}`)}\n`);
    }
  }
}

/** Raw output of a `!command`, printed as-is so files look exactly like they are stored. */
export function shellOutput({ stdout, stderr, exitCode }: { stdout: string; stderr: string; exitCode: number }): void {
  if (stdout) out(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) out(c.red(stderr.endsWith("\n") ? stderr : `${stderr}\n`));
  if (exitCode === 127) out(c.dim("this shell only simulates file commands; ask the agent to run programs\n"));
  else if (exitCode !== 0) out(c.dim(`exit ${exitCode}\n`));
  out("\n");
}

export function notice(text: string): void {
  out(`${c.dim(text)}\n`);
}

export function failure(text: string): void {
  out(`${c.red("✗")} ${text}\n`);
}

/** Result metadata plus up to four preview lines (stdout tail, or stderr on failure). */
function summarize(tool: string, output: unknown): { meta: string; preview: string[]; ok: boolean } {
  if (typeof output === "string") {
    const n = output.split("\n").length;
    const unit = tool === "ls" ? "entr" + (n === 1 ? "y" : "ies") : "line" + (n === 1 ? "" : "s");
    return { meta: `${n} ${unit}`, preview: [], ok: true };
  }
  if (!output || typeof output !== "object") return { meta: "", preview: [], ok: true };

  const o = output as Record<string, unknown>;
  if (typeof o.exitCode === "number") {
    const ok = o.exitCode === 0;
    const stream = String((ok ? o.stdout : o.stderr || o.stdout) ?? "").trimEnd();
    const written = Array.isArray(o.written) && o.written.length ? ` · wrote ${o.written.join(" ")}` : "";
    return { meta: `exit ${o.exitCode}${written}`, preview: tail(stream, 4), ok };
  }
  if (typeof o.bytes === "number") return { meta: `${o.bytes} bytes`, preview: [], ok: true };
  if (typeof o.rev === "number") return { meta: `rev ${o.rev}`, preview: [], ok: true };
  return { meta: "", preview: [], ok: true };
}

function tail(text: string, n: number): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const shown = lines.slice(-n).map((line) => oneLine(line, 100));
  return lines.length > n ? [`… ${lines.length - n} more`, ...shown] : shown;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
