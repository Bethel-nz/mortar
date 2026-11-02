/**
 * Live @ menu under the readline prompt. Typing @ opens a list of matching
 * workspace paths that updates on every keystroke: ↑↓ select, Tab or Enter
 * insert, Esc close. Choosing a directory inserts it and lists its children.
 *
 * readline has no hook for this, so the menu wraps readline's keypress
 * listener: keys the menu uses are consumed, everything else passes through.
 */
import type { Interface } from "node:readline/promises";
import { c } from "./ui.ts";

const VISIBLE = 8;

interface Key {
  name?: string;
  ctrl?: boolean;
}

// The readline internals this relies on; all exist in Node's and Bun's readline.
type Line = Interface & {
  line: string;
  cursor: number;
  getCursorPos(): { rows: number; cols: number };
  write(data: string | null, key?: Key): void;
};

export function attachMentionMenu(
  rl: Interface,
  suggest: (partial: string) => string[],
  isActive: () => boolean = () => true,
): void {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY) return;
  const line = rl as Line;
  const readlineListeners = input.listeners("keypress") as ((s: string, k: Key) => void)[];

  let items: string[] = [];
  let selected = 0;
  let shown = 0; // menu lines currently drawn below the prompt
  let dismissed: string | null = null; // the partial Esc closed the menu on
  let last: string | null = null;

  const out = (text: string) => process.stdout.write(text);
  const column = () => line.getCursorPos().cols + 1;
  const partial = () => /(?:^|\s)@(\S*)$/.exec(line.line.slice(0, line.cursor))?.[1] ?? null;

  function clear(): void {
    if (!shown) return;
    out(`\x1b[1B\r\x1b[J\x1b[1A\x1b[${column()}G`);
    shown = 0;
  }

  function render(): void {
    const width = (process.stdout.columns || 80) - 1;
    const start = Math.max(0, Math.min(selected - VISIBLE + 1, items.length - VISIBLE));
    const rows = items.slice(start, start + VISIBLE).map((item, i) => {
      const text = item.length > width - 4 ? `${item.slice(0, width - 5)}…` : item;
      return start + i === selected ? `  ${c.magenta("›")} ${c.bold(text)}` : `    ${c.dim(text)}`;
    });
    const more = items.length - start - rows.length;
    rows.push(c.dim(`    ${more > 0 ? `… ${more} more · ` : ""}↑↓ select · tab insert · esc close`));
    // Draw below, then move back up: relative moves survive the terminal scrolling.
    out(`\r\n${rows.join("\x1b[K\r\n")}\x1b[K\x1b[J\x1b[${rows.length}A\x1b[${column()}G`);
    shown = rows.length;
  }

  function update(): void {
    const current = partial();
    if (current !== dismissed) dismissed = null;
    if (current !== last) selected = 0;
    last = current;
    items = current === null || current === dismissed ? [] : suggest(current);
    selected = Math.min(selected, Math.max(0, items.length - 1));
    if (items.length) render();
    else clear();
  }

  function accept(): void {
    const current = partial() ?? "";
    const choice = items[selected];
    for (let i = 0; i < current.length; i++) line.write(null, { name: "backspace" });
    line.write(choice.endsWith("/") ? choice : `${choice} `);
    update();
  }

  input.removeAllListeners("keypress");
  input.on("keypress", (s: string, key: Key = {}) => {
    // While another question owns the line (an approval prompt), the menu is
    // inert: every key goes straight to readline, so `@` and arrows cannot
    // hijack the y/N answer.
    if (!isActive()) {
      clear();
      items = [];
      for (const listener of readlineListeners) listener.call(input, s, key);
      return;
    }
    if (items.length) {
      if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? -1 : 1) + items.length) % items.length;
        return render();
      }
      if (key.name === "escape") {
        dismissed = partial();
        items = [];
        return clear();
      }
      // Enter on an exact file match submits instead of inserting it again.
      const exact = key.name === "return" && items[selected] === partial();
      if (key.name === "tab" || (key.name === "return" && !exact)) return accept();
    }
    // Redraws overwrite the old menu in place; only clear it when the line is about to end.
    const ending = key.name === "return" || (key.ctrl && (key.name === "c" || key.name === "d"));
    if (ending) {
      clear();
      items = [];
    }
    for (const listener of readlineListeners) listener.call(input, s, key);
    if (!ending) update();
  });
}
