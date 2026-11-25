import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWindow, findWindow, windows, windowChoices } from "../shared/windows.mjs";

test("the ladder is the five steps, ascending, with no free-form hour counts", () => {
  assert.deepEqual(windows.map((entry) => entry.id), ["4h", "24h", "3d", "7d", "30d"]);
  assert.deepEqual(windows.map((entry) => entry.hours), [4, 24, 72, 168, 720]);
  assert.equal(defaultWindow, "3d");
});

test("a step is found exactly and nothing else is a step", () => {
  assert.equal(findWindow("3d")?.hours, 72);
  assert.equal(findWindow("72"), null);
  assert.equal(findWindow("5h"), null);
});

test("the choices sentence is the labels in lower case", () => {
  assert.equal(windowChoices(), "last 4 hours, last 24 hours, last 3 days, last 7 days, last 30 days");
});
