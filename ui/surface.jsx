import { useEffect, useId, useRef } from "react";
import { coverageNote } from "./coverage.js";
import { PassageList } from "./passages.jsx";
import { defaultWindow, findWindow, windows } from "../shared/windows.mjs";

export const searchModes = [
  { value: "recent", label: "Recent sessions" },
  { value: "index", label: "Local index" },
];

export const searchHarnesses = [
  { value: "", label: "All" },
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "kimi", label: "Kimi" },
  { value: "antigravity", label: "Antigravity" },
];

export const searchWindowOptions = windows.map((entry) => ({ value: entry.id, label: entry.label }));

/** The label a window step takes in copy. */
export function windowLabel(id) {
  return findWindow(id)?.label ?? id;
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

function Segments({ label, name, value, choices, onChange }) {
  const group = useId();
  return (
    <fieldset className="search-filter">
      <legend>{label}</legend>
      <div className="search-segments">
        {choices.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name={name + group}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The search page, composed from its parts. Data and callbacks come in; nothing
 * here knows about the app's fetch layer or state.
 */
export function SearchSurface({
  query,
  onQueryChange,
  onSubmit,
  scope,
  onScopeChange,
  harnesses = searchHarnesses,
  modes = searchModes,
  windowChoices = searchWindowOptions,
  status,
  error,
  note,
  masthead,
  groups,
  selectedId,
  coverage,
  coverageOptions,
  next,
  onLoadMore,
  loadingMore = false,
  moreError,
  emptyTitle = "Find a passage",
  emptyMessage = "Enter words you remember from a session with Claude Code, Codex, Kimi or Antigravity.",
  heading = "Search sessions",
  highlightQuery,
}) {
  const input = useRef(null);
  const results = useRef(null);
  useKeys(input, results);

  const sessions = groups.length;
  const passages = groups.reduce((total, group) => total + group.passages.length, 0);

  let title = emptyTitle;
  let message = emptyMessage;
  let covered = false;
  let partial = false;
  if (status === "pending") {
    title = "Searching…";
    message = "";
  }
  if (status === "error") {
    title = "Search didn’t finish";
    message = error ?? "";
  }
  if (status === "ready") {
    title =
      passages +
      (passages === 1 ? " passage in " : " passages in ") +
      sessions +
      (sessions === 1 ? " session" : " sessions");
    if (coverage?.kind === "index_off") title = "Local index is off";
    else if (coverage && ["empty_index", "not_warmed"].includes(coverage.kind)) title = "This window hasn’t been indexed";
    else if (!sessions) title = "No matches in the searched history";
    if (coverage) message = coverageNote(coverage, coverageOptions);
    if (next) message += " More passages are in this window.";
    covered = coverage?.kind === "recent" || sessions > 0;
    partial = Boolean(
      (coverage && "partial" in coverage && coverage.partial) ||
        (coverage?.kind === "warmed" && coverage.stale) ||
        coverage?.kind === "bounded",
    );
  }

  return (
    <div className="frame search-frame">
      {masthead ?? <header className="search-masthead"><div className="search-rail search-masthead-inner">Scout Search</div></header>}
      <main>
        <div className="workspace search-rail">
          <header className="query-head">
            <h1>{heading}</h1>
            <form
              id="search-form"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
            >
              <div className="search-field">
                <span className="lens" aria-hidden="true" />
                <input
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
                  onChange={(e) => onQueryChange(e.target.value)}
                />
                {!query && <kbd aria-hidden="true">/</kbd>}
                <button type="submit" className="primary">Search</button>
              </div>
            </form>
          </header>
          <aside className="controls" aria-label="Search filters">
            {[
              ["mode", "Search in", modes],
              ["window", "Sessions updated", windowChoices],
              ["harness", "Harness", harnesses],
            ].map(([key, label, choices]) => (
              <Segments
                key={key}
                label={label}
                name={key}
                value={scope[key]}
                choices={choices}
                onChange={(value) => onScopeChange({ ...scope, [key]: value })}
              />
            ))}
          </aside>
          {note ? <p className="scope-note" role="status">{note}</p> : null}
          <section aria-label="Search results">
            <div className="results-head" role="status" aria-atomic="true">
              <h2>{title}</h2>
              <p className={"message" + (covered ? " coverage" : "") + (partial ? " partial" : "")}>
                {message}
              </p>
            </div>
            <div ref={results} aria-busy={status === "pending" || loadingMore}>
              {status === "ready" && (
                <>
                  <PassageList groups={groups} query={highlightQuery ?? query} selectedId={selectedId} />
                  {next && (
                    <div className="more">
                      <button
                        type="button"
                        className="primary"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                      >
                        {loadingMore ? "Loading…" : "Show more passages"}
                      </button>
                      {moreError && <span className="message partial">{moreError}</span>}
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
