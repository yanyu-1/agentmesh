#!/usr/bin/env node
// Download the authoritative ACP + A2A protocol schemas so the adapters in this
// repo are written against a real spec rather than guesses.
// Writes into research/schemas/.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'research', 'schemas');

const H = { 'user-agent': 'agentmesh-schema-fetch/0.1' };

const FILES = [
  ['agentclientprotocol/agent-client-protocol', 'main', 'schema/v1/schema.json'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'schema/v1/meta.json'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'schema/v1/CHANGELOG.md'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'schema/v2/schema.json'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'schema/v2/meta.json'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/transports.mdx'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/initialization.mdx'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/prompt-turn.mdx'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/session-setup.mdx'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/tool-calls.mdx'],
  ['agentclientprotocol/agent-client-protocol', 'main', 'docs/protocol/v1/permission.mdx'],
  // A2A
  ['a2aproject/A2A', 'main', 'specification/a2a.proto'],
  ['a2aproject/A2A', 'main', 'specification/json/a2a.json'],
  ['a2aproject/A2A', 'main', 'README.md'],
];

await mkdir(OUT, { recursive: true });

const manifest = [];
for (const [repo, branch, path] of FILES) {
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  const name = `${repo.replace('/', '__')}__${path.replace(/\//g, '_')}`;
  try {
    const res = await fetch(raw, { headers: H, redirect: 'follow' });
    if (res.status !== 200) {
      console.log(`MISS  ${path} -> HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    await writeFile(join(OUT, name), text, 'utf8');
    console.log(`OK    ${path} (${text.length} bytes) -> ${name}`);
    manifest.push({ repo, branch, path, raw, bytes: text.length, local: name });
  } catch (e) {
    console.log(`ERR   ${path}: ${e.message}`);
  }
}

await writeFile(join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nDone: ${manifest.length}/${FILES.length} saved to research/schemas/`);
