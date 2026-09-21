/**
 * Listening on a port that `fetch` will actually talk to.
 *
 * `server.listen(0)` asks the OS for any free port. Some of the ports it can hand back are
 * on the WHATWG fetch spec's **blocked port list** (sane-port 6566, X11 6000, IRC 6667,
 * and about seventy others). `fetch()` refuses those outright:
 *
 *     Error: cannot reach http://127.0.0.1:6566/v1/chat/completions:
 *            fetch failed (bad port)
 *
 * The port is genuinely open — `curl` reaches it happily — but fetch will not connect. So
 * a test that starts a fake server on port 0 and then talks to it with `fetch` fails
 * roughly once every few dozen runs, depending on which port the OS picks. That is how
 * this module came to exist: `test/orchestrator.test.js` failed with exactly that message
 * once in twenty-four full runs, and the failing test had nothing to do with the code
 * under test.
 *
 * A flake like that is worse than a hard failure: it teaches everyone to re-run the suite
 * and ignore a red result.
 *
 * @module core/transport/net
 */

/**
 * Ports the fetch spec forbids, verified against this Node rather than copied from the
 * spec text — `test/net.test.js` re-verifies a sample, so a change in Node shows up as a
 * failing test instead of as an intermittent mystery.
 */
export const BLOCKED_FETCH_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * Is this port one that `fetch` refuses to connect to?
 * @param {number} port
 * @returns {boolean}
 */
export function isBlockedFetchPort(port) {
  return BLOCKED_FETCH_PORTS.has(Number(port));
}

/**
 * Listen on an ephemeral port that `fetch` can reach.
 *
 * Re-rolls when the OS hands out a blocked port. The retry is not a hack around a rare
 * case: the port is chosen by the OS, so the only place to fix it is here, and a handful
 * of retries makes landing on the blocked list twice in a row vanishingly unlikely.
 *
 * @param {import('node:http').Server} server
 * @param {string} [host]
 * @param {number} [attempts]
 * @param {(port:number)=>boolean} [isBlocked] injectable so the give-up path can be
 *   tested without mutating the exported list (which would leak into other tests)
 * @returns {Promise<number>} the port actually bound
 */
export async function listenOnFetchablePort(server, host = '127.0.0.1', attempts = 12, isBlocked = isBlockedFetchPort) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => server.listen(0, host, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!isBlocked(port)) return port;
    // Close before re-rolling: two bound sockets would make the retry meaningless.
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(
    `could not obtain a port that fetch will connect to after ${attempts} attempts ` +
      '(every draw landed on the WHATWG blocked-port list, which should be impossible)',
  );
}
