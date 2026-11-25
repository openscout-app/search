import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageNote } from "../ui/coverage.js";

test("a recent scan says how much of the window it read, in the step's own words", () => {
  assert.equal(
    coverageNote({ kind: "recent", window: "3d", scannedFiles: 12, candidates: 40 }),
    "12 of 40 transcript files read in the last 3 days.",
  );
  assert.equal(
    coverageNote({ kind: "recent", window: "4h", scannedFiles: 1, candidates: 1 }),
    "1 of 1 transcript file read in the last 4 hours.",
  );
});

test("a partial recent scan says the results cover part of the window", () => {
  assert.match(
    coverageNote({ kind: "recent", window: "7d", scannedFiles: 300, candidates: 300, partial: true }),
    /Results cover part of the window\.$/,
  );
});

test("an unwarmed window carries the app's own index command", () => {
  assert.equal(
    coverageNote({ kind: "not_warmed" }, { indexCommand: "scout-search index --window 3d" }),
    "Index this window from a terminal, then search again.\nscout-search index --window 3d",
  );
  assert.equal(coverageNote({ kind: "empty_index" }), "Index this window from a terminal, then search again.");
});

test("warmed coverage keeps stale, partial and bounded apart", () => {
  assert.equal(coverageNote({ kind: "warmed" }), "Results cover sessions in the indexed window.");
  assert.match(coverageNote({ kind: "warmed", stale: true }), /may be missing recent changes/);
  assert.equal(coverageNote({ kind: "warmed", partial: true }), "Results cover part of the window.");
  assert.equal(coverageNote({ kind: "bounded", suggestion: "Only retained history is indexed." }), "Only retained history is indexed.");
});

test("an index that is off keeps the setting's own guidance", () => {
  assert.match(coverageNote({ kind: "index_off" }), /Local search index/);
  assert.equal(coverageNote({ kind: "index_off", suggestion: "Turn it on." }), "Turn it on.");
});
