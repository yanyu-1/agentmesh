import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
function resolve(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    const name = node.$ref.split("/").pop();
    if (seen.has(node.$ref)) return { $circular: name };
    const next = new Set(seen); next.add(node.$ref);
    const r = resolve(spec.components.schemas[name], next);
    return typeof r === "object" && r && !Array.isArray(r) ? { $name: name, ...r } : r;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string" && v.length > 200) { out[k] = v.slice(0, 200) + "…"; continue; }
    out[k] = resolve(v, seen);
  }
  return out;
}
for (const n of process.argv.slice(2)) {
  const s = spec.components.schemas[n];
  console.log("\n=========== " + n + " ===========");
  if (!s) { console.log("MISSING"); continue; }
  console.log(JSON.stringify(resolve(s), null, 1));
}
