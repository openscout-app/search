import { findWindow } from "../shared/windows.mjs";

/**
 * What the result line says about coverage. The rule: a miss must never be
 * mistaken for "this window was not searched", and a bound must say what it is.
 *
 * The copy is a pure function so the page and every surface that mounts it say
 * the same thing. The command that fixes an unwarmed window belongs to the app,
 * so it is passed in.
 */
export function coverageNote(coverage, options = {}) {
  switch (coverage.kind) {
    case "recent": {
      const label = findWindow(coverage.window)?.label.toLowerCase() ?? coverage.window;
      return (
        coverage.scannedFiles +
        " of " +
        coverage.candidates +
        (coverage.candidates === 1
          ? " transcript file read in the "
          : " transcript files read in the ") +
        label +
        "." +
        (coverage.partial ? " Results cover part of the window." : "")
      );
    }
    case "index_off":
      return (
        coverage.suggestion ??
        "Turn on Local search index in Scout Settings › System, then index the sessions you want to search."
      );
    case "empty_index":
    case "not_warmed":
      return "Index this window from a terminal, then search again." + (options.indexCommand ? "\n" + options.indexCommand : "");
    case "bounded":
      return coverage.suggestion ?? "Only retained history is indexed; evicted history is not covered.";
    case "warmed":
      if (coverage.partial) return "Results cover part of the window.";
      return coverage.stale
        ? "The index may be missing recent changes. Index this window again to refresh it."
        : "Results cover sessions in the indexed window.";
    default:
      return "Scout did not report coverage for this window.";
  }
}
