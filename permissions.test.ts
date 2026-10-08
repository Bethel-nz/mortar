import { expect, test } from "bun:test";
import { commandTouchesProtectedPath, fsDeny } from "./permissions.ts";

test("fsDeny covers every path latch.yaml denies, including /** roots", () => {
  expect(fsDeny("/.env")).toBe(true);
  expect(fsDeny("/app/prod.env")).toBe(true);
  expect(fsDeny("/.env.local")).toBe(true);
  expect(fsDeny("/app/.env.production")).toBe(true);
  expect(fsDeny("/.vault")).toBe(true);
  expect(fsDeny("/.vault/key")).toBe(true);
});

test("fsDeny leaves ordinary paths alone", () => {
  expect(fsDeny("/src/env.ts")).toBe(false);
  expect(fsDeny("/.envrc")).toBe(false);
  expect(fsDeny("/vault/notes.md")).toBe(false);
});

test("commandTouchesProtectedPath flags .env variants but not .envrc", () => {
  expect(commandTouchesProtectedPath("cat .env.local")).toBe(true);
  expect(commandTouchesProtectedPath("cat /app/.env.production")).toBe(true);
  expect(commandTouchesProtectedPath("cat .envrc")).toBe(false);
});
