import { readFileSync } from "node:fs";
const file = process.argv[2];
const t = readFileSync(file, "utf8");
// Capture: class X extends _HeyApiClient { ... }  and public method definitions with url
const lines = t.split(/\r?\n/);
let cls = "(top-level)";
const out = [];
for (let i = 0; i < lines.length; i++) {
  const cm = /^(?:export )?class (\w+)/.exec(lines[i].trim());
  if (cm) cls = cm[1];
  const mm = /^\s{2}public (\w+)[<(]/.exec(lines[i]);
  if (mm) {
    // look ahead for url:
    for (let j = i; j < Math.min(i + 30, lines.length); j++) {
      const um = /url:\s*["'`]([^"'`]+)["'`]/.exec(lines[j]);
      if (um) { out.push({ cls, method: mm[1], url: um[1] }); break; }
      const nm = /^\s{2}public \w+[<(]/.exec(lines[j]);
      if (j > i && nm) break;
    }
  }
}
for (const r of out) console.log(`${(r.cls + "." + r.method).padEnd(52)} ${r.url}`);
console.log("TOTAL:", out.length);
