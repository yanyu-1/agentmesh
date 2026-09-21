import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
console.log("openapi:", spec.openapi, "| info:", JSON.stringify(spec.info));
const paths = spec.paths || {};
const rows = [];
for (const [p, item] of Object.entries(paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
    rows.push({ m: m.toUpperCase(), p, id: op.operationId || "", sum: (op.summary || "").replace(/\s+/g, " ").slice(0, 90) });
  }
}
rows.sort((a, b) => a.p.localeCompare(b.p) || a.m.localeCompare(b.m));
console.log("TOTAL OPERATIONS:", rows.length, "| PATHS:", Object.keys(paths).length);
for (const r of rows) console.log(`${r.m.padEnd(6)} ${r.p.padEnd(56)} ${r.id}`);
