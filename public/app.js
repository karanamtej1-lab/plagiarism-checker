const $ = (s) => document.querySelector(s);
const views = { input: $("#input-view"), progress: $("#progress-view"), report: $("#report-view") };
const text = $("#text");
const COLORS = 8;
let controller = null;

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  window.scrollTo({ top: 0 });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function showError(msg) {
  const el = $("#error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

/* ---------- theme ---------- */
function safeStore(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}
const savedTheme = safeStore("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("#theme").addEventListener("click", () => {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  safeStore("theme", next);
});

/* ---------- editor ---------- */
function updateCount() {
  const n = (text.value.match(/[\p{L}\p{N}]+/gu) || []).length;
  $("#count").textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
}
text.addEventListener("input", updateCount);
text.value = safeStore("draft") || "";
updateCount();
text.addEventListener("input", () => safeStore("draft", text.value));

async function loadFile(file) {
  showError("");
  // Vercel rejects request bodies over 4.5 MB before the server sees them.
  if (file.size > 4 * 1024 * 1024) return showError("That file is too big. The limit is 4 MB.");
  $("#file-name").textContent = `Reading ${file.name}…`;
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/extract", { method: "POST", body: form });
    const data = await res.json().catch(() => ({ error: `Upload failed (HTTP ${res.status}).` }));
    if (!res.ok) throw new Error(data.error);
    text.value = data.text;
    safeStore("draft", text.value);
    updateCount();
    $("#file-name").textContent = data.name;
  } catch (err) {
    $("#file-name").textContent = "";
    showError(err.message || "Couldn't read that file.");
  }
}
$("#file").addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

/* ---------- own sources ---------- */
function addOwnSource() {
  const node = $("#own-tpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".own-remove").addEventListener("click", () => node.remove());
  $("#own-list").append(node);
  node.querySelector(".own-title").focus();
}
$("#own-add").addEventListener("click", addOwnSource);

function ownSources() {
  return [...document.querySelectorAll(".own-item")].map((el) => ({
    title: el.querySelector(".own-title").value.trim(),
    text: el.querySelector(".own-text").value,
  }));
}

/* ---------- run ---------- */
const STAGE_LABEL = {
  search: (d, t) => `Searching passage ${Math.min(d + 1, t)} of ${t}`,
  fetch: (d, t) => `Downloading source ${Math.min(d + 1, t)} of ${t}`,
  compare: () => "Comparing wording…",
};
// Each stage owns a slice of the progress bar.
const STAGE_SPAN = { search: [0, 60], fetch: [60, 95], compare: [95, 100] };

function onProgress({ stage, done, total }) {
  $("#stage").textContent = STAGE_LABEL[stage](done, total);
  const [a, b] = STAGE_SPAN[stage];
  $("#bar-fill").style.width = `${a + (total ? (done / total) * (b - a) : 0)}%`;
  const order = Object.keys(STAGE_SPAN);
  document.querySelectorAll(".steps li").forEach((li) => {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(stage);
    li.className = i < cur ? "done" : i === cur ? "active" : "";
  });
}

async function run() {
  showError("");
  const words = (text.value.match(/[\p{L}\p{N}]+/gu) || []).length;
  const web = $("#opt-web").checked;
  const own = ownSources().filter((s) => s.text.trim());
  if (words < 15) return showError("Add at least 15 words of text to check.");
  if (!web && !own.length) return showError("Turn on web search or add at least one source to compare against.");

  const options = {
    web,
    excludeQuotes: $("#opt-quotes").checked,
    excludeReferences: $("#opt-refs").checked,
    minRun: Number($("#opt-minrun").value),
    ownSources: own,
  };
  show("progress");
  $("#bar-fill").style.width = "0";
  $("#stage").textContent = web ? "Starting…" : "Comparing wording…";
  controller = new AbortController();

  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.value, options }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);

    // The server streams one JSON object per line.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "progress") onProgress(msg);
        else if (msg.type === "error") throw new Error(msg.error);
        else if (msg.type === "result") return renderReport(msg.result);
      }
    }
    throw new Error("The check ended without a result. Please try again.");
  } catch (err) {
    show("input");
    if (err.name !== "AbortError") showError(err.message);
  } finally {
    controller = null;
  }
}
$("#run").addEventListener("click", run);
$("#cancel").addEventListener("click", () => controller?.abort());

/* ---------- report ---------- */
function verdictFor(p) {
  if (p === 0) return ["No matches found", "var(--s1)"];
  if (p < 10) return ["Low similarity", "var(--s1)"];
  if (p < 25) return ["Some similarity", "var(--s0)"];
  if (p < 50) return ["High similarity", "var(--s3)"];
  return ["Very high similarity", "var(--s5)"];
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderDocument(r) {
  // Merge highlight spans and ignored ranges into one ordered list of cuts.
  const marks = [
    ...r.spans.map((s) => ({ ...s, kind: "match" })),
    ...r.excluded.map(([start, end]) => ({ start, end, kind: "ex" })),
  ].sort((a, b) => a.start - b.start);
  let html = "", pos = 0;
  for (const m of marks) {
    if (m.start < pos) continue;
    html += escapeHtml(r.text.slice(pos, m.start));
    const inner = escapeHtml(r.text.slice(m.start, m.end));
    if (m.kind === "ex") html += `<span class="ex" title="Ignored">${inner}</span>`;
    else html += `<mark data-s="${m.source}" style="--sc:var(--s${m.source % COLORS})">${inner}<sup>${m.source + 1}</sup></mark>`;
    pos = m.end;
  }
  html += escapeHtml(r.text.slice(pos));
  return html;
}

function focusSource(id) {
  const doc = $("#doc");
  const already = doc.classList.contains("focus") && doc.dataset.focus === String(id);
  doc.classList.toggle("focus", !already);
  doc.dataset.focus = already ? "" : id;
  doc.querySelectorAll("mark").forEach((m) => m.classList.toggle("on", !already && m.dataset.s === String(id)));
  document.querySelectorAll("#source-list li").forEach((li) => li.classList.toggle("on", !already && li.dataset.s === String(id)));
  if (!already) doc.querySelector(`mark[data-s="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function renderReport(r) {
  const [verdict, color] = verdictFor(r.similarity);
  const ring = $("#ring");
  ring.style.setProperty("--p", Math.min(100, r.similarity));
  ring.style.setProperty("--c", color);
  $("#score-num").textContent = `${Math.round(r.similarity)}%`;
  $("#verdict").textContent = verdict;
  $("#summary").textContent =
    `${r.matchedWords.toLocaleString()} of ${r.wordCount.toLocaleString()} words match ` +
    `${r.sources.length} source${r.sources.length === 1 ? "" : "s"}`;

  $("#doc").className = "doc-body";
  $("#doc").innerHTML = renderDocument(r);
  $("#doc").onclick = (e) => {
    const m = e.target.closest("mark");
    if (m) focusSource(m.dataset.s);
  };

  const list = $("#source-list");
  list.innerHTML = r.sources.length
    ? r.sources
        .map(
          (s) => `<li data-s="${s.id}" style="--sc:var(--s${s.id % COLORS})">
            <span class="num">${s.id + 1}</span>
            <span class="src-main">
              <div class="src-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
              ${s.url ? `<a class="src-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host(s.url))}</a>` : `<span class="src-link">Your source</span>`}
            </span>
            <span class="pct">${s.percent}%</span>
          </li>`
        )
        .join("")
    : `<li class="empty">No matching sources found.</li>`;
  list.onclick = (e) => {
    if (e.target.closest("a")) return;
    const li = e.target.closest("li[data-s]");
    if (li) focusSource(li.dataset.s);
  };

  const st = r.stats;
  $("#stats").textContent = st.queries
    ? `Searched ${st.queries} passages, checked ${st.fetched} pages` +
      (st.failed ? ` (${st.failed} couldn't be opened)` : "") +
      (st.searchErrors ? `. ${st.searchErrors} searches failed, so results may be incomplete.` : ".")
    : "Compared against your own sources only.";
  show("report");
}

$("#edit").addEventListener("click", () => show("input"));
$("#print").addEventListener("click", () => window.print());
