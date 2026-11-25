import type { ReactElement, ReactNode } from "react";
import type { CoverageCopyOptions, SearchCoverage } from "./coverage.js";
import type { PassageGroup } from "./passages.jsx";

export type SearchMode = "recent" | "index";

export type SearchScope = {
  mode: SearchMode;
  /** Empty means every harness. */
  harness: string;
  window: string;
};

export type Choice<T extends string> = { value: T; label: string };

export type SearchStatus = "initial" | "pending" | "error" | "ready";

export type SearchSurfaceProps = {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  scope: SearchScope;
  onScopeChange: (next: SearchScope) => void;
  harnesses?: readonly Choice<string>[];
  modes?: readonly Choice<SearchMode>[];
  windowChoices?: readonly Choice<string>[];
  status: SearchStatus;
  error?: string | null;
  /** One line under the scope controls, about the source itself. */
  note?: string | null;
  masthead?: ReactNode;
  groups: readonly PassageGroup[];
  selectedId?: string | null;
  coverage?: SearchCoverage | null;
  coverageOptions?: CoverageCopyOptions;
  /** Page token for the next page, or null when the page was the last one. */
  next?: string | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  moreError?: string | null;
  emptyTitle?: string;
  emptyMessage?: string;
  heading?: string;
  /** The words the current results were found with, for highlighting. */
  highlightQuery?: string;
};

/**
 * The search interface, composed from its parts. Data and callbacks come in;
 * nothing here knows about a router, a fetch layer or an app's store.
 */
export function SearchSurface(props: SearchSurfaceProps): ReactElement;

export const searchModes: readonly Choice<SearchMode>[];
export const searchHarnesses: readonly Choice<string>[];
export const searchWindowOptions: readonly Choice<string>[];

/** The label a window step takes in copy. */
export function windowLabel(id: string): string;
