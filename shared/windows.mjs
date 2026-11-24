// The search window is the only scope control: no free-form hour counts and
// no separate file or result caps. Server, CLI and page read this list.
export const windows = [
  { id: "4h", hours: 4, label: "Last 4 hours" },
  { id: "24h", hours: 24, label: "Last 24 hours" },
  { id: "3d", hours: 72, label: "Last 3 days" },
  { id: "7d", hours: 168, label: "Last 7 days" },
  { id: "30d", hours: 720, label: "Last 30 days" },
];

export const defaultWindow = "3d";

export function findWindow(id) {
  return windows.find((entry) => entry.id === id) ?? null;
}

export function windowChoices() {
  return windows.map((entry) => entry.label.toLowerCase()).join(", ");
}
