import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
function shape(node, depth, seen) {
  if (!node || typeof node !== "object") return "?";
  if (node.$ref) {
    const n = node.$ref.split("/").pop();
    if (seen.has(n) || depth > 3) return n;
    const s = new Set(seen); s.add(n);
    return shape(spec.components.schemas[n], depth, s) + "  /* " + n + " */";
  }
  if (node.anyOf || node.oneOf) {
    const parts = (node.anyOf || node.oneOf).map((x) => shape(x, depth + 1, seen));
    const names = (node.anyOf || node.oneOf).map((x) => x.$ref?.split("/").pop()).filter(Boolean);
    if (names.length) return "(" + names.join(" | ") + ")";
    return "(" + [...new Set(parts)].slice(0, 6).join(" | ") + ")";
  }
  if (node.type === "array") return shape(node.items, depth + 1, seen) + "[]";
  if (node.type === "object" || node.properties || node.additionalProperties) {
    if (node.properties) {
      const req = new Set(node.required || []);
      const inner = Object.entries(node.properties).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${shape(v, depth + 1, seen)}`);
      return "{ " + inner.join(", ") + " }";
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object")
      return `{ [string]: ${shape(node.additionalProperties, depth + 1, seen)} }`;
    return "object";
  }
  if (node.enum) return node.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (node.const !== undefined) return JSON.stringify(node.const);
  return node.type || "any";
}
const [, , path, meth] = process.argv;
const op = spec.paths[path][(meth || "get").toLowerCase()];
console.log(`${(meth || "get").toUpperCase()} ${path}  [${op.operationId}]`);
if (op.parameters?.length) for (const p of op.parameters) console.log(`  param ${p.in} ${p.name}${p.required ? " REQUIRED" : ""}: ${shape(p.schema, 0, new Set())}`);
for (const [code, r] of Object.entries(op.responses || {})) {
  if (code !== "200" && code !== "204") continue;
  for (const [ct, c] of Object.entries(r.content || {})) {
    console.log(`  200 [${ct}] => ${shape(c.schema, 0, new Set())}`);
  }
  if (!r.content) console.log(`  ${code} (no body) ${r.description || ""}`);
}
