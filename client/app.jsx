import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { pageSize } from "../shared/pages.mjs";
import { defaultWindow } from "../shared/windows.mjs";
import { SearchSurface } from "../ui/surface.jsx";

const harnessNames = { claude: "Claude Code", codex: "Codex", kimi: "Kimi" };
const recentNote = "Recent search reads every transcript updated in this window.";

function referenceFor(hit) {
  const rows = [
    ["Session", hit.session],
    ["Transcript", hit.source],
  ];
  if (hit.records) {
    const [first, last] = hit.records;
    rows.push(first === last ? ["Record", String(first)] : ["Records", first + "\u2013" + last]);
  }
  return rows.filter(([, value]) => value).map(([label, value]) => ({ label, value }));
}

function formatUpdated(updatedAt) {
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const today = date.toDateString() === now.toDateString();
  return {
    text:
      (today ? "Today, " : "") +
      date.toLocaleString(undefined, {
        ...(!today && {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
        }),
        hour: "numeric",
        minute: "2-digit",
      }),
    dateTime: date.toISOString(),
    title: date.toLocaleString(),
  };
}

function SessionHeader({ hit, sessionName, stamp }) {
  return (
    <div className="context">
      <h3>{hit.project || hit.session || hit.title}</h3>
      <span>{harnessNames[hit.harness] || hit.harness}</span>
      {stamp && (
        <time dateTime={stamp.dateTime} title={stamp.title}>
          {stamp.text}
        </time>
      )}
      {sessionName ? <span className="session-name">{sessionName}</span> : null}
    </div>
  );
}

function buildGroups(hits) {
  const grouped = new Map();
  for (const hit of hits) {
    if (!grouped.has(hit.collection)) grouped.set(hit.collection, []);
    grouped.get(hit.collection).push(hit);
  }
  const projects = new Map();
  for (const list of grouped.values()) {
    const project = list[0].project;
    projects.set(project, (projects.get(project) || 0) + 1);
  }
  return [...grouped.entries()].map(([key, list], index) => {
    const first = list[0];
    const id = key == null || key === "" ? "group-" + index : String(key);
    return {
      id,
      label: first.project || first.session || first.title || undefined,
      header: (
        <SessionHeader
          hit={first}
          sessionName={projects.get(first.project) > 1 && first.session ? first.session : null}
          stamp={first.updatedAt ? formatUpdated(first.updatedAt) : null}
        />
      ),
      passages: list.map((hit, passageIndex) => ({
        id: id + ":" + passageIndex,
        text: hit.excerpt || hit.title || "",
        reference: referenceFor(hit),
      })),
    };
  });
}

function App() {
  const pending = useRef(null),
    more = useRef(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState({ mode: "recent", window: defaultWindow, harness: "" });
  const [note, setNote] = useState(recentNote);
  const [view, setView] = useState({ state: "initial" });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      document.documentElement.dataset.hudsonTheme = media.matches ? "dark" : "light";
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (scope.mode === "recent") {
      setNote(recentNote);
      return;
    }
    const controller = new AbortController();
    setNote("Checking the local index…");
    (async () => {
      try {
        const r = await fetch("/api/status", { signal: controller.signal });
        if (!r.ok) throw new Error();
        const status = await r.json();
        if (!controller.signal.aborted)
          setNote(
            status.enabled
              ? status.chunks.toLocaleString() + " passages in the local index."
              : "The local index is off on this host.",
          );
      } catch {
        if (!controller.signal.aborted)
          setNote("Index unavailable. Run scout-search status to check the installation.");
      }
    })();
    return () => controller.abort();
  }, [scope.mode]);
  useEffect(() => () => pending.current?.abort(), []);

  async function search(nextScope) {
    pending.current?.abort();
    more.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setView({ state: "pending" });
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...nextScope, q: query, limit: pageSize }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!controller.signal.aborted)
        setView({ state: "ready", data, scope: nextScope, hits: data.hits, groups: buildGroups(data.hits),
          next: data.next, scanned: data.coverage.scannedFiles, morePending: false });
    } catch (error) {
      if (!controller.signal.aborted) setView({ state: "error", message: error.message });
    }
  }
  async function loadMore() {
    if (!view.next || view.morePending) return;
    setView({ ...view, morePending: true, moreError: null });
    const controller = new AbortController();
    more.current = controller;
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...view.scope, q: view.data.q, limit: pageSize, after: view.next }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (controller.signal.aborted) return;
      const hits = [...view.hits, ...data.hits];
      setView({ ...view, hits, groups: buildGroups(hits), next: data.next,
        scanned: (view.scanned ?? 0) + (data.coverage.scannedFiles ?? 0), morePending: false, moreError: null });
    } catch (error) {
      if (!controller.signal.aborted) setView({ ...view, morePending: false, moreError: error.message });
    }
  }
  function changeScope(next) {
    setScope(next);
    if (view.state !== "initial" && query.trim()) search(next);
  }
  function changeQuery(value) {
    setQuery(value);
    if (!value) {
      pending.current?.abort();
      more.current?.abort();
      setView({ state: "initial" });
    }
  }

  const indexCommand =
    "npx github:openscout-app/search index --window " +
    scope.window +
    (scope.harness ? " --harness " + scope.harness : "");

  return (
    <SearchSurface
      query={query}
      onQueryChange={changeQuery}
      onSubmit={() => search(scope)}
      scope={scope}
      onScopeChange={changeScope}
      status={view.state}
      error={view.state === "error" ? view.message : null}
      note={note}
      groups={view.state === "ready" ? view.groups : []}
      coverage={view.state === "ready" ? view.data.coverage : null}
      coverageOptions={{ indexCommand }}
      next={view.state === "ready" ? view.next : null}
      onLoadMore={loadMore}
      loadingMore={view.morePending === true}
      moreError={view.moreError ?? null}
      highlightQuery={view.state === "ready" ? view.data.q : query}
    />
  );
}

createRoot(document.getElementById("root")).render(<App />);
