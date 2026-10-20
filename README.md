# Release Readiness

A go/no-go tool for release managers. It answers one question, "can we ship?", from the data you already have, and it keeps a record of who accepted which risk.

![Dashboard](docs/dashboard.png)

## The problem

Before a release, someone collects status by hand from the issue tracker, CI, the security scanner and a dozen Slack threads, then argues about whether it is safe to ship. The answer is in a spreadsheet nobody trusts and a meeting nobody enjoys. This tool puts that answer in one place, computed from the same rules every time, with the reasons attached.

## What it does

**Dashboard (`/`)** reads a real release from GitHub (and Jira, if configured) and shows a Go, Hold or No-Go call with the criteria behind it.

**Planner (`/plan.html`)** is for entering a release by hand, or pulling its Jira tickets and story points. It produces:

- the same go/no-go call, using the same engine
- a risk score out of 100 with a breakdown by factor, plain-language recommendations, and a suggested staged rollout
- a story-point forecast: points done, points remaining, and whether the team's velocity can finish before the freeze
- a runbook, prefilled from the dates, owners and rollout strategy
- a release brief in Markdown (who, what, when, where, how, risk, criteria, runbook) to paste into Slack or Confluence

![Planner](docs/planner.png)

## Run it

Needs Node 20 or newer. No dependencies to install.

```bash
npm run demo     # invented data, opens at http://localhost:3000
npm start        # live data, see "Connect your tools"
npm test         # 56 tests
```

`dist/release-planner.standalone.html` is the planner as a single file with no server. Open it in a browser. It has no GitHub or Jira connection and no downloads, but everything else works, and it saves your plan in the browser.

## Connect your tools

Copy `.env.example` and set what you have. Everything is optional.

| Variable | What it enables |
|---|---|
| `GITHUB_TOKEN` | Higher rate limit and private repositories. Public repositories work without it. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Open P0/P1 issues on the dashboard, and **Pull from Jira** in the planner (tickets plus story points). |
| `SLACK_WEBHOOK_URL` | **Post to Slack** sends the current call and what is holding the release. |

Edit `readiness.config.json` to change the repository, release branch, label names, JQL, the Jira story-points field (`customfield_10016` on most sites, but it varies), and the list of criteria.

## How it works

```
GitHub ─┐
Jira ───┼─► snapshot ─► engine ─► verdict + criteria ─► dashboard
Form ───┘   (one shape)  (pure)                         planner, brief, Slack
                          ▲
              waivers and manual checks (the audit log)
```

- **One engine.** Every source is normalised to one snapshot shape, and a pure function turns a snapshot plus the config into criteria and a verdict. The server and the browser run the same file, so the dashboard and the planner cannot disagree.
- **Missing data never passes.** If GitHub rate-limits a call or Jira is down, the affected criterion shows as pending with the reason, and the release cannot read GO.
- **Waivers are accountable.** Accepting a risk needs a named approver and a reason. A waiver stops applying if the criterion gets worse afterwards, and every change goes to an audit log.
- **Criteria are config.** Which checks count, whether they are required, and how strict they are all live in the config, not in code.
- **Tokens stay on the server.** The browser never sees them. Changes require a custom header and a same-origin request, so another web page cannot post to a dashboard running on localhost.

## The risk model

Twelve factors, weighted to add up to 100. The weights are in `src/risk.js` and each has a test.

| Factor | Max | What drives it |
|---|---|---|
| Open defects | 18 | P0 bugs 10 each, P1 4, P2 1 |
| Unfinished scope | 16 | Share of story points not done, plus a penalty if velocity cannot finish before the freeze or work is open after it |
| Data migration | 10 | In scope and not dry-run on production-size data |
| Rollback readiness | 8 | Not rehearsed, no written plan, or a target over 30 minutes |
| Test and security health | 8 | Real failing checks, quarantined failures, coverage, p95 latency, vulnerabilities |
| Size of the change | 7 | Files and lines against a budget |
| Late and unreviewed changes | 7 | Merged after the freeze, merged without an approval |
| Deploy timing | 7 | Friday, weekend, business hours, long windows |
| Payments, auth and data changes | 6 | Open tickets in sensitive areas count most, missing tests count extra |
| Large tickets still open | 5 | Tickets over a point threshold that are not done |
| Rollout strategy | 5 | All-at-once is worst, canary with flags that default off is best |
| Unestimated tickets | 3 | Open work with no story points |

Levels: under 25 Low, under 50 Moderate, under 75 High, otherwise Critical. Each level suggests a rollout ladder: for example Low is 10%, 50%, 100% with a 15 minute bake, and High starts at 1% with an hour at each stage.

## Layout

```
src/engine.js      criteria evaluators, waivers, verdict (pure)
src/risk.js        story points, forecast, risk score (pure)
src/plan.js        the plan, templates, runbook generator, brief (pure)
src/sources/       GitHub, Jira, and demo-data adapters
src/server.js      HTTP server and JSON API
public/            dashboard and planner (plain JS, no build step)
test/              56 tests, including a mock GitHub and a mock Jira
scripts/           build-standalone.mjs makes the single-file planner
```

## Limits to know about

- State is a JSON file (`data/`). It is fine for one team and not for many people editing at once.
- There is no login. Run it on localhost or behind your own proxy.
- The Jira search uses the current `/rest/api/3/search/jql` endpoint and the story-points field name must be set for your site. I tested it against a mock, not a live Jira.
- Scores are a starting point for a conversation. The weights are opinions, and they are easy to change.

## Where it goes next

1. Read CI status from the CI provider directly, and map it to the release branch automatically.
2. Learn the weights from history: which factors preceded a rollback or an incident.
3. Post to Slack on a schedule, and when a criterion changes state.
4. Per-team criteria sets, and a record of every release for trend reporting.

## Demo script (three minutes)

1. **The problem (20 seconds).** "Release readiness lives in people's heads and in five tools. Someone assembles it by hand before every go/no-go."
2. **The dashboard (60 seconds).** Open `/` in demo mode. Point at the NO-GO and the three reasons under it. "Everything on the right is computed, nothing is typed in." Click Waive on a failing criterion, show that it demands a named approver and a reason, and show the audit log.
3. **The planner (60 seconds).** Open `/plan.html`. Change the P0 ticket to Done and watch the call and risk score move. Change the deploy time to a Friday afternoon and show the timing risk. Clear all tickets, then Undo.
4. **The brief (20 seconds).** Copy Markdown and show it is a complete release document.
5. **The design choice (20 seconds).** "If a data source is down, that criterion is pending, not passing. A tool that says GO when it cannot see is worse than no tool."

Questions to expect: why these weights (opinions with tests, meant to be tuned), what about monorepos or many services (one release per config today, and the per-team config is the next step), how it would connect to your systems (adapters return one shape, so a new source is one file).
