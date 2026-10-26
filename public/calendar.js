// Calendar page for the browser-only edition: reads the releases the planner saved in this browser,
// hands them to schedule.js, draws with schedule-view.js. No rules live here.
import { buildSchedule, suggestSlots } from "/schedule.js";
import { renderTimeline, renderConflicts, viewRange } from "/schedule-view.js";
import { esc } from "/html.js";
import { evaluate } from "/engine.js";
import { computeRisk } from "/risk.js";
import { planToSnapshot, planConfig, planState } from "/plan.js";

const $ = (s) => document.querySelector(s);
const LIB_KEY = "rr.releases.v1"; // the same key the planner saves under
const PLANNER = typeof window !== "undefined" && window.__STANDALONE === true ? "index.html" : "/plan.html";
let plans = [];

/** The releases saved in this browser, newest data only. Empty when nothing was saved yet. */
function loadPlans() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY) || "null");
    return (lib?.order || []).filter((id) => lib.items?.[id]?.release && Array.isArray(lib.items[id].tickets)).map((id) => ({ ...lib.items[id], id }));
  } catch { return []; }
}

/** The call and risk next to each name. Same functions the planner uses, so the numbers match. */
function extrasFor(list, now) {
  return Object.fromEntries(list.map((p) => {
    try { return [p.id, { call: evaluate(planToSnapshot(p, now), planConfig(p), planState(p)).verdict.call, risk: computeRisk(p, now).score }]; } catch { return [p.id, {}]; }
  }));
}

const href = (id) => `${PLANNER}?release=${encodeURIComponent(id)}`;

function draw() {
  const now = Date.now();
  const open = buildSchedule(plans, { now });
  const shown = buildSchedule(plans, { now, includeClosed: $("#closed").checked });
  const range = viewRange(now, { days: Number($("#range").value) });
  $("#timeline").innerHTML = plans.length ? renderTimeline(shown, { ...range, extras: extrasFor(plans, now), href }) : `<p class="note">No releases saved in this browser yet. Open the <a href="${PLANNER}">planner</a>, set a deploy date, and come back.</p>`;
  $("#clash-title").textContent = open.conflicts.length ? `Clashes (${open.conflicts.length})` : "Clashes";
  $("#clashes").innerHTML = renderConflicts(open, { href, slotsFor: (id) => suggestSlots(plans, id, { now, count: 3 }) });
  const box = $("#unsched-box");
  box.hidden = !open.unscheduled.length;
  box.innerHTML = open.unscheduled.length ? `<div class="panel-head"><h2>No deploy date yet</h2></div><p class="note">These cannot clash with anything until they have one: ${open.unscheduled.map((u) => `<a href="${esc(href(u.id))}">${esc(u.name)}</a>`).join(", ")}.</p>` : "";
}

$("#range").addEventListener("change", draw);
$("#closed").addEventListener("change", draw);
plans = loadPlans();
draw();
