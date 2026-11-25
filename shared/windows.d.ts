export type SearchWindowId = "4h" | "24h" | "3d" | "7d" | "30d";

export type SearchWindow = {
  id: SearchWindowId;
  hours: number;
  label: string;
};

/** The time ladder: the only scope control. */
export const windows: readonly SearchWindow[];

export const defaultWindow: SearchWindowId;

export function findWindow(id: string): SearchWindow | null;

/** "last 4 hours, last 24 hours, …": the sentence form a validation message uses. */
export function windowChoices(): string;
