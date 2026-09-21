import { readFileSync, writeFileSync } from "node:fs";
const spec = JSON.parse(readFileSync("cache/anomalyco__opencode/dev/packages/sdk/openapi.json", "utf8"));
const v1 = [], v2 = [];
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!op || !op.operationId) continue;
    (p.startsWith("/api/") ? v2 : v1).push([m.toUpperCase(), p, op.operationId]);
  }
}
v1.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
v2.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
const rows = (arr) => arr.map((r) => `| \`${r[0]}\` | \`${r[1]}\` | \`${r[2]}\` |`).join("\n");
writeFileSync(
  "research/_endpoints.md",
  `V1_COUNT=${v1.length} V2_COUNT=${v2.length}\n\n### V1\n\n| METHOD | PATH | operationId |\n| --- | --- | --- |\n${rows(v1)}\n\n### V2\n\n| METHOD | PATH | operationId |\n| --- | --- | --- |\n${rows(v2)}\n`,
);
console.log("V1", v1.length, "V2", v2.length);
