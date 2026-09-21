#!/usr/bin/env node
/**
 * askpass — answer ONE ssh password prompt without touching stdin.
 *
 * Why this exists: ACP's only stable transport is stdio, so ssh's stdin IS the
 * JSON-RPC pipe. If ssh ever prompts for a password it reads from that pipe and
 * corrupts the protocol stream — which is exactly why `BatchMode=yes` is the
 * default. This helper is the safe way to use a password anyway: ssh runs it as a
 * separate process and reads the answer from ITS stdout, leaving the pipe alone.
 *
 * Usage (one-off bootstrap, e.g. to install a public key):
 *
 *   # tools/askpass.cjs must be preloaded into whichever node runs as askpass
 *   $env:SSH_ASKPASS          = (Get-Command node).Source
 *   $env:NODE_OPTIONS         = "--require D:\工作\tools\askpass.cjs"
 *   $env:MESH_ASKPASS_SECRET  = '<password>'
 *   $env:SSH_ASKPASS_REQUIRE  = 'force'
 *   ssh -p 22 user@host 'echo ok'
 *
 * The secret is read from the environment, never written to disk, and this file
 * exits before node tries to load ssh's prompt text as a script.
 */
process.stdout.write(`${process.env.MESH_ASKPASS_SECRET ?? ''}\n`);
process.exit(0);
