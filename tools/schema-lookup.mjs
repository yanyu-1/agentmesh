#!/usr/bin/env node
// Print the exact protocol shapes the adapters must implement, pulled straight
// from the downloaded schemas (no guessing).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const S = join(ROOT, 'research', 'schemas');

const ACP = join(S, 'agentclientprotocol__agent-client-protocol__schema_v1_schema.json');
const A2A = join(S, 'a2aproject__A2A__specification_a2a.proto');

const acp = JSON.parse(await readFile(ACP, 'utf8'));

console.log('### ACP top-level keys:', Object.keys(acp).join(', '));
const defs = acp.$defs || acp.definitions || {};
const keys = Object.keys(defs);
console.log(`### ACP $defs: ${keys.length} definitions\n`);

const pick = (re) => keys.filter((k) => re.test(k));

function dump(key, maxChars = 3000) {
  const d = defs[key];
  if (!d) return console.log(`--- ${key}: (not found)\n`);
  const s = JSON.stringify(d, null, 1);
  console.log(`--- ${key} ---\n${s.length > maxChars ? s.slice(0, maxChars) + '\n...[truncated]' : s}\n`);
}

console.log('### Session-related defs:', pick(/Session|New|Load|Resume/).join(', '), '\n');
console.log('### Permission-related defs:', pick(/Permission/).join(', '), '\n');
console.log('### Update-related defs:', pick(/Update/).join(', '), '\n');
console.log('### Content-related defs:', pick(/Content|Text|Image|Resource/).join(', '), '\n');

for (const k of ['NewSessionRequest', 'NewSessionResponse', 'RequestPermissionRequest', 'RequestPermissionResponse', 'PermissionOption']) {
  dump(k, 2200);
}

// The session/update payload is a discriminated union - list its variants.
for (const k of pick(/^SessionUpdate/)) {
  const d = defs[k];
  const variants = d?.oneOf || d?.anyOf || d?.allOf;
  if (variants) {
    console.log(`--- ${k} variants ---`);
    for (const v of variants) {
      const ref = v.$ref ? v.$ref.split('/').pop() : null;
      const props = v.properties ? Object.keys(v.properties) : null;
      console.log('  ', ref || JSON.stringify(v).slice(0, 160));
      if (props) console.log('      props:', props.join(', '));
    }
    console.log('');
  }
}

// ---- A2A ----
const proto = await readFile(A2A, 'utf8');
console.log('\n\n===================== A2A (a2a.proto) =====================');
const msgs = [...proto.matchAll(/^message\s+(\w+)\s*\{/gm)].map((m) => m[1]);
console.log('### A2A messages:', msgs.join(', '));
const svcs = [...proto.matchAll(/^service\s+(\w+)/gm)].map((m) => m[1]);
console.log('### A2A services:', svcs.join(', '));
const rpcs = [...proto.matchAll(/^\s*rpc\s+(\w+)\s*\(([^)]*)\)\s*returns\s*\(([^)]*)\)/gm)];
console.log('### A2A rpcs:');
for (const [, name, req, res] of rpcs) console.log(`   ${name}(${req.trim()}) -> ${res.trim()}`);

for (const name of ['Message', 'Part', 'SendMessageRequest', 'SendMessageResponse', 'Task', 'TaskStatus', 'AgentCard', 'AgentSkill', 'AgentInterface', 'TaskState']) {
  const re = new RegExp(`(?:^|\\n)(message\\s+${name}\\s*\\{[\\s\\S]*?\\n\\}|enum\\s+${name}\\s*\\{[\\s\\S]*?\\n\\})`, 'm');
  const m = proto.match(re);
  if (m) {
    const s = m[1];
    console.log(`\n--- ${name} ---\n${s.length > 1800 ? s.slice(0, 1800) + '\n...[truncated]' : s}`);
  }
}
