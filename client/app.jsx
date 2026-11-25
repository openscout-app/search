import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HudButton, HudInput, HudSelect } from "hudsonkit/primitives";
import { pageSize } from "../shared/pages.mjs";
import { defaultWindow, findWindow, windows as windowSteps } from "../shared/windows.mjs";
import { PassageList } from "../ui/passages.jsx";

const harnessNames = { claude: "Claude Code", codex: "Codex", kimi: "Kimi" };
const options = (rows) => rows.map(([value, label]) => ({ value, label }));
const harnesses = options([["", "All"], ...Object.entries(harnessNames)]);
const windows = options(windowSteps.map((step) => [step.id, step.label]));
const modes = options([
  ["recent", "Recent sessions"],
  ["index", "Local index"],
]);
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

function coverageText(c, scope) {
  switch (c.kind) {
    case "recent":
      return (
        c.scannedFiles +
        " of " +
        c.candidates +
        (c.candidates === 1 ? " transcript file read in the " : " transcript files read in the ") +
        findWindow(scope.window).label.toLowerCase() +
        "." +
        (c.partial ? " Results cover part of the window." : "")
      );
    case "index_off":
      return "Turn on Local search index in Scout Settings › System, then index the sessions you want to search.";
    case "not_warmed":
    case "empty_index":
      return (
        "Index this window from a terminal, then search again.\nnpx github:openscout-app/search index --window " +
        scope.window +
        (scope.harness ? " --harness " + scope.harness : "")
      );
    case "bounded":
      return c.suggestion;
    case "warmed":
      if (c.partial) return "Results cover part of the window.";
      return c.stale
        ? "The index may be missing recent changes. Index this window again to refresh it."
        : "Results cover sessions in the indexed window.";
    default:
      return "Scout did not report coverage for this window.";
  }
}

function useKeys(input, results) {
  useEffect(() => {
    function press(e) {
      const target = e.target,
        key = e.key;
      if (!(target instanceof HTMLElement) || e.isComposing || e.altKey) return;
      const typing = target.matches("input,textarea,select,[contenteditable=true]");
      if (
        ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "k") ||
        (!e.metaKey && !e.ctrlKey && key === "/" && !typing)
      ) {
        e.preventDefault();
        input.current.focus();
        input.current.select();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      const items = Array.from(results.current.querySelectorAll("summary"));
      if (target === input.current && key === "ArrowDown" && items.length) {
        e.preventDefault();
        items[0].focus();
        return;
      }
      const i = items.indexOf(target);
      if (i < 0) return;
      const detail = target.parentElement;
      switch (key) {
        case "j":
        case "ArrowDown":
          items[Math.min(items.length - 1, i + 1)].focus();
          break;
        case "k":
        case "ArrowUp":
          items[Math.max(0, i - 1)].focus();
          break;
        case "Home":
          items[0].focus();
          break;
        case "End":
          items.at(-1).focus();
          break;
        case "ArrowLeft":
          detail.open = false;
          break;
        case "ArrowRight":
          detail.open = true;
          break;
        case "c":
          detail.open = true;
          detail.querySelector(".sp-copy")?.click();
          break;
        case "Escape":
          input.current.focus();
          input.current.select();
          break;
        default:
          return;
      }
      e.preventDefault();
    }
    document.addEventListener("keydown", press);
    return () => document.removeEventListener("keydown", press);
  }, [input, results]);
}

function App() {
  const input = useRef(null),
    form = useRef(null),
    results = useRef(null),
    pending = useRef(null),
    more = useRef(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState({ mode: "recent", window: defaultWindow, harness: "" });
  const [scopeNote, setNote] = useState(recentNote);
  const [view, setView] = useState({ state: "initial" });
  useKeys(input, results);
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
  function changeScope(name, value) {
    const next = { ...scope, [name]: value };
    setScope(next);
    if (view.state !== "initial" && query.trim()) search(next);
  }

  let title = "Find a passage",
    message = "Enter words you remember from a session with Claude Code, Codex or Kimi.";
  let coverage = false,
    partial = false;
  if (view.state === "pending") {
    title = "Searching…";
    message = "";
  }
  if (view.state === "error") {
    title = "Search didn’t finish";
    message = view.message;
  }
  if (view.state === "ready") {
    const c = view.data.coverage,
      count = view.groups.length,
      total = view.hits.length;
    title =
      total +
      (total === 1 ? " passage in " : " passages in ") +
      count +
      (count === 1 ? " session" : " sessions");
    if (c.kind === "index_off") title = "Local index is off";
    else if (["empty_index", "not_warmed"].includes(c.kind)) title = "This window hasn’t been indexed";
    else if (!count) title = "No matches in the searched history";
    message = coverageText({ ...c, scannedFiles: view.scanned ?? c.scannedFiles }, view.scope)
      + (view.next ? " More passages are in this window." : "");
    coverage = c.kind === "recent" || count > 0;
    partial = c.partial || c.stale || c.kind === "bounded";
  }
  return (
    <div className="frame">
      <aside aria-label="Search filters">
        <header className="brand">
          <span className="lens" aria-hidden="true" />
          Scout Search
        </header>
        <div className="controls">
          <fieldset id="sources">
            <legend>Search in</legend>
            {modes.map((m) => (
              <label key={m.value}>
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={scope.mode === m.value}
                  onChange={() => changeScope("mode", m.value)}
                />
                {m.label}
              </label>
            ))}
          </fieldset>
          <label className="filter compact-mode">
            Search in
            <HudSelect
              id="compact-mode"
              value={scope.mode}
              options={modes}
              onChange={(e) => changeScope("mode", e.target.value)}
            />
          </label>
          <label className="filter">
            Harness
            <HudSelect
              id="harness"
              name="harness"
              form="search-form"
              value={scope.harness}
              options={harnesses}
              onChange={(e) => changeScope("harness", e.target.value)}
            />
          </label>
          <label className="filter">
            Sessions updated
            <HudSelect
              id="window"
              name="window"
              form="search-form"
              value={scope.window}
              options={windows}
              onChange={(e) => changeScope("window", e.target.value)}
            />
          </label>
        </div>
        <p className="scope-note">{scopeNote}</p>
      </aside>
      <main>
        <div className="workspace">
          <header className="query-head">
            <h1>Search sessions</h1>
            <form
              id="search-form"
              ref={form}
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                search(scope);
              }}
            >
              <div className="search-field">
                <span className="lens" aria-hidden="true" />
                <HudInput
                  ref={input}
                  id="query"
                  name="q"
                  type="search"
                  aria-label="Search session transcripts"
                  required
                  maxLength={300}
                  autoComplete="off"
                  spellCheck={false}
                  aria-keyshortcuts="/ Meta+k Control+k"
                  placeholder="Search for a phrase or command"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (!e.target.value) {
                      pending.current?.abort();
                      more.current?.abort();
                      setView({ state: "initial" });
                    }
                  }}
                />
                {!query && <kbd aria-hidden="true">/</kbd>}
                <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
                <HudButton
                  tone="accent"
                  className="primary"
                  variant="ghost"
                  onClick={() => form.current.requestSubmit()}
                >
                  Search
                </HudButton>
              </div>
            </form>
          </header>
          <section aria-label="Search results">
            <div className="results-head" role="status" aria-atomic="true">
              <h2>{title}</h2>
              <p className={"message" + (coverage ? " coverage" : "") + (partial ? " partial" : "")}>
                {message}
              </p>
            </div>
            <div ref={results} aria-busy={view.state === "pending" || view.morePending === true}>
              {view.state === "ready" && (
                <>
                  <PassageList groups={view.groups} query={view.data.q} />
                  {view.next && (
                    <div className="more">
                      <HudButton
                        variant="ghost"
                        className="primary"
                        onClick={loadMore}
                        disabled={view.morePending}
                      >
                        {view.morePending ? "Loading…" : "Show more passages"}
                      </HudButton>
                      {view.moreError && <span className="message partial">{view.moreError}</span>}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
