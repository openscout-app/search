const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const results = document.querySelector("#results");
const heading = document.querySelector("#result-title");
const count = document.querySelector("#result-count");
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
  const pattern = new RegExp(terms.join("|"), "giu");
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
  highlight(summary, hit.excerpt || hit.title, q);
  const source = element("div", null, "source");
  const list = element("dl");
  const rows = [["Session", hit.session], ["Transcript", hit.source]];
  if (hit.records) rows.push(["Records", hit.records[0] === hit.records[1] ? String(hit.records[0]) : hit.records.join("–")]);
  const coords = rows.filter(([, value]) => value);
  for (const [label, value] of coords) list.append(element("dt", label), element("dd", value));
  source.append(list);
  if (coords.length) {
    const copy = element("button", "Copy reference", "copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(coords.map(([label, value]) => label + "  " + value).join("\n"));
        copy.textContent = "Copied";
      } catch { copy.textContent = "Select and copy the reference above"; }
    });
    source.append(copy);
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
  let title = "Matching passages";
  if (c.kind === "index_off") title = "Local index is off";
  else if (c.kind === "empty_index" || c.kind === "not_warmed") title = "This window hasn’t been indexed";
  else if (!groups.size) title = "No matches in the searched history";
  heading.textContent = title;
  count.textContent = groups.size ? result.hits.length + (result.hits.length === 1 ? " passage" : " passages") +
    " in " + groups.size + (groups.size === 1 ? " session" : " sessions") : "";
  message.textContent = describeCoverage(c);
  const block = document.createDocumentFragment();
  for (const hits of groups.values()) {
    const first = hits[0];
    const row = element("article", null, "group");
    const meta = element("div", null, "context");
    meta.append(element("h3", first.project || first.session || first.title),
      element("span", harnessName[first.harness] || first.harness));
    if (first.updatedAt) meta.append(element("span", new Date(first.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })));
    row.append(meta, ...hits.map(hit => passage(hit, result.q)));
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
  count.textContent = "";
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
  if (event.target.name === "mode") changeSource();
  if (submitted && input.value.trim()) runSearch();
});
input.addEventListener("input", () => {
  if (input.value || !submitted) return;
  pending?.abort();
  submitted = false;
  results.replaceChildren();
  heading.textContent = "Find a passage";
  count.textContent = "";
  message.textContent = startMessage;
});
