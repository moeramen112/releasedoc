// HTTP server: serves the dashboard and a small JSON API.
// Tokens stay on the server. The browser never sees them.

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluate, openBlockerCount } from "./engine.js";
import { buildSnapshot } from "./snapshot.js";
import { createStore, auditEntry } from "./state.js";
import { DEMO_SEED } from "./sources/fixture.js";
import { jiraConfigured, fetchJiraRelease } from "./sources/jira.js";
import { buildSlackMessage, sendSlack } from "./notify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const CACHE_MS = 60_000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REF_RE = /^[\w./@+-]{1,200}$/;

/** Demo mode: DEMO=1 in the environment, or the --demo flag, which also works on Windows. */
const isDemo = () => process.env.DEMO === "1" || process.argv.includes("--demo");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createApp({ configPath = path.join(ROOT, "readiness.config.json"), stateDir = process.env.STATE_DIR || path.join(ROOT, "data"), defaultMode = isDemo() ? "demo" : "live", env = process.env, deps = {} } = {}) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const stores = {};
  // Waivers, manual checks and the audit log belong to one release, so each repo and release branch gets its own file.
  const storeKey = ({ mode, release }) => (mode === "demo" ? "demo" : `live.${release.repo}@${release.headRef}`.toLowerCase().replace(/\//g, "__").replace(/[^a-z0-9@._-]+/g, "-"));
  const getStore = async (t) => {
    const key = storeKey(t);
    return (stores[key] ||= await createStore(path.join(stateDir, key === "demo" ? "state.demo.json" : `state.${key}.json`), t.mode === "demo" ? DEMO_SEED : undefined));
  };
  const cache = new Map();
  const manualIds = new Set(config.criteria.filter((c) => c.type === "manual").map((c) => c.params.checkId));

  /** Work out which release and mode a request is about. Overrides are validated. */
  function target(query) {
    const mode = query.get("demo") === "1" ? "demo" : query.get("demo") === "0" ? "live" : defaultMode;
    const release = { ...config.release };
    const repo = query.get("repo"), base = query.get("base"), head = query.get("head");
    if (repo) { if (!REPO_RE.test(repo)) throw new HttpError(400, "Repository must look like owner/name."); release.repo = repo; }
    if (base) { if (!REF_RE.test(base)) throw new HttpError(400, "Base ref has unsupported characters."); release.baseRef = base; }
    if (head) { if (!REF_RE.test(head)) throw new HttpError(400, "Head ref has unsupported characters."); release.headRef = head; }
    return { mode, release };
  }

  async function snapshotFor({ mode, release }, refresh) {
    const key = JSON.stringify([mode, release.repo, release.baseRef, release.headRef]);
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.snapshot;
    const snapshot = await buildSnapshot({ release, config, mode, env, deps });
    cache.set(key, { at: Date.now(), snapshot });
    return snapshot;
  }

  async function payload(t, refresh = false) {
    const store = await getStore(t);
    const snapshot = await snapshotFor(t, refresh);
    const result = evaluate(snapshot, config, store.get());
    const key = `${t.mode}:${t.release.repo}@${t.release.headRef}`;
    const open = openBlockerCount(snapshot);
    await store.mutate((s) => {
      const last = [...s.history].reverse().find((h) => h.key === key);
      if (!last || last.call !== result.verdict.call || last.open !== open || Date.now() - Date.parse(last.t) > 600_000) {
        s.history.push({ key, t: new Date().toISOString(), call: result.verdict.call, open });
      }
    });
    const state = store.get();
    return {
      mode: t.mode,
      snapshot,
      result,
      history: state.history.filter((h) => h.key === key).slice(-60),
      audit: state.audit.slice(-25).reverse(),
      integrations: { github: Boolean(env.GITHUB_TOKEN), jira: jiraConfigured(env), slack: Boolean(env.SLACK_WEBHOOK_URL) },
    };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 65536) throw new HttpError(413, "Request body too large.");
      chunks.push(c);
    }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
    catch { throw new HttpError(400, "Body must be JSON."); }
  }

  // Mutating routes need a custom header and a same-origin request, which blocks
  // a random web page from posting to a dashboard running on localhost.
  function guard(req) {
    if (req.headers["x-requested-with"] !== "release-readiness") throw new HttpError(403, "Missing X-Requested-With header.");
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused.");
  }

  const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);

  const routes = {
    "GET /api/config": async () => ({
      release: config.release,
      defaultMode,
      criteria: config.criteria.map(({ id, name, type, source, required, params }) => ({ id, name, type, source: source || "github", required: required !== false, checkId: type === "manual" ? params.checkId : undefined })),
      integrations: { github: Boolean(env.GITHUB_TOKEN), jira: jiraConfigured(env), slack: Boolean(env.SLACK_WEBHOOK_URL) },
    }),

    "GET /api/readiness": async (req, url) => payload(target(url.searchParams), url.searchParams.get("refresh") === "1"),

    // Tickets and story points for the planner. Needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server.
    "GET /api/jira/issues": async (req, url) => {
      if (!jiraConfigured(env)) throw new HttpError(400, "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server.");
      const version = text(url.searchParams.get("version"), 80);
      if (!version) throw new HttpError(400, "Enter the Jira fix version first.");
      try {
        const issues = await (deps.fetchJiraRelease || fetchJiraRelease)({ version, config, env });
        return { version, issues };
      } catch (e) {
        throw new HttpError(502, e.message);
      }
    },

    "POST /api/waive": async (req, url) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      const current = evaluate(await snapshotFor(t, false), config, store.get());
      const crit = current.criteria.find((c) => c.id === body.id);
      if (!crit) throw new HttpError(404, "Unknown criterion.");
      if (crit.status === "pass") throw new HttpError(400, "That criterion is passing, so there is nothing to waive.");
      const approver = text(body.approver, 80), reason = text(body.reason, 400);
      if (!approver) throw new HttpError(400, "Name the person who approves this waiver.");
      if (reason.length < 8) throw new HttpError(400, "Give a reason of at least a few words.");
      await store.mutate((s) => {
        s.waivers[crit.id] = { approver, reason, at: new Date().toISOString(), statusAtWaive: crit.status };
        s.audit.push(auditEntry("waive", approver, `${crit.name} (${crit.status}): ${reason}`));
      });
      return payload(t);
    },

    "POST /api/unwaive": async (req, url) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      const by = text(body.by, 80);
      if (!by) throw new HttpError(400, "Say who is removing this waiver.");
      await store.mutate((s) => {
        if (!s.waivers[body.id]) throw new HttpError(404, "No waiver on that criterion.");
        delete s.waivers[body.id];
        s.audit.push(auditEntry("unwaive", by, `Removed waiver on ${body.id}`));
      });
      return payload(t);
    },

    "POST /api/manual": async (req, url) => {
      guard(req);
      const body = await readBody(req);
      const t = target(url.searchParams);
      const store = await getStore(t);
      if (!manualIds.has(body.checkId)) throw new HttpError(404, "Unknown manual check.");
      if (!["pass", "fail", "unset"].includes(body.state)) throw new HttpError(400, "State must be pass, fail or unset.");
      const by = text(body.by, 80);
      if (body.state !== "unset" && !by) throw new HttpError(400, "Say who is confirming this check.");
      await store.mutate((s) => {
        if (body.state === "unset") delete s.manual[body.checkId];
        else s.manual[body.checkId] = { state: body.state, by, note: text(body.note, 300), at: new Date().toISOString() };
        s.audit.push(auditEntry("manual", by || "unknown", `${body.checkId} set to ${body.state}${body.note ? ": " + text(body.note, 300) : ""}`));
      });
      return payload(t);
    },

    "POST /api/notify": async (req, url) => {
      guard(req);
      const body = await readBody(req);
      if (!env.SLACK_WEBHOOK_URL) throw new HttpError(400, "Slack is not configured. Set SLACK_WEBHOOK_URL.");
      const t = target(url.searchParams);
      const data = await payload(t);
      const dashboardUrl = env.PUBLIC_URL || undefined;
      await (deps.sendSlack || sendSlack)(env.SLACK_WEBHOOK_URL, buildSlackMessage({ release: data.snapshot.release, result: data.result, dashboardUrl }));
      const store = await getStore(t);
      await store.mutate((s) => { s.audit.push(auditEntry("notify", text(body.by, 80), `Posted ${data.result.verdict.call} to Slack`)); });
      return payload(t);
    },
  };

  // The browser runs the same pure modules as the server, so the planner and the dashboard cannot disagree.
  const SHARED = { "/engine.js": "engine.js", "/risk.js": "risk.js", "/plan.js": "plan.js", "/deps.js": "deps.js", "/history.js": "history.js" };

  async function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = SHARED[rel] ? path.join(ROOT, "src", SHARED[rel]) : path.join(PUBLIC, path.normalize(rel));
    if (!SHARED[rel] && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, "Not found.");
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(buf);
    } catch { throw new HttpError(404, "Not found."); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    try {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) return send(200, await handler(req, url));
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, res);
      throw new HttpError(404, "Not found.");
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (url.pathname.startsWith("/api/")) return send(status, { error: status === 500 ? "Something went wrong on the server." : e.message });
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(e.message);
    }
  });

  return { server, config };
}

// Run directly: node src/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const { server } = await createApp();
  server.listen(port, host, () => {
    const mode = isDemo() ? "demo data" : "live data";
    console.log(`Release readiness running on http://${host}:${port} (${mode})`);
    if (!isDemo() && !process.env.GITHUB_TOKEN) console.log("No GITHUB_TOKEN set: public repositories only, with GitHub's low anonymous rate limit.");
  });
}
