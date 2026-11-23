const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const results = document.querySelector("#results");
const heading = document.querySelector("#result-title");
const compactMode = document.querySelector("#compact-mode");
const message = document.querySelector("#message");
const scope = document.querySelector("#scope-note");
const harnessName = { codex: "Codex", claude: "Claude Code", kimi: "Kimi" };
const recentNote = scope.textContent;
const startMessage = message.textContent;
let pending;
let statusRequest;
let submitted = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function highlight(parent, text, q) {
  const terms = q.trim().split(/\s+/u).filter(term => term.length > 1)
    .sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"));
  if (!terms.length) return parent.append(text);
  const pattern = new RegExp("(?:" + terms.join("|") + ")(?:\\s+(?:" + terms.join("|") + "))*", "giu");
  let pos = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(pos, match.index), element("mark", match[0]));
    pos = match.index + match[0].length;
  }
  parent.append(text.slice(pos));
}

function passage(hit, q) {
  const detail = element("details");
  const summary = element("summary");
  const excerpt = element("span", null, "excerpt");
  highlight(excerpt, hit.excerpt || hit.title, q);
  summary.append(excerpt);
  const source = element("div", null, "source");
  const coords = element("div", null, "coords");
  const rows = [["Session", hit.session], ["Transcript", hit.source]];
  if (hit.records) {
    const [first, last] = hit.records;
    rows.push(first === last ? ["Record", String(first)] : ["Records", first + "–" + last]);
  }
  const reference = rows.filter(([, value]) => value);
  for (const [label, value] of reference) {
    const part = element("span");
    part.title = label + " · " + value;
    if (label === "Transcript") part.className = "path";
    if (label === "Session" || label === "Transcript") part.append(element("span", label + " ", "sr-only"), element("bdi", value));
    else part.textContent = label.toLowerCase() + " " + value;
    coords.append(part);
  }
  if (reference.length) {
    const copy = element("button", "Copy reference", "copy");
    copy.type = "button";
    let reset;
    copy.addEventListener("click", async () => {
      clearTimeout(reset);
      try {
        await navigator.clipboard.writeText(reference.map(([label, value]) => label + "  " + value).join("\\n"));
        copy.textContent = "Copied";
        reset = setTimeout(() => { copy.textContent = "Copy reference"; }, 1500);
      } catch { copy.textContent = "Select the reference to copy"; }
    });
    source.append(coords, copy);
  } else source.append("Source coordinates are unavailable for this passage.");
  detail.append(summary, source);
  return detail;
}

function describeCoverage(c) {
  switch (c.kind) {
    case "recent":
      return c.scannedFiles + " of " + c.candidates + " candidate files read." +
        (c.partial ? " Results cover part of the selected history." : "");
    case "index_off":
      return "Turn on Local search index in Scout Settings › System, then index the sessions you want to search.";
    case "empty_index":
    case "not_warmed": {
      const options = new FormData(form);
      return "Index this window from a terminal, then search again.\n" +
        "npx github:openscout-app/search index --hours " + options.get("hours") +
        (options.get("harness") ? " --harness " + options.get("harness") : "");
    }
    case "bounded": return c.suggestion;
    case "warmed": return c.stale ? "The index may be missing recent changes. Index this window again to refresh it." :
      "Results cover sessions in the indexed window.";
    default: return "Scout did not report coverage for this window.";
  }
}

function show(result) {
  const groups = new Map();
  for (const hit of result.hits) {
    const key = hit.collection;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hit);
  }
  const c = result.coverage;
  let title = result.hits.length + (result.hits.length === 1 ? " passage" : " passages") +
    " in " + groups.size + (groups.size === 1 ? " session" : " sessions");
  if (c.kind === "index_off") title = "Local index is off";
  else if (c.kind === "empty_index" || c.kind === "not_warmed") title = "This window hasn’t been indexed";
  else if (!groups.size) title = "No matches in the searched history";
  heading.textContent = title;
  message.classList.toggle("coverage", c.kind === "recent" || groups.size > 0);
  message.classList.toggle("partial", Boolean(c.partial || c.stale || c.kind === "bounded"));
  message.textContent = describeCoverage(c);
  const block = document.createDocumentFragment();
  const projects = new Map();
  for (const [first] of groups.values()) projects.set(first.project, (projects.get(first.project) || 0) + 1);
  for (const hits of groups.values()) {
    const first = hits[0];
    const row = element("article", null, "group");
    const meta = element("div", null, "context");
    meta.append(element("h3", first.project || first.session || first.title),
      element("span", harnessName[first.harness] || first.harness));
    if (first.updatedAt) {
      const date = new Date(first.updatedAt);
      const today = date.toDateString() === new Date().toDateString();
      const stamp = element("time", date.toLocaleString(undefined, {
        ...(!today && { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) }),
        hour: "numeric", minute: "2-digit",
      }));
      stamp.dateTime = date.toISOString();
      stamp.title = date.toLocaleString();
      meta.append(stamp);
    }
    const passages = element("div");
    if (projects.get(first.project) > 1 && first.session) passages.append(element("div", first.session, "session-name"));
    passages.append(...hits.map(hit => passage(hit, result.q)));
    row.append(meta, passages);
    block.append(row);
  }
  results.replaceChildren(block);
}

async function runSearch() {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  submitted = true;
  results.replaceChildren();
  message.className = "message";
  heading.textContent = "Searching…";
  message.textContent = "";
  results.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!controller.signal.aborted) show(data);
  } catch (error) {
    if (controller.signal.aborted) return;
    heading.textContent = "Search didn’t finish";
    message.textContent = error.message;
  } finally {
    if (pending === controller) results.removeAttribute("aria-busy");
  }
}

async function changeSource() {
  statusRequest?.abort();
  if (new FormData(form).get("mode") === "recent") {
    scope.textContent = recentNote;
    return;
  }
  const controller = new AbortController();
  statusRequest = controller;
  scope.textContent = "Checking the local index…";
  try {
    const response = await fetch("/api/status", { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!controller.signal.aborted) scope.textContent = data.enabled ?
      data.chunks.toLocaleString() + " passages in the local index." :
      "The local index is off on this host.";
  } catch {
    if (!controller.signal.aborted) scope.textContent = "Index unavailable. Run scout-search status to check the installation.";
  }
}

form.addEventListener("submit", event => { event.preventDefault(); runSearch(); });
document.querySelector("aside").addEventListener("change", event => {
  if (event.target === compactMode) {
    form.elements.namedItem("mode").value = compactMode.value;
    changeSource();
  } else if (event.target.name === "mode") {
    compactMode.value = event.target.value;
    changeSource();
  }
  if (submitted && input.value.trim()) runSearch();
});
input.addEventListener("input", () => {
  if (input.value || !submitted) return;
  pending?.abort();
  submitted = false;
  results.replaceChildren();
  heading.textContent = "Find a passage";
  message.className = "message";
  message.textContent = startMessage;
});

// Shortcuts leave typing and native filter controls to the browser.
document.addEventListener("keydown", event => {
  const target = event.target;
  if (event.isComposing || event.altKey || !(target instanceof HTMLElement)) return;
  const key = event.key;
  const typing = target.matches("input, textarea, select, [contenteditable=true]");
  if (((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") ||
      (!event.metaKey && !event.ctrlKey && !typing && key === "/")) {
    event.preventDefault();
    input.focus();
    input.select();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  if (target === input && key === "ArrowDown") {
    const first = results.querySelector("summary");
    if (first) { event.preventDefault(); first.focus(); }
    return;
  }
  if (!target.matches("summary") || !results.contains(target)) return;
  const detail = target.parentElement;
  const items = Array.from(results.querySelectorAll("summary"));
  const index = items.indexOf(target);
  switch (key) {
    case "ArrowDown": case "j": items[Math.min(items.length - 1, index + 1)].focus(); break;
    case "ArrowUp": case "k": items[Math.max(0, index - 1)].focus(); break;
    case "Home": items[0].focus(); break;
    case "End": items.at(-1).focus(); break;
    case "ArrowRight": detail.open = true; break;
    case "ArrowLeft": detail.open = false; break;
    case "c": detail.open = true; detail.querySelector(".copy")?.click(); break;
    case "Escape": input.focus(); input.select(); break;
    default: return;
  }
  event.preventDefault();
});
