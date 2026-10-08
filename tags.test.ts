/**
 * @tag expansion and completion against a real MongoFs workspace and the
 * real latch policy.
 *
 *   bun test tags.test.ts      (needs mongod on 127.0.0.1:27017)
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createGate, loadPolicy } from "@vyr-e/latch";
import { MongoFs } from "@vyr-e/mongo-vfs";
import { expandTags, suggestTags, tagsToPaths } from "./tags.ts";

const gate = createGate({ policy: loadPolicy(new URL("./latch.yaml", import.meta.url).pathname).policy });
const fs = await MongoFs.open("mongodb://127.0.0.1:27017", { db: "vfs", workspace: "mortar-tags-test" });
const source = { fs, canRead: (path: string) => gate.check("fs.read", { path }).effect === "allow" };

beforeAll(async () => {
  await fs.writeFile("/hello/main.py", 'print("hi")\n');
  await fs.writeFile("/hello/out.txt", "hi\n");
  await fs.writeFile("/help.md", "# help\n");
  await fs.writeFile("/.env", "SECRET=1\n");
  await fs.writeFile("/blob.bin", new Uint8Array([0, 1, 2]));
});
afterAll(() => fs.destroy());

test("attaches a tagged file and keeps the typed text", async () => {
  const { content, tags } = await expandTags("explain @hello/main.py please", source);
  expect(content.startsWith("explain @hello/main.py please\n\n<tagged-files>")).toBe(true);
  expect(content).toContain('<file path="/hello/main.py">\nprint("hi")\n\n</file>');
  expect(tags).toEqual([{ path: "/hello/main.py", kind: "file", lines: 2, truncated: false }]);
});

test("accepts absolute tags, strips trailing punctuation, and dedupes", async () => {
  const { tags } = await expandTags("compare @/hello/main.py, and @hello/main.py.", source);
  expect(tags).toEqual([{ path: "/hello/main.py", kind: "file", lines: 2, truncated: false }]);
});

test("lists a tagged directory", async () => {
  const { content, tags } = await expandTags("what is in @hello/", source);
  expect(content).toContain('<directory path="/hello">\nmain.py\nout.txt\n</directory>');
  expect(tags).toEqual([{ path: "/hello", kind: "dir", entries: 2 }]);
});

test("refuses protected paths without attaching them", async () => {
  const { content, tags } = await expandTags("read @.env", source);
  expect(content).toBe("read @.env");
  expect(tags).toEqual([{ path: "/.env", kind: "denied" }]);
});

test("reports missing tags and ignores emails", async () => {
  const { content, tags } = await expandTags("mail me@example.com about @nope.py", source);
  expect(content).toBe("mail me@example.com about @nope.py");
  expect(tags).toEqual([{ tag: "nope.py", kind: "missing" }]);
});

test("marks binary files instead of inlining them", async () => {
  const { content, tags } = await expandTags("@blob.bin", source);
  expect(content).toContain('<file path="/blob.bin" binary="true" bytes="3" />');
  expect(tags).toEqual([{ path: "/blob.bin", kind: "binary", bytes: 3 }]);
});

test("suggests path segments first, then matches anywhere, never protected paths", () => {
  expect(suggestTags(source, "")).toEqual(["blob.bin", "hello/", "help.md"]);
  expect(suggestTags(source, "he")).toEqual(["hello/", "help.md"]);
  expect(suggestTags(source, "hello/")).toEqual(["hello/main.py", "hello/out.txt"]);
  expect(suggestTags(source, "main")).toEqual(["hello/main.py"]);
  expect(suggestTags(source, "/HEL")).toEqual(["hello/", "help.md"]);
  expect(suggestTags(source, ".e")).toEqual([]);
});

test("turns tags into plain paths for shell commands, leaving unknown ones alone", async () => {
  expect(await tagsToPaths("cat @hello/main.py @/help.md", fs)).toBe("cat /hello/main.py /help.md");
  expect(await tagsToPaths("ls @hello/ && echo a@b @nope", fs)).toBe("ls /hello && echo a@b @nope");
  expect(await tagsToPaths("cat @.env", fs)).toBe("cat /.env");
});
