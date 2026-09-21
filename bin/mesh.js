#!/usr/bin/env node
/**
 * AgentMesh CLI entry point.
 *
 * Node prints an ExperimentalWarning every time `node:sqlite` is imported, which
 * would otherwise prepend noise to every single command's output (and to the
 * `--json` output scripts parse). Filter exactly that one warning and leave every
 * other warning intact.
 */

const originalEmit = process.emitWarning;

/**
 * @param {any} warning
 * @param  {...any} rest
 */
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : String(warning?.message ?? '');
  const name = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  return originalEmit.call(process, warning, ...rest);
};

const { loadSecrets } = await import('../src/core/secrets.js');
const { main } = await import('../src/cli/main.js');
const { color } = await import('../src/cli/render.js');

// Load saved secrets before anything reads a node. `Registry.resolveSshPassword` resolves an
// `ssh.passwordEnv` name through `process.env`, so doing it here is what makes a saved password
// survive a restart — for every command, not just `serve` — without the registry, the fleet or
// any adapter needing to know this file exists.
try {
  loadSecrets();
} catch (err) {
  // A broken secrets file must not take the whole CLI down: commands that do not need a password
  // still work, and the ones that do will say what is missing.
  process.stderr.write(`${color.red('warning:')} could not read the secrets file: ${err instanceof Error ? err.message : String(err)}\n`);
}

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (err) {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`${color.red('fatal:')} ${msg}\n`);
  process.exitCode = 1;
}
