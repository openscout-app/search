export type SearchCoverage =
  | {
    kind: "recent";
    window: string;
    scannedFiles: number;
    candidates: number;
    partial?: boolean;
  }
  | { kind: "warmed"; stale?: boolean; partial?: boolean }
  | { kind: "bounded"; suggestion?: string }
  | { kind: "index_off"; suggestion?: string }
  | { kind: "empty_index" | "not_warmed"; suggestion?: string };

export type CoverageCopyOptions = {
  /** Command that indexes a window, printed when the window is not indexed. */
  indexCommand?: string;
};

export function coverageNote(
  coverage: SearchCoverage,
  options?: CoverageCopyOptions,
): string;
