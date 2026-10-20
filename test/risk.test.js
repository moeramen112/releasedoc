import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePoints, forecast, computeRisk, businessDays, levelFor, rolloutLadder } from "../src/risk.js";
import { defaultPlan, applyTemplate, generateRunbook, planToSnapshot, planState, planConfig, runbookStatus, briefMarkdown } from "../src/plan.js";
import { evaluate } from "../src/engine.js";

// Monday 19 Oct 2026, 15:00 local time.
const NOW = new Date(2026, 9, 19, 15, 0, 0).getTime();
const at = (d, h = 0) => new Date(2026, 9, d, h, 0, 0).getTime();

/** A release with nothing wrong: everything done, canary, rehearsed rollback, Tuesday 2 AM deploy. */
function cleanPlan() {
  const p = defaultPlan(NOW);
  p.tickets = p.tickets.map((x) => ({ ...x, status: "Done", points: x.points || 1 }));
  p.when.freezeAt = "2026-10-15T00:00";
  p.when.deployAt = "2026-10-20T02:00";
  p.when.meetingAt = "2026-10-19T16:00";
  p.when.windowHours = 2;
  p.checks = { migration: "na", rollback: "pass", notes: "pass", errorbudget: "pass" };
  p.signals = { ...p.signals, ci: { total: 1500, realFailures: "", flaky: 0, pending: 0 }, openPrs: 0, failingOpenPrs: 0, lateMerged: 0, mergedUnapproved: 0, filesChanged: 40, linesChanged: 900, securityCritical: 0, securityHigh: 0, p95DeltaPct: 1, coverageDeltaPp: 0.2 };
  p.tickets.forEach((x) => { x.tags.migration = false; x.tags.untested = false; });
  p.signoffs = p.signoffs.map((s) => ({ ...s, approved: true }));
  p.runbook = generateRunbook(p).map((r) => ({ ...r, status: "done" }));
  return p;
}

test("story points: totals, percent done, in-flight and large open tickets", () => {
  const s = summarizePoints([
    { key: "A", points: 13, status: "In progress", type: "Story", area: "Core" },
    { key: "B", points: 5, status: "Done", type: "Story", area: "Core" },
    { key: "C", points: 2, status: "To do", type: "Story", area: "UI" },
    { key: "D", points: 0, status: "To do", type: "Story", area: "UI" },
    { key: "E", points: 0, status: "To do", type: "Bug", area: "UI" },
  ], 8);
  assert.equal(s.total, 20);
  assert.equal(s.done, 5);
  assert.equal(s.remaining, 15);
  assert.equal(s.pctDone, 25);
  assert.equal(s.inFlight, 13);
  assert.deepEqual(s.bigOpen, [{ key: "A", points: 13 }]);
  assert.equal(s.unestimated, 1); // the unpointed story counts, the unpointed bug does not
  assert.equal(s.byArea.UI.total, 2);
});

test("business days count only whole weekdays", () => {
  // Mon 15:00 to Thu 02:00 leaves Tue and Wed.
  assert.equal(businessDays(NOW, at(22, 2)), 2);
  // Fri 15:00 to Mon 10:00 leaves no complete weekday.
  assert.equal(businessDays(at(23, 15), at(26, 10)), 0);
  assert.equal(businessDays(NOW, NOW - 1000), 0);
});

test("forecast: on track, tight, behind, and after the freeze", () => {
  const plan = { when: { freezeAt: "2026-10-23T00:00", deployAt: "2026-10-26T02:00" }, scope: { velocity: 10 } };
  const pts = (remaining) => ({ remaining });
  // Tue to Thu are complete days before Fri 00:00: 3 days.
  assert.equal(forecast(plan, pts(20), NOW).state, "on-track"); // capacity 30
  assert.equal(forecast(plan, pts(30), NOW).state, "tight");
  assert.equal(forecast(plan, pts(60), NOW).state, "behind");
  assert.equal(forecast(plan, pts(0), NOW).state, "complete");
  assert.equal(forecast({ ...plan, when: { ...plan.when, freezeAt: "2026-10-15T00:00" } }, pts(5), NOW).state, "after-freeze");
  assert.equal(forecast({ ...plan, scope: { velocity: 0 } }, pts(5), NOW).state, "unknown");
});

test("risk factor weights add up to 100, so the score is out of 100", () => {
  const r = computeRisk(defaultPlan(NOW), NOW);
  assert.equal(r.factors.reduce((n, f) => n + f.max, 0), 100);
  assert.ok(r.factors.every((f) => f.points >= 0 && f.points <= f.max));
  assert.equal(r.score, r.factors.reduce((n, f) => n + f.points, 0));
});

test("a clean release scores Low and needs no recommendations", () => {
  const r = computeRisk(cleanPlan(), NOW);
  assert.equal(r.level, "Low");
  assert.ok(r.score < 15, `score was ${r.score}`);
  assert.equal(r.recommendations.length, 0);
});

test("the example release scores High or worse and explains why", () => {
  const r = computeRisk(defaultPlan(NOW), NOW);
  assert.ok(["High", "Critical"].includes(r.level), `level was ${r.level} (${r.score})`);
  const ids = r.recommendations.map((x) => x.id);
  assert.ok(ids.includes("blockers") && ids.includes("scope") && ids.includes("migration"));
});

test("each risk driver moves the score in the right direction", () => {
  const base = computeRisk(cleanPlan(), NOW).score;
  const bump = (mutate) => { const p = cleanPlan(); mutate(p); return computeRisk(p, NOW).score; };
  assert.ok(bump((p) => { p.tickets[0].type = "Bug"; p.tickets[0].priority = "P0"; p.tickets[0].status = "In progress"; }) > base + 9);
  assert.equal(bump((p) => { p.when.deployAt = "2026-10-23T14:00"; }), base + 7); // Friday in business hours hits the factor's cap of 7
  assert.equal(bump((p) => { p.how.strategy = "bigbang"; p.how.flagsDefaultOff = false; }), base + 5); // cap of 5
  assert.ok(bump((p) => { p.checks.rollback = "unset"; }) > base);
  assert.ok(bump((p) => { p.checks.migration = "unset"; }) >= base + 6);
  assert.ok(bump((p) => { p.signals.ci.realFailures = "unit / orders\ne2e / checkout"; }) >= base + 6);
  assert.ok(bump((p) => { p.signals.lateMerged = 3; }) >= base + 6);
  assert.ok(bump((p) => { p.signals.filesChanged = 700; }) > base);
});

test("risk levels and rollout ladders tighten together", () => {
  assert.equal(levelFor(0), "Low");
  assert.equal(levelFor(24), "Low");
  assert.equal(levelFor(25), "Moderate");
  assert.equal(levelFor(75), "Critical");
  assert.ok(rolloutLadder("High").steps.length > rolloutLadder("Low").steps.length);
  assert.ok(rolloutLadder("High").bake > rolloutLadder("Low").bake);
});

test("template defaults prefill strategy, window, rollback time and sign-off roles", () => {
  const p = applyTemplate(defaultPlan(NOW), "Hotfix");
  assert.equal(p.release.type, "Hotfix");
  assert.equal(p.when.windowHours, 1);
  assert.equal(p.how.rollbackMinutes, 10);
  assert.deepEqual(p.signoffs.map((s) => s.role), ["QA", "SRE on-call"]);
  assert.equal(p.signoffs[0].approved, true); // existing approvals are kept
});

test("runbook is prefilled in time order from the plan's dates and owners", () => {
  const p = defaultPlan(NOW);
  const rows = generateRunbook(p);
  assert.ok(rows.length >= 15);
  assert.ok(rows.every((r) => r.owner && r.at && r.status === "todo"));
  const deploy = rows.filter((r) => r.phase === "Deploy").map((r) => r.step);
  assert.ok(deploy.some((s) => /5%/.test(s)) && deploy.some((s) => /100%/.test(s)));
  assert.ok(rows.some((r) => /migration/i.test(r.step))); // migration is in scope
  p.checks.migration = "na"; p.tickets.forEach((t) => { t.tags.migration = false; });
  assert.ok(!generateRunbook(p).some((r) => /migration/i.test(r.step)));
  const phased = generateRunbook({ ...p, how: { ...p.how, strategy: "phased" } }).filter((r) => r.phase === "Deploy").map((r) => r.step);
  assert.ok(phased.some((s) => /prod-eu/.test(s)));
});

test("runbook status flags overdue pre-release steps and blocked steps", () => {
  const p = defaultPlan(NOW);
  p.runbook = [
    { phase: "Pre-release", step: "Cut branch", at: "2026-10-15T00:00", status: "done" },
    { phase: "Pre-release", step: "Dry run", at: "2026-10-18T02:00", status: "todo" },
    { phase: "Deploy", step: "Roll out", at: "2026-10-18T02:00", status: "blocked" },
    { phase: "After", step: "Notes", at: "2026-10-30T02:00", status: "todo" },
  ];
  const s = runbookStatus(p, NOW);
  assert.deepEqual(s.overdue, ["Dry run"]);
  assert.deepEqual(s.blocked, ["Roll out"]);
  assert.equal(s.done, 1);
});

test("the same engine gives NO-GO for the example release and GO for the clean one", () => {
  const run = (p) => evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  const bad = run(defaultPlan(NOW));
  assert.equal(bad.verdict.call, "NO-GO");
  const byId = (r, id) => r.criteria.find((c) => c.id === id);
  assert.equal(byId(bad, "p0").status, "fail");
  assert.equal(byId(bad, "migration").status, "fail");
  assert.equal(byId(bad, "points").status, "fail"); // 48% done
  assert.equal(byId(bad, "late").status, "warn");
  assert.equal(byId(bad, "ci").status, "warn"); // only quarantined checks failed
  assert.match(byId(bad, "late").detail, /3 PRs/);

  const good = run(cleanPlan());
  assert.equal(good.verdict.call, "GO", JSON.stringify(good.criteria.filter((c) => c.effective !== "pass").map((c) => [c.id, c.detail])));
});

test("story points drive the verdict: finishing the work clears the points criterion", () => {
  const p = cleanPlan();
  p.tickets[0].status = "In progress"; // 1 point of many is open
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  const pts = r.criteria.find((c) => c.id === "points");
  assert.equal(pts.status, "warn");
  assert.match(pts.detail, /remaining/);
});

test("a waiver recorded on the plan clears a failing criterion and shows in the brief", () => {
  const p = defaultPlan(NOW);
  p.waivers = { p0: { approver: "Sam Okafor", reason: "Hotfix 4.12.1 ships Friday", at: new Date(NOW).toISOString(), statusAtWaive: "fail" } };
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  assert.equal(r.criteria.find((c) => c.id === "p0").effective, "waived");
  const md = briefMarkdown(p, r, computeRisk(p, NOW), NOW);
  assert.match(md, /Waived by Sam Okafor: Hotfix 4\.12\.1 ships Friday/);
});

test("the brief covers who, what, when, where, how, points, risk, criteria and runbook", () => {
  const p = defaultPlan(NOW);
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  const md = briefMarkdown(p, r, computeRisk(p, NOW), NOW);
  for (const h of ["## What", "## Who", "## When", "## Where", "## How", "## Scope and story points", "## Risk analysis", "## Go/no-go criteria", "## Runbook"]) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.match(md, /\*\*Call: NO-GO\./);
  assert.match(md, /Release manager: Sam Okafor/);
});

test("manual check notes do not produce doubled punctuation", () => {
  const p = defaultPlan(NOW);
  p.people.releaseManager = "Marcus T.";
  p.checks.migration = "fail";
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  assert.doesNotMatch(r.criteria.find((c) => c.id === "migration").detail, /\.\./);
});

test("custom people and sign-off roles appear in the brief", () => {
  const p = defaultPlan(NOW);
  assert.deepEqual(p.extraPeople, []);
  p.extraPeople.push({ label: "Legal reviewer", name: "Nia Hart" }, { label: "Support lead", name: "" });
  p.signoffs.push({ role: "Legal", who: "Nia Hart", approved: true });
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  const md = briefMarkdown(p, r, computeRisk(p, NOW), NOW);
  assert.match(md, /- Legal reviewer: Nia Hart/);
  assert.match(md, /- Support lead: not set/);
  assert.match(md, /Legal \(Nia Hart, approved\)/);
  assert.match(r.criteria.find((c) => c.id === "signoffs").detail, /3 of 5 signed\. Waiting: Security, SRE on-call/);
});

test("a custom sign-off that is still pending holds the release; an approved one does not", () => {
  const p = cleanPlan();
  p.signoffs.push({ role: "Legal", who: "Nia Hart", approved: false });
  const run = () => evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  assert.equal(run().verdict.call, "HOLD");
  p.signoffs.at(-1).approved = true;
  assert.equal(run().verdict.call, "GO");
});

test("with no sign-offs required the criterion passes instead of reading 'all 0'", () => {
  const p = cleanPlan();
  p.signoffs = [];
  const c = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p)).criteria.find((x) => x.id === "signoffs");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /No sign-offs are required/);
});

test("clearing tickets and the runbook is safe for the engine, the risk model and the brief", () => {
  const p = defaultPlan(NOW);
  p.tickets = []; p.runbook = [];
  const r = evaluate(planToSnapshot(p, NOW), planConfig(p), planState(p));
  const risk = computeRisk(p, NOW);
  assert.equal(r.criteria.find((c) => c.id === "points").status, "pending"); // no points is unknown, not done
  assert.equal(r.criteria.find((c) => c.id === "runbook").status, "pending");
  assert.ok(risk.score >= 0 && risk.score <= 100);
  assert.doesNotThrow(() => briefMarkdown(p, r, risk, NOW));
});
