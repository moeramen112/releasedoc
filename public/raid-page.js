// RAID page: read the releases saved in this browser, hand them to raid.js, draw with raid-view.js. No rules live here.
import { buildRaidView, filterRaid } from "/raid.js";
import { renderRaidSummary, renderRaidTable } from "/raid-view.js";
import { esc } from "/html.js";

const $ = (s) => document.querySelector(s);
let plans = [];

const LIB_KEY = "rr.releases.v1"; // the same key the planner saves under
const PLANNER = typeof window !== "undefined" && window.__STANDALONE === true ? "index.html" : "/plan.html";

/** The releases saved in this browser. Empty when nothing was saved yet. */
function load() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY) || "null");
    plans = (lib?.order || []).filter((id) => lib.items?.[id]?.release && Array.isArray(lib.items[id].tickets)).map((id) => ({ ...lib.items[id], id }));
  } catch { plans = []; }
}

function draw() {
  const view = buildRaidView(plans, { includeClosed: $("#f-closed").checked });
  const keep = { owner: $("#f-owner").value, release: $("#f-release").value };
  $("#f-owner").innerHTML = `<option value="">Everyone</option>` + [...view.owners, "(none)"].map((o) => `<option${o === keep.owner ? " selected" : ""}>${esc(o)}</option>`).join("");
  $("#f-release").innerHTML = `<option value="">All open releases</option>` + plans.map((p) => `<option value="${esc(p.id)}"${p.id === keep.release ? " selected" : ""}>${esc(p.release?.name || "Untitled release")}</option>`).join("");
  const rows = filterRaid(view.rows, { type: $("#f-type").value, rating: $("#f-rating").value, owner: $("#f-owner").value, releaseId: $("#f-release").value });
  $("#summary").innerHTML = renderRaidSummary(view.rows);
  $("#table").innerHTML = renderRaidTable(rows, { href: (id) => `${PLANNER}?release=${encodeURIComponent(id)}` });
}

for (const id of ["f-type", "f-rating", "f-owner", "f-release", "f-closed"]) $("#" + id).addEventListener("change", draw);
load();
draw();
