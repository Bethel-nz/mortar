# mortar

A workspace for a coding agent. The agent gets a filesystem in MongoDB, a shell, and a VM to run
code in, and is free to work inside them. One policy file sets the limits.

- **Vercel AI SDK** (`streamText` + tools) runs the loop.
- **[@vyr-e/mongo-vfs](https://www.npmjs.com/package/@vyr-e/mongo-vfs)** is the filesystem. Bash
  explores; `search_replace` and `apply_patch` edit by sending only what changed.
- **[@vyr-e/latch](https://www.npmjs.com/package/@vyr-e/latch)** decides which tool calls run.
  `latch.yaml` drives both the runtime gate and the permissions section of the system prompt.
- **[Vercel Sandbox](https://vercel.com/docs/sandbox)** runs real code in a microVM that mirrors
  the workspace. Files a command creates or changes are written back to MongoDB.

## Run

Needs MongoDB on `127.0.0.1:27017`.

```sh
bun install
cp .env.example .env    # set META_API_KEY
bun agent.ts            # optional first arg: model id
```

The `run` tool needs Vercel credentials: `bunx vercel link && bunx vercel env pull` (the token
lasts about 12 hours). `.env.example` lists the access-token alternative.

In the prompt, `@path` attaches a file or directory listing to your message, and `@` alone opens a
picker. `!command` runs a command in the workspace shell yourself, with no model and no approval.
`AUTO_APPROVE=1` skips approval prompts.

## Policy

`latch.yaml` lets the agent read and edit freely, asks before every `bash` and `run` call, denies
deletes, and blocks `/.vault/**` and `.env` files on every tool. The same path list is enforced
inside MongoFs, and only files the policy allows are copied into or out of the VM. Deletes in the
VM never reach MongoDB.

```sh
bunx latch validate
bun test                # needs MongoDB; uses a fake VM, no Vercel credentials
bun export.ts ./out     # copy the workspace to disk, protected paths skipped
```
