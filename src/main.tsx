import { createRoot } from "react-dom/client";
import { ScoutThinApp, type ScoutThinStatusBase } from "scout-app/shell";
import "scout-app/shell.css";
import { SearchStandaloneSurface } from "./SearchStandaloneSurface.tsx";
import "./search.css";

export interface SearchHostStatus extends ScoutThinStatusBase {
  enabled?: boolean;
  collections?: number;
  chunks?: number;
  lastIndexedAt?: number | null;
  message?: string;
  recentTranscripts?: number;
}

createRoot(document.getElementById("root")!).render(
  <ScoutThinApp<SearchHostStatus>
    product="Search"
    variant="search"
    rail="reading"
    badge={(status) => {
      if (!status) return { label: "Scanning transcripts", tone: "loading" };
      if (status.enabled && (status.chunks ?? 0) > 0) {
        return {
          label: `Indexed · ${(status.chunks ?? 0).toLocaleString()} passages`,
          tone: "ready",
          detail: status.runtimeUrl,
        };
      }
      const count = status.recentTranscripts ?? 0;
      return {
        label: count > 0 ? `Live scan · ${count} transcripts` : "Recent transcripts",
        tone: status.runtimeUp ? "ready" : "local",
        detail: status.runtimeUp ? status.runtimeUrl : "Direct transcript search active",
      };
    }}
  >
    <SearchStandaloneSurface />
  </ScoutThinApp>,
);
