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
    if (k === "description" && typeof v === "string" && v.length > 160) { out[k] = v.slice(0, 160) + "…"; continue; }
    out[k] = resolve(v, seen);
  }
  return out;
}
const what = process.argv[2]; // "req" | "res" | "all"
const path = process.argv[3];
const meth = (process.argv[4] || "post").toLowerCase();
const op = spec.paths[path][meth];
console.log(`### ${meth.toUpperCase()} ${path} [${op.operationId}]`);
if (op.parameters?.length) for (const p of op.parameters) console.log(`  param ${p.in} ${p.name}${p.required ? " REQUIRED" : ""} :: ${JSON.stringify(p.schema)}`);
if (what !== "res" && op.requestBody) {
  console.log("-- requestBody" + (op.requestBody.required ? " REQUIRED" : "") + " --");
  for (const [ct, c] of Object.entries(op.requestBody.content || {})) console.log(`[${ct}]\n` + JSON.stringify(resolve(c.schema), null, 1));
}
if (what !== "req") {
  for (const [code, r] of Object.entries(op.responses || {})) {
    if (code !== "200" && what === "res") continue;
    if (what === "res" && code !== "200") continue;
    console.log(`-- response ${code} --`);
    for (const [ct, c] of Object.entries(r.content || {})) console.log(`[${ct}]\n` + JSON.stringify(resolve(c.schema), null, 1));
  }
}
