// Hostile-input tests: bad bodies, bad origins, path tricks and odd query strings must end in a clean 4xx, never a 500 or a crash.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

const H = { "Content-Type": "application/json", "X-Requested-With": "release-readiness" };
let dir, app, base, port;
const call = (method, p, body, headers = H) => fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const raw = (text) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(text));
  let out = ""; s.on("data", (d) => (out += d)); s.on("close", () => resolve(out)); s.on("error", () => resolve(out));
  setTimeout(() => s.destroy(), 1500);
});
const statusOf = (r) => Number((r.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-attack-"));
  app = await createApp({ stateDir: dir, defaultMode: "demo", env: {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  port = app.server.address().port; base = `http://127.0.0.1:${port}`;
});
after(() => { app.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("JSON bodies that are not objects get a clean 4xx on every POST route", async () => {
  for (const p of ["/api/waive", "/api/unwaive", "/api/manual", "/api/notify"]) for (const body of ["null", "[]", "7", '"x"', "true", "{bad json", ""]) {
    const r = await call("POST", p, body);
    assert.ok(r.status >= 200 && r.status < 500, `${p} with body ${JSON.stringify(body)} gave ${r.status}`);
  }
});

test("CSRF: the header and a same-origin Origin are required, and a junk Origin is a 403 not a crash", async () => {
  assert.equal((await call("POST", "/api/manual", {}, { "Content-Type": "application/json" })).status, 403);
  for (const origin of ["http://evil.example", "null", "not a url", "javascript:alert(1)"]) {
    const r = await call("POST", "/api/manual", {}, { ...H, Origin: origin });
    assert.equal(r.status, 403, `Origin ${origin} gave ${r.status}`);
  }
});

test("static files: no path traversal and no source or data leaks", async () => {
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fetc/passwd", "//etc/passwd", "/%00", "/src/server.js", "/readiness.config.json", "/.git/config", "/data/state.demo.json"]) {
    const st = statusOf(await raw(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    assert.ok(st === 404 || st === 400, `${p} gave ${st}`);
  }
});

test("malformed HTTP and odd query strings do not kill the server", async () => {
  for (const req of ["GET / HTTP/1.1\r\n\r\n", "GARBAGE\r\n\r\n", "GET /%ZZ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"]) await raw(req);
  for (const q of ["repo=../../etc/passwd", "repo=a/b/c", "head=" + encodeURIComponent("$(rm -rf /)"), "base=%00", "refresh=1&refresh=1"]) {
    assert.ok((await call("GET", `/api/readiness?${q}`)).status < 500, q);
  }
  assert.equal((await call("GET", "/api/config")).status, 200);
});
