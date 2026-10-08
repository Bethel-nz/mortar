/**
 * Ground truth: inspect the workspace directly from MongoDB — no model, no
 * agent loop. Use this to check whether what mortar claimed is actually true.
 *
 *   bun verify.ts            dump every path with kind, size, and rev
 *   bun verify.ts <path>     one path: existence, stat, and full content
 *
 * Exit 1 when an explicitly asked-for path does not exist.
 */
import { MongoFs } from "@vyr-e/mongo-vfs";

const target = process.argv[2];
const fs = await MongoFs.open("mongodb://127.0.0.1:27017", { db: "vfs", workspace: "mortar" });

if (!target) {
  const paths = fs.getAllPaths().sort();
  for (const path of paths) {
    const stat = await fs.stat(path);
    const rev = await fs.revision(path);
    const kind = stat.isDirectory ? "dir " : stat.isSymbolicLink ? "link" : "file";
    console.log(`${kind} ${String(stat.size).padStart(7)}  rev ${String(rev).padStart(4)}  ${path}`);
  }
  console.log(`\n${paths.length} path(s) in workspace "mortar" — read from MongoDB, not from the agent`);
} else {
  if (!(await fs.exists(target))) {
    console.log(`${target}: DOES NOT EXIST`);
    await fs.close();
    process.exit(1);
  }
  const stat = await fs.stat(target);
  const rev = await fs.revision(target);
  const kind = stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file";
  console.log(`${target} — exists: ${kind}, ${stat.size} bytes, rev ${rev}, modified ${stat.mtime?.toISOString()}`);
  if (stat.isFile) console.log(`\n${await fs.readFile(target)}`);
}

await fs.close();
