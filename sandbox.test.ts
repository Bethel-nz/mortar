/**
 * Sync tests for SandboxRunner against the real latch policy and a real
 * MongoFs workspace. @vercel/sandbox is replaced by a fake whose
 * /vercel/workspace is a local temp dir, so this runs without Vercel credentials.
 *
 *   bun test sandbox.test.ts      (needs mongod on 127.0.0.1:27017)
 */
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGate, loadPolicy } from "@vyr-e/latch";
import { MongoFs } from "@vyr-e/mongo-vfs";

const dir = await mkdtemp(join(tmpdir(), "mortar-sandbox-"));
const local = (path: string) => path.replace(/^\/vercel\/workspace/, dir);

const fake = {
  async runCommand(cmdOrParams: string | { cmd: string; args?: string[]; cwd?: string }, positional?: string[]) {
    const params = typeof cmdOrParams === "string" ? { cmd: cmdOrParams, args: positional } : cmdOrParams;
    const proc = Bun.spawn([params.cmd, ...(params.args ?? []).map(local)], {
      cwd: local(params.cwd ?? "/vercel/workspace"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout: async () => stdout, stderr: async () => stderr };
  },
  async writeFiles(files: { path: string; content: Uint8Array }[]) {
    for (const file of files) {
      await mkdir(dirname(local(file.path)), { recursive: true });
      await writeFile(local(file.path), file.content);
    }
  },
  async readFileToBuffer({ path }: { path: string }) {
    return existsSync(local(path)) ? readFile(local(path)) : null;
  },
  async stop() {},
};
mock.module("@vercel/sandbox", () => ({ Sandbox: { getOrCreate: async () => fake } }));

const { SandboxRunner } = await import("./sandbox.ts");
const { policy } = loadPolicy(new URL("./latch.yaml", import.meta.url).pathname);
const gate = createGate({ policy });
const fs = await MongoFs.open("mongodb://127.0.0.1:27017", { db: "vfs", workspace: "mortar-sandbox-test" });
const runner = new SandboxRunner({
  fs,
  name: "test",
  canPush: (path) => gate.check("fs.read", { path }).effect === "allow",
  canPull: (path) => gate.check("fs.write", { path }).effect === "allow",
});

afterAll(async () => {
  await runner.close();
  await budgeted.close();
  await fs.destroy();
});

test("pushes the workspace and writes command output back as files", async () => {
  await fs.writeFile("/src/a.txt", "hello\n");
  const result = await runner.run("mkdir -p out && tr a-z A-Z < src/a.txt > out/upper.txt && echo done");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done\n");
  expect(result.written).toEqual(["/out/upper.txt"]);
  expect(await fs.readFile("/out/upper.txt")).toBe("HELLO\n");
});

test("sees VFS edits made between runs", async () => {
  await fs.searchReplace("/src/a.txt", "hello", "bye");
  const result = await runner.run("cat src/a.txt");
  expect(result.stdout).toBe("bye\n");
  expect(result.written).toEqual([]);
});

test("runs in a workspace subdirectory", async () => {
  const result = await runner.run("pwd && echo x > here.txt", { cwd: "/src" });
  expect(result.stdout.trim()).toEndWith("/src");
  expect(result.written).toEqual(["/src/here.txt"]);
});

test("keeps dependency dirs in the VM", async () => {
  const result = await runner.run("mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js");
  expect(result.written).toEqual([]);
  expect(await fs.exists("/node_modules/pkg/index.js")).toBe(false);
});

test("never pushes or pulls protected paths", async () => {
  await fs.writeFile("/.env", "SECRET=1\n");
  const pushed = await runner.run("cat .env");
  expect(pushed.exitCode).not.toBe(0);

  const pulled = await runner.run("echo LEAK=1 > app.env && mkdir -p .vault && echo k > .vault/key");
  expect(pulled.written).toEqual([]);
  expect(await fs.readFile("/.env")).toBe("SECRET=1\n");
  expect(await fs.exists("/app.env")).toBe(false);
  expect(await fs.exists("/.vault/key")).toBe(false);
});

test("reports deletions without propagating them, then restores the file", async () => {
  const deleted = await runner.run("rm src/a.txt");
  expect(deleted.deletedInSandbox).toEqual(["/src/a.txt"]);
  expect(await fs.exists("/src/a.txt")).toBe(true);

  const restored = await runner.run("cat src/a.txt");
  expect(restored.stdout).toBe("bye\n");
});

test("removes VM files the workspace does not have", async () => {
  await writeFile(join(dir, "stray.txt"), "stray\n");
  const result = await runner.run("test -e stray.txt && echo present || echo gone");
  expect(result.stdout).toBe("gone\n");
});

test("pulls binary output byte for byte", async () => {
  const result = await runner.run("printf '\\x00\\xff\\x10' > blob.bin");
  expect(result.written).toEqual(["/blob.bin"]);
  expect([...(await fs.readFileBuffer("/blob.bin"))]).toEqual([0, 255, 16]);
});

// A tight budget so a few files stand in for a build's output.
const budgeted = new SandboxRunner({
  fs,
  name: "test",
  canPush: (path) => gate.check("fs.read", { path }).effect === "allow",
  canPull: (path) => gate.check("fs.write", { path }).effect === "allow",
  maxPullFiles: 3,
  maxPullBytes: 1000,
});

test("drops the whole write-back when a run changes too many files", async () => {
  const result = await budgeted.run("mkdir -p gen && for i in 1 2 3 4; do echo $i > gen/$i.txt; done");
  expect(result.written).toEqual([]);
  expect(result.refused.sort()).toEqual(["/gen/1.txt", "/gen/2.txt", "/gen/3.txt", "/gen/4.txt"]);
  expect(result.discarded).toContain("4 files");
  expect(await fs.exists("/gen/1.txt")).toBe(false);

  // The VM persists, so discarded output must not linger there either.
  const next = await budgeted.run("ls gen 2>/dev/null | wc -l");
  expect(next.stdout.trim()).toBe("0");
});

test("drops the whole write-back when output exceeds the byte budget", async () => {
  const result = await budgeted.run("echo x > small.txt && head -c 2000 /dev/zero > big.bin");
  expect(result.written).toEqual([]);
  expect(result.discarded).toContain("bytes");
  expect(await fs.exists("/small.txt")).toBe(false);
  expect(await fs.exists("/big.bin")).toBe(false);
});

test("writes back output within budget", async () => {
  const result = await budgeted.run("echo ok > within.txt");
  expect(result.written).toEqual(["/within.txt"]);
  expect(result.discarded).toBeUndefined();
});

test("keeps build output dirs in the VM", async () => {
  const result = await runner.run("mkdir -p dist .output && echo x > dist/a.js && echo y > .output/b.js");
  expect(result.written).toEqual([]);
  expect(await fs.exists("/dist/a.js")).toBe(false);
});
