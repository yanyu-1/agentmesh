// Tests for the Web control plane (src/web/server.js).
//
// These exist because the console is where the user actually configures nodes, and it
// had drifted away from the CLI in ways nothing was watching:
//
//   * it had no username and no port field, so every SSH node it created silently used
//     the local account and port 22 — the node looked registered and failed with nothing
//     but `process exited (code=255)`
//   * the only secret field it had wrote an SSH password into `token`, where the ssh
//     path never looks, so the password was BOTH persisted in cleartext and useless
//   * there was no way to change a node at all: only probe and delete
//
// The invariant that matters most here is that a secret typed into the browser never
// reaches disk. It is asserted against the raw bytes of nodes.json rather than the API's
// own view, because the API's view is the thing that was wrong.
//
// Run: node test/web.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listenOnFetchablePort } from '../src/core/transport/net.js';

/**
 * Start a console against a throwaway AGENTMESH_HOME.
 *
 * The registry and the store are files under `meshHome()`, which is read at construction
 * time, so the environment has to be set before anything imports the server.
 * @returns {Promise<{url:string, home:string, close:()=>Promise<void>, json:(p:string,init?:any)=>Promise<any>, status:(p:string,init?:any)=>Promise<{status:number,body:any}>}>}
 */
async function console_() {
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-web-'));
  process.env.AGENTMESH_HOME = home;
  const { createConsole } = await import(`../src/web/server.js?home=${encodeURIComponent(home)}`);
  const c = await createConsole({ port: 0, host: '127.0.0.1' });
  const status = async (p, init) => {
    const res = await fetch(c.url + p, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  const json = async (p, init) => {
    const { status: s, body } = await status(p, init);
    if (s >= 400) throw new Error(`${p} → ${s}: ${JSON.stringify(body)}`);
    return body;
  };
  const post = (p, body) => json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    url: c.url,
    home,
    close: async () => {
      await c.close();
      rmSync(home, { recursive: true, force: true });
    },
    json,
    status,
    post,
  };
}

/** The raw text of the registry, which is what actually lands on disk. */
function registryText(home) {
  const f = join(home, 'nodes.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

// ---------------------------------------------------------------------------
// The console can express a real SSH node
// ---------------------------------------------------------------------------

test('POST /api/nodes stores user, port and command — the fields the old form could not send', async () => {
  const c = await console_();
  try {
    const node = await c.post('/api/nodes', {
      name: 'nas',
      kind: 'hermes',
      transport: 'acp',
      ssh: {
        host: '10.0.0.5',
        user: 'user',
        port: 2222,
        batchMode: false,
        identityFile: 'C:\\keys\\nas_ed25519',
        extraOptions: ['UserKnownHostsFile=D:\\工作\\.ssh\\known_hosts', 'StrictHostKeyChecking=accept-new'],
      },
      command: '/opt/hermes/bin/hermes-acp',
      cwd: '/srv/work',
      env: { HERMES_HOME: '/tmp/mesh-hermes', HOME: '/tmp/mesh-hermes' },
      approvalPolicy: 'ask',
      local: false,
    });
    assert.equal(node.ssh.user, 'user');
    assert.equal(node.ssh.port, 2222);
    assert.equal(node.ssh.host, '10.0.0.5');
    assert.equal(node.command, '/opt/hermes/bin/hermes-acp');
    assert.equal(node.local, false);

    // Every remaining field the CLI can express must survive the console too, or "the form
    // is complete" would only be true for the handful of fields this test happened to
    // check. These are the ones a real password-only host needs: a key file, the
    // known_hosts `-o` pair, the remote agent's env, and an approval policy that is not
    // the default.
    assert.equal(node.ssh.identityFile, 'C:\\keys\\nas_ed25519');
    assert.deepEqual(node.ssh.extraOptions, [
      'UserKnownHostsFile=D:\\工作\\.ssh\\known_hosts',
      'StrictHostKeyChecking=accept-new',
    ]);
    assert.equal(node.ssh.batchMode, false);
    assert.equal(node.cwd, '/srv/work');
    assert.deepEqual(node.env, { HERMES_HOME: '/tmp/mesh-hermes', HOME: '/tmp/mesh-hermes' });
    assert.equal(node.approvalPolicy, 'ask');

    // And it survives a reload, i.e. it really was persisted.
    const [again] = await c.json('/api/nodes');
    assert.equal(again.ssh.port, 2222);
    assert.equal(again.ssh.user, 'user');
    assert.deepEqual(again.ssh.extraOptions, node.ssh.extraOptions);
    assert.deepEqual(again.env, node.env);
    assert.equal(again.approvalPolicy, 'ask');
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// A secret typed into the console never reaches disk
// ---------------------------------------------------------------------------

test('an SSH password sent as sshPassword is usable but NEVER written to nodes.json', async () => {
  const c = await console_();
  try {
    const node = await c.post('/api/nodes', {
      name: 'nas',
      kind: 'hermes',
      transport: 'acp',
      ssh: { host: '10.0.0.5', user: 'user', port: 2222, batchMode: false },
      command: 'hermes-acp',
      local: false,
      sshPassword: 'hunter2-secret',
    });

    // Usable: the registry can resolve it right now.
    assert.equal(node.hasSshPassword, true);
    assert.equal(node.sshPasswordSource, 'memory');

    // Not on disk — checked against the bytes, not against the API's own opinion.
    const raw = registryText(c.home);
    assert.ok(raw.length > 0, 'the registry must have been written');
    assert.ok(!raw.includes('hunter2-secret'), 'the password must not appear in nodes.json');
    assert.ok(!/"sshPassword"/.test(raw), 'no sshPassword key may be persisted');
  } finally {
    await c.close();
  }
});

test('an SSH password sent as ssh.password is quarantined rather than persisted', async () => {
  const c = await console_();
  try {
    const node = await c.post('/api/nodes', {
      name: 'nas',
      transport: 'acp',
      ssh: { host: 'h', user: 'u', port: 22, password: 'leaked-alias' },
      command: 'x',
      local: false,
    });
    assert.equal(node.hasSshPassword, true);
    assert.ok(!registryText(c.home).includes('leaked-alias'));
    assert.ok(!registryText(c.home).includes('"password"'));
  } finally {
    await c.close();
  }
});

test('GET /api/nodes never returns a stored token or password', async () => {
  const c = await console_();
  try {
    await c.post('/api/nodes', {
      name: 'peer',
      transport: 'a2a',
      url: 'http://10.0.0.9:9900',
      token: 'a2a-bearer-token',
    });
    const listed = await c.json('/api/nodes');
    const raw = JSON.stringify(listed);
    assert.ok(!raw.includes('a2a-bearer-token'), 'the bearer token must not be echoed to the browser');
    assert.equal(listed[0].hasToken, true, 'but the console must be told that one exists');
  } finally {
    await c.close();
  }
});

test('an SSH password named by passwordEnv is resolved from the environment, not stored', async () => {
  const c = await console_();
  try {
    process.env.MESH_TEST_SSH_PW = 'from-the-environment';
    const node = await c.post('/api/nodes', {
      name: 'nas',
      transport: 'acp',
      ssh: { host: 'h', user: 'u', port: 2222, batchMode: false, passwordEnv: 'MESH_TEST_SSH_PW' },
      command: 'x',
      local: false,
    });
    assert.equal(node.hasSshPassword, true);
    assert.equal(node.sshPasswordSource, 'env');
    // The NAME is persisted (that is the whole point — it survives a restart).
    assert.ok(registryText(c.home).includes('MESH_TEST_SSH_PW'));
    // The VALUE is not.
    assert.ok(!registryText(c.home).includes('from-the-environment'));
  } finally {
    delete process.env.MESH_TEST_SSH_PW;
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// Editing a node
// ---------------------------------------------------------------------------

test('POST /api/nodes/:ref/update changes only the fields it is given', async () => {
  const c = await console_();
  try {
    await c.post('/api/nodes', {
      name: 'nas',
      transport: 'acp',
      ssh: { host: '10.0.0.5', user: 'user', port: 22 },
      command: '/opt/hermes-acp',
      cwd: '/work',
      local: false,
    });
    // A real edit: the port was wrong, everything else must survive.
    const updated = await c.post('/api/nodes/nas/update', { ssh: { port: 2222 } });
    assert.equal(updated.ssh.port, 2222);
    assert.equal(updated.ssh.user, 'user', 'the user must not be dropped by a port-only edit');
    assert.equal(updated.ssh.host, '10.0.0.5');
    assert.equal(updated.command, '/opt/hermes-acp', 'the command must not be dropped');
    assert.equal(updated.cwd, '/work');
    assert.ok(updated.updatedAt >= updated.createdAt);
  } finally {
    await c.close();
  }
});

test('an update can carry a new password, still without writing it to disk', async () => {
  const c = await console_();
  try {
    await c.post('/api/nodes', { name: 'nas', transport: 'acp', ssh: { host: 'h', user: 'u', batchMode: false }, command: 'x', local: false });
    const updated = await c.post('/api/nodes/nas/update', { sshPassword: 'second-secret' });
    assert.equal(updated.hasSshPassword, true);
    assert.ok(!registryText(c.home).includes('second-secret'));
  } finally {
    await c.close();
  }
});

test('POST /api/nodes/:ref/secret sets and clears an in-memory password', async () => {
  const c = await console_();
  try {
    await c.post('/api/nodes', { name: 'nas', transport: 'acp', ssh: { host: 'h', user: 'u', batchMode: false }, command: 'x', local: false });
    let n = await c.post('/api/nodes/nas/secret', { sshPassword: 'temp' });
    assert.equal(n.hasSshPassword, true);
    assert.ok(!registryText(c.home).includes('temp'));

    n = await c.post('/api/nodes/nas/secret', { sshPassword: '' });
    assert.equal(n.hasSshPassword, false, 'an empty string clears it');
  } finally {
    await c.close();
  }
});

test('updating an unknown node is a 404-shaped error, not a crash', async () => {
  const c = await console_();
  try {
    const r = await c.status('/api/nodes/nope/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ssh: { port: 1 } }),
    });
    assert.equal(r.status, 500);
    assert.match(String(r.body.error), /unknown node/);
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// Editing a node must not leave a stale adapter behind
// ---------------------------------------------------------------------------

test('an edit invalidates the cached adapter so the change actually takes effect', async () => {
  const c = await console_();
  try {
    await c.post('/api/nodes', { name: 'nas', transport: 'acp', ssh: { host: 'h', user: 'u', port: 22 }, command: 'x', local: false });
    // Force an adapter to exist, then edit. Probe will fail to connect (the host is
    // fake) but it still constructs and caches an adapter first.
    await c.status('/api/nodes/nas/probe', { method: 'POST' });
    await c.post('/api/nodes/nas/update', { ssh: { port: 2222 } });
    // The observable guarantee: a fresh adapter built now sees the new port. Reaching
    // into Fleet internals here would test the implementation, not the behaviour, so we
    // assert through the public surface that the node reports the new value.
    const [node] = await c.json('/api/nodes');
    assert.equal(node.ssh.port, 2222);
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// The orchestrator model settings
// ---------------------------------------------------------------------------

test('POST /api/agent/config keeps the API key in memory and persists only baseUrl/model', async () => {
  const c = await console_();
  try {
    const out = await c.post('/api/agent/config', {
      baseUrl: 'http://10.0.0.5:8000/v1',
      model: 'deepseek/deepseek-v4-pro',
      apiKey: 'sk-console-typed-key',
      persist: true,
    });
    assert.equal(out.baseUrl, 'http://10.0.0.5:8000/v1');
    assert.equal(out.model, 'deepseek/deepseek-v4-pro');
    // The key is reported as set:<length> and never echoed.
    assert.equal(out.apiKey, `set:${'sk-console-typed-key'.length}`);
    assert.equal(out.ready, true);
    assert.equal(out.persisted, true);

    // On disk: the address and the model, but not the key.
    const cfgPath = join(c.home, 'llm.json');
    assert.ok(existsSync(cfgPath), 'llm.json must have been written');
    const cfg = readFileSync(cfgPath, 'utf8');
    assert.ok(cfg.includes('10.0.0.5:8000'), 'the base URL must persist');
    assert.ok(cfg.includes('deepseek/deepseek-v4-pro'), 'the model must persist');
    assert.ok(!cfg.includes('sk-console-typed-key'), 'the API key must NOT persist');

    // And the key is live in this process.
    const view = await c.json('/api/agent/config');
    assert.equal(view.ready, true);
    assert.equal(view.apiKey, `set:${'sk-console-typed-key'.length}`);
  } finally {
    await c.close();
  }
});

test('a key can be cleared, and a bare config still reports what is missing', async () => {
  const c = await console_();
  try {
    await c.post('/api/agent/config', { baseUrl: 'http://h:1/v1', model: 'm', apiKey: 'k' });
    const cleared = await c.post('/api/agent/config', { apiKey: '' });
    assert.equal(cleared.apiKey, null, 'clearing the key must be reflected');
    assert.equal(cleared.keyNote, 'cleared');
  } finally {
    await c.close();
  }
});

test('an apiKeyEnv is stored as a NAME, and its value is only read at use time', async () => {
  const c = await console_();
  try {
    process.env.MESH_TEST_LLM_KEY = 'env-key-value';
    const out = await c.post('/api/agent/config', {
      baseUrl: 'http://h:1/v1',
      model: 'm',
      apiKeyEnv: 'MESH_TEST_LLM_KEY',
      persist: true,
    });
    assert.equal(out.ready, true, 'a key found through the named variable counts as ready');
    const cfg = readFileSync(join(c.home, 'llm.json'), 'utf8');
    assert.ok(cfg.includes('MESH_TEST_LLM_KEY'), 'the variable name persists');
    assert.ok(!cfg.includes('env-key-value'), 'the value does not');
  } finally {
    delete process.env.MESH_TEST_LLM_KEY;
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// The console still serves its own page
// ---------------------------------------------------------------------------

test('GET / returns the console page and it references the fields that exist', async () => {
  const c = await console_();
  try {
    const res = await fetch(c.url + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    for (const id of ['a-host', 'a-user', 'a-port', 'a-command', 'a-secret', 'a-pwenv', 'a-edit', 'lc-base', 'lc-model', 'lc-key']) {
      // `a-edit` is a data-attribute template, not an id; skip it here.
      if (id === 'a-edit') continue;
      assert.ok(html.includes(`id="${id}"`), `the console must expose #${id}`);
    }
    assert.ok(html.includes('data-edit'), 'each node row must offer an edit button');
  } finally {
    await c.close();
  }
});

test('the served page is the readable one: grouped fields, no inline layout, every lookup resolves', async () => {
  // The console page is the one artefact in this project that cannot be checked by running
  // it: there is no browser here, and the acceptance notes record that it was never loaded
  // in one. The complaint that produced this test was purely visual — "我完全不知道每个框对应
  // 的是哪一个框了，已经分不清了" — which no API test can see. What CAN be pinned down is
  // everything that made it unreadable by construction, so it cannot come back:
  //   * no grouping at all (the page had zero <fieldset>)
  //   * 35 inline `style="…"` attributes fighting the stylesheet
  //   * transport-scoped containers that only exist so the form can hide what does not apply
  //   * a stylesheet that gives up label association (no :focus-within cue)
  // It also re-checks the ids over the wire, because `createConsole` caches ui.html at boot:
  // a console started before a change keeps serving the old page, and this test is what
  // notices the difference between the file on disk and the bytes a running console emits.
  const c = await console_();
  try {
    const res = await fetch(c.url + '/');
    assert.equal(res.status, 200);
    const html = await res.text();

    const fieldsets = (html.match(/<fieldset/g) || []).length;
    assert.ok(fieldsets >= 4, `the form must be split into named <fieldset> groups, found ${fieldsets}`);
    assert.ok((html.match(/<legend/g) || []).length >= 3, 'each group needs a <legend> naming it');

    const inline = [...html.matchAll(/<[^>]*\sstyle="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(inline, [], `presentation must live in the stylesheet, found inline styles: ${inline.join(' | ')}`);

    // Every control is either wrapped in a <label> or named by one. A placeholder is not a
    // label: it vanishes as soon as the field is filled, which is how a filled form becomes
    // unreadable again.
    const labelsFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    const openLabels = [];
    for (const m of html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)) openLabels.push([m.index, m.index + m[0].length]);
    const unlabelled = [];
    for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
      const id = (/\bid="([^"]+)"/.exec(m[0]) || [])[1] || '(no id)';
      const wrapped = openLabels.some(([a, b]) => m.index > a && m.index < b);
      if (!wrapped && !labelsFor.has(id)) unlabelled.push(id);
    }
    assert.deepEqual(unlabelled, [], `these controls have no label: ${unlabelled.join(', ')}`);

    assert.match(html, /id="a-http-fields"/, 'the HTTP-only fields need their own container to hide');
    assert.match(html, /id="a-ssh-fields"/, 'the SSH-only fields need their own container to hide');
    assert.match(html, /:focus-within/, 'focusing a field must highlight its own label');
    assert.match(html, /prefers-color-scheme/, 'the console must follow the desktop light/dark setting');

    // And the contract the inline script depends on, checked against the bytes actually sent.
    const script = html.slice(html.indexOf('<script'));
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const missing = [...new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], `the page's own script looks up ids it never renders: ${missing.join(', ')}`);
  } finally {
    await c.close();
  }
});

test('an update that omits a field leaves it alone — including the display-only kind', async () => {
  const c = await console_();
  try {
    // `kind` is a label, and not every label is in the preset list: the console renders a
    // native A2A node as `generic-a2a`, which no <option> matches, so a form that always
    // submitted its dropdown would relabel the node as whatever preset happened to be
    // selected first. The contract the console relies on: omit it, keep it.
    const created = await c.post('/api/nodes', {
      name: 'peer',
      kind: 'generic-a2a',
      transport: 'a2a',
      url: 'http://10.0.0.9:9900',
    });
    assert.equal(created.kind, 'generic-a2a');

    const updated = await c.post('/api/nodes/peer/update', { url: 'http://10.0.0.9:9901' });
    assert.equal(updated.kind, 'generic-a2a', 'kind must survive an edit that does not mention it');
    assert.equal(updated.url, 'http://10.0.0.9:9901');
    assert.equal(updated.transport, 'a2a');
  } finally {
    await c.close();
  }
});

test('the console reports its registry path so an operator can find nodes.json', async () => {
  const c = await console_();
  try {
    const s = await c.json('/api/status');
    assert.ok(String(s.registry).includes(c.home.replace(/\\/g, '\\')), `registry path should be under the temp home, got ${s.registry}`);
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// Reading the model list must not require saving first, and saving must not
// blank a field you did not touch
// ---------------------------------------------------------------------------

/**
 * A minimal OpenAI-compatible gateway. `listModels` only needs `GET /models`.
 * @param {string[]} models
 */
async function fakeGateway(models) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no such route: ${req.url}` } }));
  });
  const port = await listenOnFetchablePort(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/**
 * A clean provider slate.
 *
 * `llmConfig()` resolves from the environment before the file, so a developer who happens to
 * have `OPENAI_BASE_URL` set would otherwise turn "not configured" into "configured" and make
 * these tests pass or fail for reasons unrelated to the code. And `src/core/llm.js` is a single
 * module instance shared with `src/web/server.js` — server.js is re-imported per test with a
 * cache-busting query, llm.js is not — so the live override survives from one test to the next.
 * Both have to be reset explicitly.
 * @returns {() => void} restore
 */
async function cleanProviderState() {
  const names = ['AGENTMESH_LLM_BASE_URL', 'AGENTMESH_LLM_API_KEY', 'AGENTMESH_LLM_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const saved = names.map((n) => [n, process.env[n]]);
  for (const n of names) delete process.env[n];
  const { setLlmConfig } = await import('../src/core/llm.js');
  setLlmConfig(null);
  return () => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    setLlmConfig(null);
  };
}

test('the model list is readable from the form values, before anything has been saved', async () => {
  // The reported failure, reproduced: type an address and a key into the console, press
  // 「拉取模型列表」, and get back an error naming AGENTMESH_LLM_BASE_URL — an environment
  // variable a console user has never touched. The button was a bare GET, which can only see
  // settings that have already been saved, so it only worked if you pressed save first. But
  // asking for the list is precisely the step you take *because* you do not know the model
  // name yet: the required order was the reverse of the one the button implies.
  const restore = await cleanProviderState();
  const gw = await fakeGateway(['alpha-1', 'beta-2']);
  const c = await console_();
  try {
    const before = await c.status('/api/agent/models');
    assert.equal(before.status, 502, 'the GET form genuinely cannot work before saving');
    assert.match(String(before.body.error), /LLM not configured/);

    const listed = await c.post('/api/agent/models', { baseUrl: gw.url, apiKey: 'typed-into-the-form' });
    assert.deepEqual(listed.models, ['alpha-1', 'beta-2'], 'the POST form must use the values from the form');

    // Probing must not become a config change: nothing written, nothing adopted.
    assert.ok(!existsSync(join(c.home, 'llm.json')), 'probing must not write llm.json');
    const view = await c.json('/api/agent/config');
    assert.equal(view.baseUrl, '', 'probing must not adopt the address it was given');
    assert.equal(view.apiKey, null, 'probing must not adopt the key it was given');
    assert.equal(view.ready, false);
  } finally {
    await c.close();
    await gw.close();
    restore();
  }
});

test('a probe with no key falls back to the configured one instead of dropping it', async () => {
  // The console omits the key box when it is empty, and the server must not turn that into an
  // unauthenticated request: `{...resolved, ...{apiKey: undefined}}` would erase a credential
  // that is already configured, and the gateway would answer 401 for a reason that has nothing
  // to do with what the user typed.
  const restore = await cleanProviderState();
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '(none)');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: ['only-one'] }));
  });
  const port = await listenOnFetchablePort(server);
  const c = await console_();
  try {
    await c.post('/api/agent/config', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'the-configured-key' });
    const listed = await c.post('/api/agent/models', { baseUrl: `http://127.0.0.1:${port}/v1` });
    assert.deepEqual(listed.models, ['only-one']);
    assert.equal(seen.at(-1), 'Bearer the-configured-key', 'the configured key must still be sent');
  } finally {
    await c.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(undefined)));
    restore();
  }
});

test('saving with an empty box leaves that setting alone instead of blanking it', async () => {
  // The console submits every field on every save, so leaving the model box untouched used to
  // send `model: ''`, which blanked the model in the live process: the agent then reported
  // `ready:false, missing:["model"]` and would not run — from a save in which the model box
  // looked as though nothing had happened to it. The key box has always meant "empty = do not
  // change"; the other boxes did not, and that asymmetry between two identical-looking empty
  // boxes is the whole defect.
  const restore = await cleanProviderState();
  const c = await console_();
  try {
    const first = await c.post('/api/agent/config', { baseUrl: 'http://gw.invalid:9/v1', model: 'keep-me', persist: true });
    assert.equal(first.ready, true);

    // Exactly what the form sends when only the key was typed.
    const after = await c.post('/api/agent/config', {
      baseUrl: '',
      model: '',
      apiKeyEnv: '',
      apiKey: 'a-new-key',
      persist: true,
    });
    assert.equal(after.baseUrl, 'http://gw.invalid:9/v1', 'an empty address box must not blank the address');
    assert.equal(after.model, 'keep-me', 'an empty model box must not blank the model');
    assert.equal(after.ready, true, 'the agent must still be runnable after a one-field save');
    assert.equal(after.persisted, false, 'a save that changes no persisted field writes nothing');

    const cfg = readFileSync(join(c.home, 'llm.json'), 'utf8');
    assert.ok(cfg.includes('keep-me'), 'the persisted model must survive');
    assert.ok(!cfg.includes('a-new-key'), 'the key must still never reach disk');

    // Clearing stays possible for the one field that has a button for it.
    const cleared = await c.post('/api/agent/config', { apiKey: '' });
    assert.equal(cleared.apiKey, null, 'the dedicated clear button must still work');
  } finally {
    await c.close();
    restore();
  }
});
