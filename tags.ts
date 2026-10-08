/**
 * @path file tags in user messages. A tag attaches the file's current
 * contents (or a directory listing) to the message, so the model does not
 * need a read_file call. suggestTags feeds the live @ menu (mention-menu.ts).
 */
import type { MongoFs } from "@vyr-e/mongo-vfs";

const MAX_CHARS = 50_000;
// An @ at the start or after whitespace, so emails like a@b.com are not tags.
const TAG = /(^|\s)@(\S+)/g;

export interface TagSource {
  fs: MongoFs;
  /** May the model see this path? Protected paths must say no. */
  canRead: (path: string) => boolean;
}

export type TagResult =
  | { path: string; kind: "file"; lines: number; truncated: boolean }
  | { path: string; kind: "binary"; bytes: number }
  | { path: string; kind: "dir"; entries: number }
  | { path: string; kind: "denied" }
  | { tag: string; kind: "missing" };

/** Expand @tags into attached file blocks. The user's text itself is left as typed. */
export async function expandTags(text: string, source: TagSource): Promise<{ content: string; tags: TagResult[] }> {
  const tags: TagResult[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const [, , raw] of text.matchAll(TAG)) {
    const path = (await resolveTag(raw, source.fs))?.path;
    if (!path) {
      tags.push({ tag: raw, kind: "missing" });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!source.canRead(path)) {
      tags.push({ path, kind: "denied" });
      continue;
    }

    const stat = await source.fs.stat(path);
    if (stat.isDirectory) {
      const entries = await source.fs.readdirWithFileTypes(path);
      const listing = entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name)).join("\n");
      blocks.push(`<directory path="${path}">\n${listing}\n</directory>`);
      tags.push({ path, kind: "dir", entries: entries.length });
      continue;
    }

    const bytes = await source.fs.readFileBuffer(path);
    if (bytes.subarray(0, 8000).includes(0)) {
      blocks.push(`<file path="${path}" binary="true" bytes="${bytes.length}" />`);
      tags.push({ path, kind: "binary", bytes: bytes.length });
      continue;
    }
    const body = new TextDecoder().decode(bytes);
    const truncated = body.length > MAX_CHARS;
    const shown = truncated ? `${body.slice(0, MAX_CHARS)}\n… truncated, ${body.length - MAX_CHARS} more chars; read_file for the rest` : body;
    blocks.push(`<file path="${path}">\n${shown}\n</file>`);
    tags.push({ path, kind: "file", lines: body.split("\n").length, truncated });
  }

  const content = blocks.length ? `${text}\n\n<tagged-files>\n${blocks.join("\n")}\n</tagged-files>` : text;
  return { content, tags };
}

/**
 * Suggestions for a partial @tag. Path-segment completions come first
 * (`he` → `hello/`, `hello/` → its children), then files whose path contains
 * the text anywhere (`main` → `hello/main.py`). Directories end in "/".
 */
export function suggestTags(source: TagSource, partial: string): string[] {
  const prefix = partial.replace(/^\.?\//, "");
  const lower = prefix.toLowerCase();
  const paths = source.fs.getAllPaths().filter((p) => p !== "/" && source.canRead(p));
  // the menu redraws on every keystroke, so directories are inferred from children, synchronously
  const dirs = new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))));
  const segment = new Set<string>();
  const anywhere = new Set<string>();

  for (const abs of paths) {
    const rel = abs.slice(1);
    if (rel.toLowerCase().startsWith(lower)) {
      const slash = rel.indexOf("/", prefix.length);
      segment.add(slash !== -1 ? rel.slice(0, slash + 1) : dirs.has(abs) ? `${rel}/` : rel);
    } else if (lower && !dirs.has(abs) && rel.toLowerCase().includes(lower)) {
      anywhere.add(rel);
    }
  }
  const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  return [...[...segment].sort(), ...[...anywhere].sort(byLength)];
}

/** Replace each @tag that names a workspace path with that path, for `!` shell commands. */
export async function tagsToPaths(command: string, fs: MongoFs): Promise<string> {
  let result = "";
  let last = 0;
  for (const match of command.matchAll(TAG)) {
    const resolved = await resolveTag(match[2], fs);
    if (!resolved) continue;
    const at = match.index + match[1].length;
    result += command.slice(last, at) + resolved.path;
    last = at + 1 + resolved.matched.length; // trailing punctuation stays, e.g. `@a.py;`
  }
  return result + command.slice(last);
}

/**
 * Workspace path for a tag, or null, plus the part of the tag that matched.
 * Trailing punctuation ("see @a.py,") is tried both ways.
 */
async function resolveTag(raw: string, fs: MongoFs): Promise<{ path: string; matched: string } | null> {
  for (const candidate of [raw, raw.replace(/[.,;:!?)\]'"]+$/, "")]) {
    const path = `/${candidate.replace(/^\.?\/+/, "")}`.replace(/\/+$/, "") || "/";
    if (candidate && (await fs.exists(path))) return { path, matched: candidate };
  }
  return null;
}
