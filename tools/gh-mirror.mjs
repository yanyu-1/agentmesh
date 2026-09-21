#!/usr/bin/env node
// Mirror selected paths from a GitHub repo at a given ref into a local cache.
// Usage: node tools/gh-mirror.mjs <owner/repo> <ref> <prefix1> [prefix2] ...
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [repo, ref, ...prefixes] = process.argv.slice(2);
const H = { "user-agent": "research/0.1", accept: "application/vnd.github+json" };
const OUT = join(process.cwd(), "cache", repo.replace("/", "__"), ref);

const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers: H });
if (!treeRes.ok) { console.error("tree failed", treeRes.status, await treeRes.text()); process.exit(1); }
const tree = await treeRes.json();
console.log("truncated:", tree.truncated, "entries:", tree.tree.length);

const files = tree.tree
  .filter((e) => e.type === "blob")
  .filter((e) => prefixes.length === 0 || prefixes.some((p) => e.path.startsWith(p)));

console.log("matched:", files.length);
let ok = 0, fail = 0;
const CONC = 12;
let i = 0;
async function worker() {
  while (i < files.length) {
    const f = files[i++];
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${f.path}`;
    try {
      const r = await fetch(url, { headers: { "user-agent": "research/0.1" } });
      if (!r.ok) { fail++; console.error("FAIL", r.status, f.path); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const dest = join(OUT, f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      ok++;
    } catch (e) { fail++; console.error("ERR", f.path, e.message); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`done ok=${ok} fail=${fail} -> ${OUT}`);
