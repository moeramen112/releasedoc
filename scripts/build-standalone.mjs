// Builds dist/release-planner.html: the planner as one self-contained page with no server.
// It bundles deps.js, engine.js, risk.js, plan.js, history.js and plan-ui.js, each in its own scope so names cannot collide.
// Run: node scripts/build-standalone.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

/** Wrap a module in a function scope: strip `export`, rewrite imports to destructuring, return its exports. */
function wrap(name, src) {
  const exported = [];
  let body = src.replace(/^export\s+(const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => { exported.push(id); return `${kind} ${id}`; });
  body = body.replace(/^import\s+\{([^}]+)\}\s+from\s+"[^"]*?([\w-]+)\.js";?\s*$/gm, (_, names, mod) => `const {${names}} = __mod_${mod.replace(/-/g, "_")};`);
  return `const __mod_${name.replace(/-/g, "_")} = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();`;
}

const html = read("public/plan.html");
const bodyInner = html.slice(html.indexOf("<body>") + 6, html.indexOf('<script type="module"')).replace(/<nav class="nav"[\s\S]*?<\/nav>/, "").trim();
const css = read("public/styles.css");
const modules = [
  wrap("deps", read("src/deps.js")),
  wrap("engine", read("src/engine.js")),
  wrap("risk", read("src/risk.js")),
  wrap("plan", read("src/plan.js")),
  wrap("history", read("src/history.js")),
  wrap("html", read("src/html.js")),
  wrap("schedule", read("src/schedule.js")),
  wrap("schedule-view", read("src/schedule-view.js")),
  wrap("raid", read("src/raid.js")),
  wrap("import", read("src/import.js")),
].join("\n");
const scripts = [
  modules,
  `window.__STANDALONE = true;\n(() => {\n${read("public/plan-ui.js").replace(/function download\([^)]*\) \{[\s\S]*?\n\}\n/, "function download(name, text, type) { // embedded previews cannot save files; the GitHub Pages copy sets __DOWNLOADS\n  if (window.__DOWNLOADS !== true) return;\n  const url = URL.createObjectURL(new Blob([text], { type }));\n  const a = document.createElement(\"a\");\n  a.href = url; a.download = name;\n  document.body.appendChild(a); a.click(); a.remove();\n  setTimeout(() => URL.revokeObjectURL(url), 1000);\n}\n").replace(/^import\s+\{([^}]+)\}\s+from\s+"[^"]*?([\w-]+)\.js";?\s*$/gm, (_, names, mod) => `const {${names}} = __mod_${mod.replace(/-/g, "_")};`)}\n})();`,
].join("\n");

const headParts = `<title>Release Planner</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">
<style>
${css}
</style>`;
const bodyParts = `${bodyInner}
<script>
${scripts}
</script>`;
// The artifact host adds the document skeleton, so the fragment has no html, head or body tags.
const fragment = `${headParts}\n${bodyParts}\n`;

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist/release-planner.html"), fragment);
// A full document too, for opening the file directly from disk.
writeFileSync(path.join(root, "dist/release-planner.standalone.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${headParts}\n</head>\n<body>\n${bodyParts}\n</body>\n</html>\n`);
// A view-only copy of the same page, for sharing a link. It shows the example release and cannot be edited or saved.
const roScripts = scripts.replace("window.__STANDALONE = true;", "window.__STANDALONE = true;\nwindow.__READONLY = true;");
const roHead = headParts.replace("<title>Release Planner</title>", "<title>Release Planner Preview</title>");
writeFileSync(path.join(root, "dist/release-planner.readonly.html"), `${roHead}\n${bodyInner}\n<script>\n${roScripts}\n</script>\n`);
console.log(`Wrote dist/release-planner.html (${(fragment.length / 1024).toFixed(0)} KB)`);

// The calendar and RAID pages as one file each, for the GitHub Pages copy. They read the releases the planner saved in this browser.
function buildPage(name, title) {
  const src = read(`public/${name}.html`);
  const body = src.slice(src.indexOf("<body>") + 6, src.indexOf('<script type="module"')).replace(/href="\/(?:plan\.html)?"/g, 'href="index.html"').replace(/href="\/(calendar|raid)\.html"/g, 'href="$1.html"').trim();
  const js = read(`public/${name === "raid" ? "raid-page" : name}.js`).replace(/^import\s+\{([^}]+)\}\s+from\s+"[^"]*?([\w-]+)\.js";?\s*$/gm, (_, names, mod) => `const {${names}} = __mod_${mod.replace(/-/g, "_")};`);
  const extra = name === "raid" ? wrap("raid-view", read("src/raid-view.js")) : "";
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n<script>\n${modules}\n${extra}\nwindow.__STANDALONE = true;\n(() => {\n${js}\n})();\n</script>\n</body>\n</html>\n`;
}
const calPage = buildPage("calendar", "Release calendar");
const raidPage = buildPage("raid", "RAID log");
writeFileSync(path.join(root, "dist/release-calendar.html"), calPage);
writeFileSync(path.join(root, "dist/release-raid.html"), raidPage);

// The GitHub Pages site (docs/): the planner with downloads switched on, and the calendar beside it.
const standalone = read("dist/release-planner.standalone.html");
mkdirSync(path.join(root, "docs"), { recursive: true });
writeFileSync(path.join(root, "docs/index.html"), standalone.replace("window.__STANDALONE = true;", "window.__STANDALONE = true;\nwindow.__DOWNLOADS = true;"));
writeFileSync(path.join(root, "docs/calendar.html"), calPage);
writeFileSync(path.join(root, "docs/raid.html"), raidPage);
console.log("Wrote dist/release-calendar.html, dist/release-raid.html, docs/index.html, docs/calendar.html and docs/raid.html");
