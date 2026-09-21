// Self-test for tools/check-ui.mjs: it must actually FAIL on each defect class it claims
// to catch. A checker that only ever prints "OK" proves nothing.
//
// It calls `analyzeUi` directly instead of spawning the CLI, because spawning a child with
// piped stdio is denied inside the restricted sandbox (EPERM) — the same boundary that
// makes `node --test` unusable there. Importing keeps this runnable everywhere.
//
// Run: node tools/check-ui.selftest.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { analyzeUi } from './check-ui.mjs';

const SRC = new URL('../src/web/ui.html', import.meta.url);
const original = readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;

/**
 * Apply a mutation, refusing to continue if it did not actually change anything.
 *
 * This guard exists because it was needed: two cases below used to be written against
 * `$('a-http-fields').style.display`, and when the page was rewritten to toggle a class
 * instead, `String.replace` silently returned the input unchanged. The cases then asserted
 * "the checker fires" against an unmodified, correct page — which it does not — so they
 * failed for the right reason but would just as happily have passed vacuously if the
 * expectation had been looser. A mutation that did not mutate is not a test.
 *
 * @param {string} source
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function mutate(source, from, to) {
  if (!source.includes(from)) {
    throw new Error(`self-test mutation target is gone from ui.html: ${JSON.stringify(from.slice(0, 70))}`);
  }
  const out = source.replace(from, to);
  if (out === source) throw new Error(`self-test mutation was a no-op: ${JSON.stringify(from.slice(0, 70))}`);
  return out;
}

/**
 * @param {string} name
 * @param {string} mutated
 * @param {RegExp} expect
 */
function expectProblem(name, mutated, expect) {
  const { problems } = analyzeUi(mutated);
  const hit = problems.find((p) => expect.test(p));
  if (problems.length && hit) {
    pass += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    fail += 1;
    process.stdout.write(`  \u2717 ${name} — expected a problem matching ${expect}, got ${JSON.stringify(problems)}\n`);
  }
}

// The unmodified page must be clean.
{
  const { problems } = analyzeUi(original);
  assert.deepEqual(problems, [], 'the real ui.html must pass');
  pass += 1;
  process.stdout.write('  \u2713 the real ui.html passes\n');
}

expectProblem(
  'a syntax error in the inline script',
  mutate(original, 'function syncNodeForm() {', 'function syncNodeForm( {'),
  /does not compile/,
);

expectProblem(
  'a lookup for an element id that does not exist',
  mutate(original, "$('a-http-fields').classList.toggle('is-hidden', !httpish)", "$('a-nonexistent-field').classList.toggle('is-hidden', !httpish)"),
  /no element has id="a-nonexistent-field"/,
);

expectProblem(
  'a layout toggle driven by parentElement (the real browser-only bug)',
  mutate(
    original,
    "$('a-http-fields').classList.toggle('is-hidden', !httpish);",
    "$('a-url').parentElement.style.display = httpish ? '' : 'none';",
  ),
  /parentElement/,
);

expectProblem(
  'reading a data-* attribute nothing writes',
  mutate(original, "const t = $('a-transport').value;", 'const t = document.body.dataset.nothingSetsThis;'),
  /reads dataset\.nothingSetsThis/,
);

expectProblem(
  'a second inline script appearing in the page',
  mutate(original, '</body>', '<script>var extra = 1;</script></body>'),
  /expected exactly 1 inline <script>/,
);

// ---- the complaint that started this: a box you cannot attach to its label -----------
expectProblem(
  'a control with no label at all (the reported "I cannot tell which box is which")',
  mutate(
    original,
    '<label for="a-user">用户名</label>',
    '<span>用户名</span>',
  ).replace('<input id="a-user" placeholder="user" />', '<input id="a-user" placeholder="用户名" />'),
  /id="a-user".*has no label/,
);

expectProblem(
  'a caption wearing a <label> tag without being attached to a control',
  mutate(original, '<span class="flabel">会话</span>', '<label>会话</label>'),
  /neither wraps a control nor has for/,
);

expectProblem(
  'an inline style on an element (the layout jumble)',
  mutate(original, '<input id="a-port" placeholder="2222" />', '<input id="a-port" placeholder="2222" style="flex:0 0 110px;width:110px" />'),
  /inline style="flex:0 0 110px/,
);

expectProblem(
  'an inline style inside the generated markup',
  mutate(original, '<span class="node-actions">', '<span style="margin-left:auto;display:flex;gap:6px">'),
  /inline style="margin-left:auto/,
);

// ---- the checker must not fire on prose --------------------------------------------
// A comment that *describes* a defect is not a defect. Without comment stripping, adding an
// explanatory comment about the parentElement bug made the checker fail on a correct file,
// a phrase like "when talking to an agent (" was reported as an undeclared function, and a
// comment showing an example `<div style="…">` was reported as an inline style.
{
  const withComments = mutate(
    original,
    'function syncNodeForm() {',
    [
      'function syncNodeForm() {',
      "  // Do NOT do this: $('a-url').parentElement.style.display = 'none' hides the form.",
      '  // This used to be reported as a call to agent ( and as an undeclared global.',
      '  // Nor like this: <div style="flex:0 0 230px"> — widths belong in the stylesheet.',
    ].join('\n'),
  );
  const { problems, notes } = analyzeUi(withComments);
  const noise = notes.find((n) => /not declared here/.test(n));
  if (problems.length === 0 && !noise) {
    pass += 1;
    process.stdout.write('  \u2713 a comment describing a defect is not reported as one\n');
  } else {
    fail += 1;
    process.stdout.write(`  \u2717 comments leaked into the analysis: problems=${JSON.stringify(problems)} noise=${noise}\n`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
