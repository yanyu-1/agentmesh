import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
const S = spec.components.schemas;
const nameOf = (v) => {
  if (!v || typeof v !== "object") return "?";
  if (v.$ref) return v.$ref.split("/").pop();
  if (v.anyOf) return "(" + v.anyOf.map(nameOf).join(" | ") + ")";
  if (v.type === "array") return "[" + nameOf(v.items) + "]";
  if (v.enum) return v.enum.map((e) => JSON.stringify(e)).join("|");
  if (v.type === "object" && v.properties) return "{" + Object.keys(v.properties).join(",") + "}";
  return v.type || "any";
};
for (const n of process.argv.slice(2)) {
  const s = S[n];
  if (!s) { console.log(n, "MISSING"); continue; }
  const props = s.properties?.properties?.properties;
  if (!props) { console.log(n, "=> (no properties)", JSON.stringify(s).slice(0, 300)); continue; }
  const req = new Set(s.properties.properties.required || []);
  console.log(n + "  =>  " + Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${nameOf(v)}`).join(", "));
}
