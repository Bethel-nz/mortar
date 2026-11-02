import { type ApprovalHandler, createGate, loadPolicy, pathMatches, renderPrompt } from "@vyr-e/latch";

const { policy } = loadPolicy(new URL("./latch.yaml", import.meta.url).pathname);

const toolForAction: Record<string, string> = {
  "sandbox.exec": "run",
  "bash.exec": "bash",
  "fs.rm": "delete_file",
  "fs.mv": "move_file",
};

/**
 * Every path pattern any deny rule names — the union, deliberately coarser
 * than latch's per-action semantics, because this list is also enforced by
 * MongoFs at path-resolution time (see fsDeny below), where quoting tricks,
 * globs, and symlinks cannot survive. A `/**` pattern covers the subtree but
 * not its root, so the root is denied separately.
 */
const deniedPatterns = [
  ...new Set(
    policy.deny.flatMap((rule) => rule.constraints.paths ?? []).flatMap((pattern) => {
      const root = pattern.replace(/\/\*\*$/, "");
      return root === pattern ? [pattern] : [pattern, root];
    }),
  ),
];

/** MongoFs `deny` predicate: true means EACCES at path resolution. */
export function fsDeny(path: string): boolean {
  return deniedPatterns.some((pattern) => pathMatches(pattern, path));
}

export function createPermissions(onApproval: ApprovalHandler) {
  const gate = createGate({ policy, onApproval });
  return {
    gate,
    canRead: (path: string) => gate.check("fs.read", { path }).effect === "allow",
    canWrite: (path: string) => gate.check("fs.write", { path }).effect === "allow",
  };
}

export function toolName(action: string): string {
  return toolForAction[action] ?? action;
}

/**
 * A signpost, not a wall: catches honest attempts in command strings before
 * they reach a human approval prompt. The wall for paths is latch's deny rules
 * on structured calls plus fsDeny inside MongoFs; the wall for real execution
 * is the approval itself.
 */
export function commandTouchesProtectedPath(command: string): boolean {
  return /\/\.vault(?:\/|\s|$)|\/\.env(?:\.[^\s/"']+)?(?:\/|\s|$)|(?:^|[\s"'=])[^\s"'=]*\.env(?:\.[^\s/"']+)?(?:\/|\s|$)/.test(
    command,
  );
}

export const permissionsPrompt = [
  renderPrompt(policy, { file: "latch.yaml" }),
  "",
  `Approvals in mortar: calling an approval-gated tool is the request. The human approves or declines it in their terminal at that moment, so call the tool directly and never ask for permission in chat. A declined call is final.`,
].join("\n");
