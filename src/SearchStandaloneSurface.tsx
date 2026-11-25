import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HarnessMark, ScoutActionButton, harnessLabel } from "scout-app/primitives";
import { navigateBrowser, useBrowserLocation } from "scout-app/shell";
import { pageSize } from "../shared/pages.mjs";
import { defaultWindow, windows } from "../shared/windows.mjs";
import { coverageNote } from "../ui/coverage.js";

interface SearchHit {
  collection: string;
  title: string;
  excerpt: string;
  harness: string;
  project: string | null;
  session: string | null;
  source: string | null;
  records: [number, number] | null;
  updatedAt: number | null;
  sessionTitle?: string;
  role?: "prompt" | "reply" | "tool";
}

interface SearchCoverage {
  kind: string;
  window?: string;
  scannedFiles?: number;
  candidates?: number;
  partial?: boolean;
  stale?: boolean;
  suggestion?: string;
}

interface SearchApiResponse {
  mode: "recent" | "index";
  q: string;
  window: string;
  limit: number;
  hits: SearchHit[];
  next: string | null;
  coverage: SearchCoverage;
}

interface RecentSessionItem {
  sessionId: string;
  harness: string;
  project: string;
  branch: string | null;
  model: string | null;
  title: string | null;
  updatedAt: number;
}

interface ContextTurn {
  index: number;
  role: "prompt" | "reply" | "tool";
  label: string;
  text: string;
  matched: boolean;
}

interface ContextWindowResponse {
  sessionId: string;
  project: string;
  harness: string;
  title: string | null;
  turns: ContextTurn[];
}

interface SessionGroup {
  id: string;
  sessionId: string | null;
  harness: string;
  project: string;
  headline: string;
  updatedAt: number | null;
  source: string | null;
  hits: SearchHit[];
}

const HARNESS_FILTERS = [
  { value: "", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "antigravity", label: "Antigravity" },
  { value: "kimi", label: "Kimi" },
] as const;

const STARTER_QUERIES = [
  "npm test",
  "pull request",
  "worktree",
  "DESIGN_SYSTEM",
  "package.json",
] as const;

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function isUuidLike(value: string | null | undefined): boolean {
  if (!value) return true;
  return UUID_RE.test(value.trim());
}

function formatRelativeStamp(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function parseFormattedExcerpt(raw: string, role?: string): {
  kindLabel: string;
  isCode: boolean;
  display: string;
} {
  const toolMatch = /^name=([^\s]+)\s+input=(.*)$/s.exec(raw.trim());
  if (toolMatch) {
    const toolName = toolMatch[1] || "Tool";
    const rawInput = toolMatch[2]?.trim() || "";
    let cleanArg = rawInput;
    try {
      const parsed = JSON.parse(rawInput) as Record<string, unknown>;
      const cmd = parsed.command ?? parsed.cmd ?? parsed.CommandLine;
      const file = parsed.file_path ?? parsed.Path ?? parsed.TargetFile ?? parsed.path;
      const query = parsed.query ?? parsed.pattern;
      if (Array.isArray(cmd)) cleanArg = cmd.join(" ");
      else if (typeof cmd === "string") cleanArg = cmd;
      else if (typeof file === "string") cleanArg = file;
      else if (typeof query === "string") cleanArg = query;
    } catch {}
    return {
      kindLabel: toolName.length <= 10 ? toolName : "Tool",
      isCode: true,
      display: cleanArg || toolName,
    };
  }

  const cleaned = raw
    .replace(/^\.\.\.\]\s*/, "… ")
    .replace(/<truncated \d+ (?:bytes|lines)>/gi, "")
    .replace(/\s*\|\s*---\s*\|\s*/g, " · ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (role === "prompt") return { kindLabel: "Prompt", isCode: false, display: cleaned };
  if (role === "tool") return { kindLabel: "Output", isCode: true, display: cleaned };
  return { kindLabel: "Reply", isCode: false, display: cleaned };
}

function deriveSessionHeadline(hits: SearchHit[]): string {
  const first = hits[0]!;
  if (first.sessionTitle && !isUuidLike(first.sessionTitle)) {
    return first.sessionTitle;
  }
  const promptHit = hits.find((h) => h.role === "prompt" && h.excerpt.trim());
  if (promptHit) {
    const clean = parseFormattedExcerpt(promptHit.excerpt, "prompt").display.replace(/^\.\.\./, "").trim();
    if (clean.length > 6) return clean.length > 96 ? `${clean.slice(0, 95).trimEnd()}…` : clean;
  }
  const titleDash = /\s-\s(.+)$/.exec(first.title || "");
  if (titleDash?.[1]) {
    const clean = parseFormattedExcerpt(titleDash[1], first.role).display.replace(/^\.\.\./, "").trim();
    if (clean.length > 6 && !isUuidLike(clean)) {
      return clean.length > 96 ? `${clean.slice(0, 95).trimEnd()}…` : clean;
    }
  }
  if (first.project && !isUuidLike(first.project)) {
    return `${first.project} session`;
  }
  return `${harnessLabel(first.harness)} session`;
}

function groupSearchHits(hits: SearchHit[]): SessionGroup[] {
  const byCollection = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const bucket = byCollection.get(hit.collection);
    if (bucket) bucket.push(hit);
    else byCollection.set(hit.collection, [hit]);
  }
  return [...byCollection.entries()].map(([key, list]) => {
    const first = list[0]!;
    const hLabel = harnessLabel(first.harness);
    const rawProject =
      first.project
      && !isUuidLike(first.project)
      && first.project.toLowerCase() !== first.harness.toLowerCase()
      && first.project.toLowerCase() !== hLabel.toLowerCase()
        ? first.project
        : "";
    return {
      id: key,
      sessionId: first.session,
      harness: first.harness,
      project: rawProject,
      headline: deriveSessionHeadline(list),
      updatedAt: first.updatedAt,
      source: first.source,
      hits: list,
    };
  });
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const terms = query
      .trim()
      .split(/\s+/u)
      .filter((t) => t.length > 1)
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return [{ text, match: false }];
    const word = `(?:${terms.join("|")})`;
    const pattern = new RegExp(`(${word}(?:\\s+${word})*)`, "giu");
    return text.split(pattern).map((part, i) => ({ text: part, match: i % 2 === 1 }));
  }, [text, query]);

  return (
    <>
      {parts.map((part, idx) =>
        part.match ? <mark key={idx}>{part.text}</mark> : <span key={idx}>{part.text}</span>,
      )}
    </>
  );
}

function readUrlState(searchStr: string) {
  const params = new URLSearchParams(searchStr);
  const mode = params.get("mode") === "index" ? "index" : "recent";
  const win = params.get("window") || defaultWindow;
  const harness = params.get("harness") || "";
  const q = params.get("q") || "";
  return { q, scope: { mode: mode as "recent" | "index", window: win, harness } };
}

function syncUrlState(q: string, scope: { mode: string; window: string; harness: string }) {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (scope.mode !== "recent") params.set("mode", scope.mode);
  if (scope.window !== defaultWindow) params.set("window", scope.window);
  if (scope.harness) params.set("harness", scope.harness);
  const qs = params.toString();
  const nextUrl = qs ? `/?${qs}` : "/";
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

export function SearchStandaloneSurface({
  navigate = navigateBrowser,
}: {
  navigate?: (href: string) => void;
}) {
  const { searchStr } = useBrowserLocation();
  const initial = useMemo(() => readUrlState(searchStr), []);

  const [query, setQuery] = useState(initial.q);
  const [scope, setScope] = useState(initial.scope);
  const [status, setStatus] = useState<"idle" | "searching" | "ready" | "error">(
    initial.q.trim().length >= 2 ? "searching" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [coverage, setCoverage] = useState<SearchCoverage | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState(initial.q.trim());
  const [loadingMore, setLoadingMore] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSessionItem[]>([]);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [openContextId, setOpenContextId] = useState<string | null>(null);
  const [contextData, setContextData] = useState<Record<string, ContextWindowResponse | "loading" | "error">>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/recent-sessions?limit=8")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.sessions)) setRecentSessions(data.sessions);
      })
      .catch(() => {});
  }, []);

  const executeSearch = useCallback(
    async (rawQuery: string, targetScope: typeof scope) => {
      const trimmed = rawQuery.trim();
      syncUrlState(trimmed, targetScope);
      searchAbortRef.current?.abort();

      if (!trimmed || !trimmed.split(/\s+/u).some((t) => t.length >= 2)) {
        setStatus("idle");
        setError(null);
        setHits([]);
        setCoverage(null);
        setNextCursor(null);
        setActiveQuery("");
        return;
      }

      const controller = new AbortController();
      searchAbortRef.current = controller;
      setStatus("searching");
      setError(null);

      try {
        const res = await fetch("/api/search", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: trimmed,
            mode: targetScope.mode,
            window: targetScope.window,
            harness: targetScope.harness,
            limit: pageSize,
          }),
        });
        const data = (await res.json()) as SearchApiResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || "Search failed.");
        if (controller.signal.aborted) return;

        setHits(data.hits || []);
        setCoverage(data.coverage || null);
        setNextCursor(data.next || null);
        setActiveQuery(data.q || trimmed);
        setOpenContextId(null);
        setStatus("ready");
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not complete search.");
        setStatus("error");
      }
    },
    [],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      syncUrlState("", scope);
      searchAbortRef.current?.abort();
      setStatus("idle");
      setError(null);
      setHits([]);
      setCoverage(null);
      setNextCursor(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void executeSearch(query, scope);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, scope, executeSearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.matches("input, textarea, select, [contenteditable=true]"));
      if (
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
        || (!event.metaKey && !event.ctrlKey && event.key === "/" && !typing)
      ) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === "Escape" && document.activeElement !== inputRef.current) {
        inputRef.current?.focus();
        return;
      }
      if (target === inputRef.current && event.key === "ArrowDown") {
        const firstRow = listRef.current?.querySelector<HTMLElement>("[data-passage-row]");
        if (firstRow) {
          event.preventDefault();
          firstRow.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: activeQuery,
          mode: scope.mode,
          window: scope.window,
          harness: scope.harness,
          limit: pageSize,
          after: nextCursor,
        }),
      });
      const data = (await res.json()) as SearchApiResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not load next page.");
      setHits((prev) => [...prev, ...(data.hits || [])]);
      setNextCursor(data.next || null);
      if (data.coverage) {
        setCoverage((prev) => ({
          ...data.coverage,
          scannedFiles: (prev?.scannedFiles ?? 0) + (data.coverage.scannedFiles ?? 0),
        }));
      }
    } catch (err: any) {
      setError(err instanceof Error ? err.message : "Could not load more passages.");
    } finally {
      setLoadingMore(false);
    }
  };

  const togglePassageContext = async (passageKey: string, hit: SearchHit) => {
    if (openContextId === passageKey) {
      setOpenContextId(null);
      return;
    }
    setOpenContextId(passageKey);
    if (contextData[passageKey]) return;

    setContextData((prev) => ({ ...prev, [passageKey]: "loading" }));
    try {
      const res = await fetch("/api/session-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: hit.session ?? undefined,
          source: hit.source ?? undefined,
          centerRecord: hit.records?.[0],
          radius: 2,
        }),
      });
      if (!res.ok) throw new Error();
      const win = (await res.json()) as ContextWindowResponse;
      setContextData((prev) => ({ ...prev, [passageKey]: win }));
    } catch {
      setContextData((prev) => ({ ...prev, [passageKey]: "error" }));
    }
  };

  const copyReference = async (passageKey: string, hit: SearchHit) => {
    const lines = [
      hit.session ? `Session     ${hit.session}` : null,
      hit.source ? `Transcript  ${hit.source}` : null,
      hit.records ? `Record      ${hit.records[0]}` : null,
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopiedId(passageKey);
      window.setTimeout(() => setCopiedId((curr) => (curr === passageKey ? null : curr)), 1600);
    } catch {}
  };

  const groups = useMemo(() => groupSearchHits(hits), [hits]);

  const indexCommand = `npx openscout-app/search index --window ${scope.window}${
    scope.harness ? ` --harness ${scope.harness}` : ""
  }`;
  const coverageText = coverage ? coverageNote(coverage, { indexCommand }) : "";

  return (
    <div className="ss-page">
      <header className="ss-command-head">
        <form
          className="ss-search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void executeSearch(query, scope);
          }}
        >
          <div className="ss-field" data-busy={status === "searching" || undefined}>
            <svg className="ss-field-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              inputMode="search"
              className="ss-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts, replies, commands, and diffs…"
              aria-label="Search session transcripts"
              aria-keyshortcuts="/ Meta+k Control+k"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            {query ? (
              <button
                type="button"
                className="ss-clear"
                aria-label="Clear search query"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                ×
              </button>
            ) : (
              <kbd className="ss-kbd" aria-hidden="true">/</kbd>
            )}
          </div>
        </form>

        <div className="ss-toolbar" role="toolbar" aria-label="Search filters">
          <div className="ss-seg" role="group" aria-label="Search source">
            {(
              [
                ["recent", "Recent"],
                ["index", "Indexed"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className="ss-pill"
                aria-pressed={scope.mode === val}
                onClick={() => setScope((curr) => ({ ...curr, mode: val }))}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="ss-seg ss-seg--harnesses" role="group" aria-label="Harness filter">
            {HARNESS_FILTERS.map((h) => (
              <button
                key={h.value || "all"}
                type="button"
                className="ss-pill"
                aria-pressed={scope.harness === h.value}
                onClick={() => setScope((curr) => ({ ...curr, harness: h.value }))}
              >
                {h.value ? <HarnessMark harness={h.value} size={13} title={null} /> : null}
                <span>{h.label}</span>
              </button>
            ))}
          </div>

          <div className="ss-seg ss-seg--windows" role="group" aria-label="Time window">
            {windows.map((w) => (
              <button
                key={w.id}
                type="button"
                className="ss-pill ss-pill--mono"
                aria-pressed={scope.window === w.id}
                title={w.label}
                onClick={() => setScope((curr) => ({ ...curr, window: w.id }))}
              >
                {w.id}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error ? (
        <div className="ss-banner" data-tone="error" role="alert">
          {error}
        </div>
      ) : null}

      {status === "idle" ? (
        <div className="ss-cold">
          <div className="ss-starters">
            <span className="ss-starters-label">Try</span>
            {STARTER_QUERIES.map((sample) => (
              <button
                key={sample}
                type="button"
                className="ss-starter-chip"
                onClick={() => setQuery(sample)}
              >
                {sample}
              </button>
            ))}
          </div>

          {recentSessions.length > 0 ? (
            <section className="ss-recent" aria-label="Recent sessions on this host">
              <header className="ss-section-bar">
                <h2 className="s-ds-section-head">Recent sessions</h2>
                <span className="ss-section-meta">{recentSessions.length} active on this host</span>
              </header>
              <ul className="ss-recent-list" role="list">
                {recentSessions.map((sess) => {
                  const stamp = formatRelativeStamp(sess.updatedAt);
                  const headline =
                    sess.title && !isUuidLike(sess.title)
                      ? sess.title
                      : !isUuidLike(sess.project)
                        ? `${sess.project} session`
                        : `${harnessLabel(sess.harness)} session`;
                  return (
                    <li key={`${sess.harness}:${sess.sessionId}`} className="ss-recent-row">
                      <button
                        type="button"
                        className="ss-recent-btn"
                        onClick={() => navigate(`/sessions/${encodeURIComponent(sess.sessionId)}`)}
                      >
                        <HarnessMark harness={sess.harness} size={17} title={null} />
                        <span className="ss-recent-title">{headline}</span>
                        <span className="ss-recent-right">
                          {sess.project
                          && !isUuidLike(sess.project)
                          && sess.project.toLowerCase() !== sess.harness.toLowerCase()
                          && sess.project.toLowerCase() !== harnessLabel(sess.harness).toLowerCase() ? (
                            <span className="ss-project-tag">{sess.project}</span>
                          ) : null}
                          {stamp ? <time className="ss-time">{stamp}</time> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <section className="ss-results" ref={listRef} aria-label="Search results" aria-busy={status === "searching"}>
          <header className="ss-section-bar">
            <h2 className="s-ds-section-head">
              {status === "searching" && hits.length === 0
                ? "Searching transcripts…"
                : coverage?.kind === "index_off"
                  ? "Local search index is off"
                  : coverage && (coverage.kind === "empty_index" || coverage.kind === "not_warmed")
                    ? "Window not indexed yet"
                    : groups.length === 0
                      ? "No matching passages"
                      : `${hits.length} ${hits.length === 1 ? "passage" : "passages"} across ${groups.length} ${groups.length === 1 ? "session" : "sessions"}`}
            </h2>
            {coverage ? (
              <span className="ss-section-meta">
                {coverage.kind === "recent" && typeof coverage.scannedFiles === "number"
                  ? `${coverage.scannedFiles} / ${coverage.candidates ?? coverage.scannedFiles} transcripts`
                  : coverage.kind === "warmed"
                    ? "Indexed history"
                    : null}
              </span>
            ) : null}
          </header>

          {coverage && (coverage.kind === "index_off" || coverage.kind === "empty_index" || coverage.kind === "not_warmed") ? (
            <div className="ss-index-callout">
              <p>{coverageText.split("\n")[0]}</p>
              {coverage.kind !== "index_off" ? <code className="ss-cmd">{indexCommand}</code> : null}
              <div className="ss-index-actions">
                <ScoutActionButton onClick={() => setScope((curr) => ({ ...curr, mode: "recent" }))}>
                  Search recent transcripts instead
                </ScoutActionButton>
              </div>
            </div>
          ) : null}

          {groups.length === 0 && status === "ready" && coverage?.kind === "recent" ? (
            <div className="ss-empty-state">
              <p>
                No passages matched <strong>“{activeQuery}”</strong> in {coverageText.toLowerCase()}
              </p>
              {scope.window !== "30d" ? (
                <ScoutActionButton quiet onClick={() => setScope((curr) => ({ ...curr, window: "30d" }))}>
                  Expand to last 30 days
                </ScoutActionButton>
              ) : null}
            </div>
          ) : null}

          <div className="ss-groups">
            {groups.map((group) => {
              const expanded = expandedGroups[group.id] === true;
              const visibleHits = expanded ? group.hits : group.hits.slice(0, 3);
              const hiddenCount = group.hits.length - visibleHits.length;
              const stamp = formatRelativeStamp(group.updatedAt);
              const canOpenSession = Boolean(group.sessionId);

              return (
                <article key={group.id} className="ss-group">
                  <header className="ss-group-head">
                    <div className="ss-group-lead">
                      <HarnessMark harness={group.harness} size={18} title={null} />
                      <div className="ss-group-titles">
                        {canOpenSession ? (
                          <button
                            type="button"
                            className="ss-group-headline"
                            onClick={() => navigate(`/sessions/${encodeURIComponent(group.sessionId!)}`)}
                          >
                            {group.headline}
                          </button>
                        ) : (
                          <span className="ss-group-headline">{group.headline}</span>
                        )}
                        <div className="ss-group-byline">
                          {group.project ? <span className="ss-project-tag">{group.project}</span> : null}
                          <span>{harnessLabel(group.harness)}</span>
                          {stamp ? <span>· {stamp}</span> : null}
                          {group.hits.length > 1 ? <span>· {group.hits.length} matches</span> : null}
                        </div>
                      </div>
                    </div>
                    {canOpenSession ? (
                      <button
                        type="button"
                        className="s-ds-act ss-open-session"
                        onClick={() => navigate(`/sessions/${encodeURIComponent(group.sessionId!)}`)}
                      >
                        Session →
                      </button>
                    ) : null}
                  </header>

                  <div className="ss-passages">
                    {visibleHits.map((hit, idx) => {
                      const passageKey = `${group.id}:${hit.records?.[0] ?? idx}:${idx}`;
                      const parsed = parseFormattedExcerpt(hit.excerpt || hit.title, hit.role);
                      const isOpen = openContextId === passageKey;
                      const ctxState = contextData[passageKey];

                      return (
                        <div key={passageKey} className="ss-passage-item" data-open={isOpen || undefined}>
                          <div
                            role="button"
                            tabIndex={0}
                            data-passage-row=""
                            aria-expanded={isOpen}
                            className="ss-passage-row"
                            onClick={() => void togglePassageContext(passageKey, hit)}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && group.sessionId) {
                                e.preventDefault();
                                navigate(`/sessions/${encodeURIComponent(group.sessionId)}`);
                                return;
                              }
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                void togglePassageContext(passageKey, hit);
                              }
                            }}
                          >
                            <span className="ss-role" data-role={hit.role || "reply"}>
                              {parsed.kindLabel}
                            </span>
                            <span className={parsed.isCode ? "ss-excerpt ss-excerpt--code" : "ss-excerpt"}>
                              <HighlightedText text={parsed.display} query={activeQuery} />
                            </span>
                            <span className="ss-row-cue" aria-hidden="true">
                              {isOpen ? "Hide" : "Context"}
                            </span>
                          </div>

                          {isOpen ? (
                            <div className="ss-context-drawer">
                              {ctxState === "loading" || !ctxState ? (
                                <div className="ss-context-status">Reading surrounding turns…</div>
                              ) : ctxState === "error" || ctxState.turns.length === 0 ? (
                                <div className="ss-context-status">Surrounding turns unavailable for this record.</div>
                              ) : (
                                <div className="ss-context-turns">
                                  {ctxState.turns.map((turn, tIdx) => (
                                    <div
                                      key={`${turn.index}:${tIdx}`}
                                      className="ss-context-turn"
                                      data-matched={turn.matched || undefined}
                                    >
                                      <span className="ss-context-turn-role" data-role={turn.role}>
                                        {turn.label}
                                      </span>
                                      <p className={turn.role === "tool" ? "ss-context-turn-body ss-context-turn-body--code" : "ss-context-turn-body"}>
                                        <HighlightedText text={turn.text.slice(0, 420)} query={activeQuery} />
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="ss-context-foot">
                                <div className="ss-context-actions">
                                  {group.sessionId ? (
                                    <ScoutActionButton
                                      onClick={() => navigate(`/sessions/${encodeURIComponent(group.sessionId!)}`)}
                                    >
                                      Open full session
                                    </ScoutActionButton>
                                  ) : null}
                                  <ScoutActionButton quiet onClick={() => void copyReference(passageKey, hit)}>
                                    {copiedId === passageKey ? "Copied" : "Copy reference"}
                                  </ScoutActionButton>
                                </div>
                                {hit.source ? <code className="ss-source-path">{hit.source}</code> : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}

                    {hiddenCount > 0 ? (
                      <button
                        type="button"
                        className="s-ds-act ss-more-in-group"
                        onClick={() => setExpandedGroups((curr) => ({ ...curr, [group.id]: true }))}
                      >
                        Show {hiddenCount} more {hiddenCount === 1 ? "passage" : "passages"} in this session
                      </button>
                    ) : expanded && group.hits.length > 3 ? (
                      <button
                        type="button"
                        className="s-ds-act ss-more-in-group"
                        onClick={() => setExpandedGroups((curr) => ({ ...curr, [group.id]: false }))}
                      >
                        Show fewer passages
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>

          {nextCursor ? (
            <div className="ss-pagination">
              <ScoutActionButton onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more passages"}
              </ScoutActionButton>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
