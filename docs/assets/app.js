"use strict";

// Simple, dependency-free viewer for AI-generated alt-text test runs.
// To add another run: build its JSON with scripts/build_site_data.py into
// data/runs/ and add an entry to data/runs.json. Nothing else needs to change.

const state = {
  runs: [],
  rows: [],
  filtered: [],
  page: 1,
  perPage: 20,
};

const el = (id) => document.getElementById(id);

/** Turn a full IIIF image URL (.../full/full/0/default.jpg) into a sized derivative. */
function iiifSize(url, size) {
  if (!url) return "";
  if (url.includes("/full/full/")) {
    return url.replace("/full/full/", `/full/!${size},${size}/`);
  }
  return url;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usd(x, digits = 4) {
  return x == null ? "—" : `$${Number(x).toFixed(digits)}`;
}

/** Stems for matching, e.g. "Paintings" -> ["paint"], "Marble relief" -> ["marble", "relief"]. */
function typeStems(terms) {
  const stems = new Set();
  terms.forEach((t) => {
    String(t)
      .toLowerCase()
      .replace(/[()]/g, " ")
      .split(/[\s,;/]+/)
      .filter((w) => w.length >= 3 && !["and", "with", "the"].includes(w))
      .forEach((w) => {
        // crude stemming: drop plural / -ing / -ed endings, keep a short prefix
        const base = w.replace(/(ings|ing|ies|es|s|ed)$/, "");
        stems.add(base.slice(0, Math.max(4, Math.min(base.length, 6))));
      });
  });
  return [...stems];
}

/**
 * Does the alt-text open with the kind of object -- a word of its classification or medium?
 * Returns "ok" | "miss" | "n/a" (nothing catalogued or no alt-text).
 */
function checkOpensWithType(r) {
  if (r.status !== "ok" || !r.alt_text) return "n/a";
  const terms = [r.classification, r.medium].filter(Boolean);
  if (!terms.length) return "n/a";
  const first = String(r.alt_text).split(/(?<=[.!?])\s/)[0].toLowerCase();
  return typeStems(terms).some((s) => first.includes(s)) ? "ok" : "miss";
}

async function loadRuns() {
  const res = await fetch("data/runs.json", { cache: "no-cache" });
  const cfg = await res.json();
  state.runs = cfg.runs || [];

  const sel = el("run-select");
  sel.innerHTML = "";
  state.runs.forEach((run, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${run.label} (${run.date})`;
    sel.appendChild(opt);
  });

  if (state.runs.length) {
    await loadRun(0);
  } else {
    el("grid-body").innerHTML = '<tr><td colspan="5">No runs found.</td></tr>';
  }
}

function fillSelect(id, allLabel, values) {
  const sel = el(id);
  sel.innerHTML = `<option value="">${allLabel}</option>`;
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  });
}

async function loadRun(index) {
  const run = state.runs[index];
  if (!run) return;
  el("grid-body").innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  const res = await fetch(run.file, { cache: "no-cache" });
  state.rows = await res.json();
  state.page = 1;
  el("footer-model").textContent = run.model || "—";

  const distinct = (key) => [...new Set(state.rows.map((r) => r[key]).filter(Boolean))].sort();
  fillSelect("collection-select", "All departments", distinct("department"));
  fillSelect("classification-select", "All classifications", distinct("classification"));

  const ok = state.rows.filter((r) => r.status === "ok").length;
  const opens = state.rows.filter((r) => checkOpensWithType(r) === "ok").length;
  const checked = state.rows.filter((r) => checkOpensWithType(r) !== "n/a").length;
  const cost = state.rows.reduce((sum, r) => sum + (r.cost || 0), 0);
  const tokens = state.rows.reduce((sum, r) => sum + (r.tokens_total || 0), 0);
  el("run-meta").innerHTML =
    `Model <strong>${escapeHtml(run.model || "—")}</strong> · ` +
    `${ok} of ${state.rows.length} images described · ${escapeHtml(run.date || "")}` +
    `<br>Cost <strong>${usd(cost, 2)}</strong> (${usd(ok ? cost / ok : null, 5)} per image) · ` +
    `${tokens.toLocaleString()} tokens` +
    (checked ? ` · ${opens} of ${checked} alt-texts open with the kind of object` : "");
  el("run-note").textContent = run.description || "";
  el("run-note").hidden = !run.description;
  applyFilter();
}

function applyFilter() {
  const q = el("search").value.trim().toLowerCase();
  const dept = el("collection-select").value;
  const cls = el("classification-select").value;
  state.filtered = state.rows.filter((r) => {
    if (dept && r.department !== dept) return false;
    if (cls && r.classification !== cls) return false;
    if (!q) return true;
    const hay = [r.obj_id, r.title, r.classification, r.medium, r.alt_text]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  state.page = 1;
  render();
}

function totalPages() {
  return Math.max(1, Math.ceil(state.filtered.length / state.perPage));
}

function typeCell(r) {
  const check = checkOpensWithType(r);
  const dept = r.department
    ? `<span class="coll">${escapeHtml(r.department)}</span>`
    : `<span class="coll muted">department unknown</span>`;
  const chips =
    (r.classification
      ? `<span class="type-chip">${escapeHtml(r.classification)}</span>`
      : `<span class="type-chip none">no classification</span>`) +
    (r.medium ? `<span class="type-chip medium">${escapeHtml(r.medium)}</span>` : "");
  const mark =
    check === "ok"
      ? `<span class="check ok" title="Alt-text opens with the kind of object">✓ opens with type</span>`
      : check === "miss"
        ? `<span class="check miss" title="First sentence names neither classification nor medium">✗ type not in first sentence</span>`
        : "";
  return `${dept}<div class="types">${chips}</div>${mark}`;
}

function render() {
  const tp = totalPages();
  if (state.page > tp) state.page = tp;
  const start = (state.page - 1) * state.perPage;
  const pageRows = state.filtered.slice(start, start + state.perPage);

  const body = el("grid-body");
  body.innerHTML = "";

  if (!pageRows.length) {
    body.innerHTML = '<tr><td colspan="5">No matching objects.</td></tr>';
  }

  pageRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.addEventListener("click", () => openModal(r));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal(r);
      }
    });

    const thumbUrl = iiifSize(r.image_url, 150);
    const thumbCell = thumbUrl
      ? `<img class="thumb" loading="lazy" src="${escapeHtml(thumbUrl)}" alt="Thumbnail for object ${escapeHtml(r.obj_id)}" />`
      : `<div class="thumb placeholder">no image</div>`;

    const altCell =
      r.status === "ok"
        ? `<div class="alt-preview">${escapeHtml(r.alt_text)}</div>`
        : `<span class="badge-err" title="${escapeHtml(r.error || "")}">error</span>`;

    const title = r.title ? `<div class="obj-title">${escapeHtml(r.title)}</div>` : "";

    tr.innerHTML =
      `<td class="col-thumb">${thumbCell}</td>` +
      `<td class="col-id"><span class="obj-id">${escapeHtml(r.obj_id)}</span>${title}</td>` +
      `<td class="col-type">${typeCell(r)}</td>` +
      `<td class="col-label">${r.cost == null ? "" : usd(r.cost, 5)}</td>` +
      `<td class="col-alt">${altCell}</td>`;
    body.appendChild(tr);
  });

  const end = Math.min(start + state.perPage, state.filtered.length);
  el("page-info").textContent = state.filtered.length
    ? `${start + 1}–${end} of ${state.filtered.length} · page ${state.page}/${tp}`
    : "0 results";
  el("prev").disabled = state.page <= 1;
  el("next").disabled = state.page >= tp;
}

function openModal(r) {
  el("modal-img").src = iiifSize(r.image_url, 1000);
  el("modal-img").alt = `Image for object ${r.obj_id}`;
  el("modal-title").textContent = r.title ? r.title : `Object ${r.obj_id}`;
  el("modal-subtitle").textContent = r.title ? `Object ${r.obj_id}` : "";
  el("modal-view").textContent = r.canvas_label || "";

  const meta = [];
  if (r.department) meta.push(["Department", escapeHtml(r.department)]);
  meta.push([
    "Classification",
    r.classification
      ? `<span class="type-chip">${escapeHtml(r.classification)}</span>`
      : `<span class="muted">not recorded — model asked to name the kind of object it sees</span>`,
  ]);
  if (r.medium) meta.push(["Medium", escapeHtml(r.medium)]);
  if (r.status === "ok")
    meta.push([
      "Model call",
      `${usd(r.cost, 5)} · ${(r.tokens_total || 0).toLocaleString()} tokens · ${r.duration_s ?? "—"} s`,
    ]);
  el("modal-meta").innerHTML = meta
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");

  el("modal-alt").textContent =
    r.status === "ok" ? r.alt_text : `No alt-text produced (${r.error || "error"}).`;

  const check = checkOpensWithType(r);
  el("modal-check").innerHTML =
    check === "ok"
      ? `<span class="check ok">✓ Opens with the kind of object (classification or medium)</span>`
      : check === "miss"
        ? `<span class="check miss">✗ First sentence names neither the classification nor the medium</span>`
        : "";

  const links = [];
  if (r.object_url)
    links.push(`<a href="${escapeHtml(r.object_url)}" target="_blank" rel="noopener">Gallery record ↗</a>`);
  if (r.manifest_url)
    links.push(`<a href="${escapeHtml(r.manifest_url)}" target="_blank" rel="noopener">IIIF manifest ↗</a>`);
  el("modal-links").innerHTML = links.join(" &nbsp;·&nbsp; ");

  el("modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  el("modal").hidden = true;
  el("modal-img").src = "";
  document.body.style.overflow = "";
}

function wireEvents() {
  el("run-select").addEventListener("change", (e) => loadRun(Number(e.target.value)));
  el("collection-select").addEventListener("change", applyFilter);
  el("classification-select").addEventListener("change", applyFilter);
  el("per-page").addEventListener("change", (e) => {
    state.perPage = Number(e.target.value);
    state.page = 1;
    render();
  });
  el("search").addEventListener("input", applyFilter);
  el("prev").addEventListener("click", () => {
    if (state.page > 1) { state.page--; render(); }
  });
  el("next").addEventListener("click", () => {
    if (state.page < totalPages()) { state.page++; render(); }
  });
  document.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closeModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el("modal").hidden) closeModal();
  });
}

wireEvents();
loadRuns().catch((err) => {
  el("grid-body").innerHTML =
    `<tr><td colspan="5">Failed to load data: ${escapeHtml(err.message)}</td></tr>`;
});
