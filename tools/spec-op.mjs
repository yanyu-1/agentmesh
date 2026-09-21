import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));

function resolve(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return { $circular: node.$ref };
    const next = new Set(seen);
    next.add(node.$ref);
    const p = node.$ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const k of p) cur = cur?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
    const r = resolve(cur, next);
    const extra = {};
    for (const [k, v] of Object.entries(node)) if (k !== "$ref") extra[k] = v;
    return typeof r === "object" && r && !Array.isArray(r) ? { $refName: node.$ref.split("/").pop(), ...r, ...extra } : r;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string" && v.length > 300) { out[k] = v.slice(0, 300) + "…"; continue; }
    out[k] = resolve(v, seen);
  }
  return out;
}

const mode = process.argv[2];
if (mode === "--codesamples") {
  const rows = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      if (!op || !op.operationId) continue;
      for (const s of op["x-codeSamples"] || []) {
        rows.push({ id: op.operationId, m: m.toUpperCase(), p, lang: s.lang, src: (s.source || "").replace(/\s+/g, " ") });
      }
    }
  }
  for (const r of rows) console.log(`${r.id}\t${r.m} ${r.p}\t[${r.lang}] ${r.src}`);
  console.log("TOTAL codesamples:", rows.length);
  process.exit(0);
}

const target = mode;
const method = (process.argv[3] || "").toLowerCase();
const item = spec.paths[target];
if (!item) { console.error("no path", target); process.exit(1); }
const ops = method ? { [method]: item[method] } : item;
for (const [m, op] of Object.entries(ops)) {
  if (!op || !op.operationId) continue;
  console.log("\n########## " + m.toUpperCase() + " " + target + "   [" + op.operationId + "]");
  if (op.summary) console.log("summary: " + op.summary);
  if (op.parameters?.length) {
    console.log("-- parameters --");
    for (const p of op.parameters) console.log(`  ${p.in} ${p.name}${p.required ? " REQUIRED" : ""} :: ${JSON.stringify(p.schema)}`);
  }
  if (op.requestBody) {
    console.log("-- requestBody" + (op.requestBody.required ? " REQUIRED" : "") + " --");
    for (const [ct, c] of Object.entries(op.requestBody.content || {})) console.log(`  [${ct}]\n` + JSON.stringify(resolve(c.schema), null, 1));
  }
  for (const [code, r] of Object.entries(op.responses || {})) {
    console.log(`-- response ${code}: ${r.description || ""} --`);
    for (const [ct, c] of Object.entries(r.content || {})) console.log(`  [${ct}]\n` + JSON.stringify(resolve(c.schema), null, 1));
  }
}
