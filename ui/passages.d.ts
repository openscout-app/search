import type { ReactElement, ReactNode } from "react";

export interface Passage {
  id: string;
  text: string;
  title?: string;
  metadata?: ReactNode;
  reference?: ReadonlyArray<{ label: string; value: string }>;
  onSelect?: () => void;
  onOpen?: () => void;
}

export interface PassageGroup {
  id: string;
  label?: string;
  header: ReactNode;
  passages: readonly Passage[];
}

export function PassageList(props: {
  groups: readonly PassageGroup[];
  query: string;
  selectedId?: string | null;
  busy?: boolean;
  highlight?: (text: string, query: string) => ReadonlyArray<{ text: string; match: boolean }>;
  className?: string;
}): ReactElement;
