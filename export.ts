/**
 * Materialize the workspace as real files on disk — read straight from
 * MongoDB, no model, no sandbox.
 *
 *   bun export.ts <dir>      write every workspace file under <dir>
 *
 * Protected paths (/.vault, .env) are skipped, same as the latch policy.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createGate, loadPolicy } from "@vyr-e/latch";
import { MongoFs } from "@vyr-e/mongo-vfs";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun export.ts <dir>");
  process.exit(1);
}

const { policy } = loadPolicy(new URL("./latch.yaml", import.meta.url).pathname);
const gate = createGate({ policy });
const fs = await MongoFs.open("mongodb://127.0.0.1:27017", { db: "vfs", workspace: "mortar" });

let count = 0;
for (const path of fs.getAllPaths().sort()) {
  if (gate.check("fs.read", { path }).effect !== "allow") continue;
  if (!(await fs.lstat(path)).isFile) continue;
  const out = join(resolve(target), path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await fs.readFileBuffer(path));
  count++;
}

console.log(`${count} file(s) from workspace "mortar" written to ${resolve(target)}`);
await fs.close();
