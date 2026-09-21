// Tests for the "fetch will refuse this port" guard.
//
// This file exists because of a real intermittent failure: `test/orchestrator.test.js`
// failed once in 24 full runs with `fetch failed (bad port)` against a fake LLM server on
// port 6566. The port was open and correct; `fetch` refuses it by spec. A suite that fails
// at random teaches people to re-run it and ignore red, so the guard is tested rather than
// trusted.
//
// Run: node test/net.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { BLOCKED_FETCH_PORTS, isBlockedFetchPort, listenOnFetchablePort } from '../src/core/transport/net.js';

test('the blocked list contains the ports that caused the flake', () => {
  // 6566 (sane-port) is the one actually observed; the rest are the neighbours a reviewer
  // would want to see covered.
  for (const port of [6566, 6000, 6667, 4045, 10080, 5060, 4190, 22, 25]) {
    assert.equal(isBlockedFetchPort(port), true, `${port} must be treated as blocked`);
  }
  for (const port of [7331, 2222, 49152, 51234, 9900, 4096]) {
    assert.equal(isBlockedFetchPort(port), false, `${port} must be treated as usable`);
  }
  assert.equal(isBlockedFetchPort('7331'), false, 'string ports are coerced');
});

test('the hardcoded list still matches what this Node actually refuses', async () => {
  // The list is a copy of a spec table that Node could change. Rather than trust it,
  // verify a sample both ways: blocked entries must really fail, usable entries must
  // really work. If this fails after a Node upgrade, the list is what needs updating.
  //
  // The blocked half must name concrete ports — that is the entire point — and 6566/6000
  // are safe to name: they sit far below the ephemeral range and nothing in AgentMesh uses
  // them. The usable half must NOT name a concrete port. The first version of this test
  // hardcoded 7331 (this program's own default console port) and 2222 (the test NAS's ssh
  // port), so the suite died with `EADDRINUSE` whenever a console was running — which is
  // *always*, while working on the console. A test may not compete with the application for
  // the application's own default port, and it must not squat on a real service's port.
  const blockedSamples = [6566, 6000];

  for (const port of blockedSamples) {
    const server = createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/`),
        (err) => /bad port/i.test(String(err.cause?.message ?? err.message)),
        `${port} is listed as blocked and fetch must refuse it`,
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  }

  // The usable direction, on a port obtained at runtime so nothing else can be holding it.
  // `isBlockedFetchPort` agreeing is not enough — it is the same table we are testing — so
  // the real assertion is that fetch actually succeeds.
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    const port = await listenOnFetchablePort(server);
    assert.equal(isBlockedFetchPort(port), false, `${port} came back as fetchable yet the list calls it blocked`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, `${port} is not listed as blocked, so fetch must work`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test('listenOnFetchablePort never returns a port fetch would refuse', async () => {
  // Run it enough times that a lucky single draw is not mistaken for correctness.
  for (let i = 0; i < 40; i += 1) {
    const server = createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    try {
      const port = await listenOnFetchablePort(server);
      assert.ok(port > 0, 'a real port must be bound');
      assert.equal(isBlockedFetchPort(port), false, `draw ${i} returned a blocked port ${port}`);
      // And prove it end to end, which is the property that actually matters.
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  }
});

test('listenOnFetchablePort reports failure instead of looping forever', async () => {
  const server = createServer();
  try {
    // Inject "everything is blocked" rather than mutating the exported list: mutating
    // shared module state is exactly the kind of cross-test leakage this suite has been
    // bitten by before, and the first version of this test corrupted the list.
    await assert.rejects(
      listenOnFetchablePort(server, '127.0.0.1', 2, () => true),
      /could not obtain a port/,
    );
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
  // The real predicate must be untouched.
  assert.equal(BLOCKED_FETCH_PORTS.size, 82, 'the exported list must not have been mutated');
});
