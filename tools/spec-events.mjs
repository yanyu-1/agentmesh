import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
const S = spec.components.schemas;

const ev = S.Event;
const names = (ev.anyOf || ev.oneOf || []).map((r) => r.$ref?.split("/").pop()).filter(Boolean);
console.log("Event union members:", names.length);
for (const n of names) {
  const s = S[n];
  if (!s) { console.log(`?? ${n} MISSING`); continue; }
  const props = s.properties || {};
  const typeConst = props.type ? (props.type.const ?? props.type.enum?.[0] ?? JSON.stringify(props.type).slice(0, 60)) : "(no type prop)";
  const keys = Object.keys(props).join(",");
  console.log(`${String(typeConst).padEnd(42)} <- ${n}  {${keys}}`);
}
