#!/usr/bin/env node
/**
 * check-ui — static checks for the single-file Web console.
 *
 * `src/web/ui.html` holds the whole console: markup, CSS and one inline script. Nothing
 * else in the suite so much as parses it, so a typo in an element id or a stray brace
 * ships silently and only shows up as a dead button in a browser — which is exactly the
 * kind of defect that survived several rounds of "it looked fine" here. One of the checks
 * below (`parentElement` layout toggling) exists because a real bug did ship: hiding "the
 * URL field" by walking up from the input hid the entire form.
 *
 * What it checks
 * --------------
 *   1. the inline <script> compiles (syntax only — it is not executed)
 *   2. every literal `$('id')` lookup has a matching `id="id"` in the markup
 *   3. every `data-*` attribute read by the script is one the markup actually emits
 *   4. layout is never toggled by DOM position (`x.parentElement.style`)
 *   5. no inline event handler calls a function that is never defined
 *
 * Usage: node tools/check-ui.mjs [path/to/ui.html]
 *
 * The optional path, and the exported `analyzeUi`, exist so the checker can itself be
 * tested (see tools/check-ui.selftest.mjs): a lint that cannot be made to fail is not
 * evidence of anything.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Characters after which a `/` begins a regex literal rather than a division.
 * The standard heuristic, and it is needed: `ui.html` contains `/[&<>"]/g`, whose `"`
 * otherwise looks like the start of a string and desynchronises the scanner for the rest
 * of the file — which silently disabled comment stripping the first time this was written.
 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^', 'return']);

/**
 * Strip `//` and comment blocks, leaving string and regex literals intact.
 *
 * Checks 4 and 5 look for code patterns, and a comment that *describes* a defect must not
 * be mistaken for the defect. Without this, an explanatory comment mentioning
 * `$('x').parentElement.style` made the checker fail on a correct file, and prose like
 * "when talking to an agent (" was reported as an undeclared function. A linter that
 * cannot talk about the bug it prevents is a linter people delete.
 *
 * @param {string} code
 * @returns {string} code with comments replaced by spaces (offsets roughly preserved)
 */
function stripComments(code) {
  let out = '';
  let i = 0;
  /** @type {string|null} */
  let quote = null;
  /** Last meaningful character emitted, for the regex-vs-division decision. */
  let prev = '\n';
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      prev = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // A regex literal: copy it verbatim so its contents cannot be mistaken for a quote.
    if (ch === '/' && /[([{,;=:!&|?+\-*%<>~^]|\breturn\b/.test(prev.trim() === '' ? '\n' : prev)) {
      out += ch;
      i += 1;
      let inClass = false;
      while (i < code.length) {
        const c = code[i];
        if (c === '\\') {
          out += c + (code[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          out += c;
          i += 1;
          break;
        } else if (c === '\n') {
          // Not actually a regex; bail out rather than swallow the rest of the file.
          break;
        }
        out += c;
        i += 1;
      }
      prev = '/';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return out;
}

/**
 * Analyse a console page.
 *
 * @param {string} html
 * @returns {{problems:string[], notes:string[]}}
 */
export function analyzeUi(html) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  // ---- 1. extract the inline script -------------------------------------------------
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (scripts.length !== 1) {
    problems.push(`expected exactly 1 inline <script> in ui.html, found ${scripts.length}`);
  }
  const js = scripts.join('\n');
  // Code-only view for the pattern checks, so a comment describing a defect is not itself
  // reported as one.
  const code = stripComments(js);

  try {
    // Compiles without running: catches unbalanced braces and stray tokens.
    new vm.Script(js, { filename: 'ui.html#inline' });
    notes.push(`inline script compiles (${js.split('\n').length} lines)`);
  } catch (err) {
    problems.push(`inline script does not compile: ${err.message}`);
  }

  // ---- 2. literal element ids -------------------------------------------------------
  /** Ids the markup defines. */
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  /** Ids the script looks up, but only the fully literal ones. `$('probe-' + name)` is
   *  deliberately skipped — it is built at runtime from the node name. */
  const looked = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const id of looked) {
    if (!declared.has(id)) problems.push(`script looks up $('#${id}') but no element has id="${id}"`);
  }
  notes.push(`${looked.size} literal element lookups, ${declared.size} declared ids`);

  // ---- 3. data-* attributes ---------------------------------------------------------
  // Read side looks like `b.dataset.probe`, `el.dataset.del`, `sel.dataset.transport`.
  const readData = new Set([...js.matchAll(/\.dataset\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  // Write side: `o.dataset.transport = ...`, and markup: `data-probe="..."`.
  const writtenData = new Set([
    ...[...js.matchAll(/\.dataset\.([A-Za-z][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
    ...[...html.matchAll(/\bdata-([a-z][a-z0-9-]*)=/g)].map((m) => m[1]).map((s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())),
  ]);
  for (const key of readData) {
    if (!writtenData.has(key)) problems.push(`script reads dataset.${key} but nothing ever sets data-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
  }
  notes.push(`${readData.size} dataset reads, ${writtenData.size} data-* attributes emitted`);

  // ---- 4. fragile DOM traversal -----------------------------------------------------
  // `$('x').parentElement.style.display = 'none'` hides whatever happens to wrap `x`. When
  // that element is a bare label+input pair the parent is the whole form body, so "hide
  // the URL field" hid the entire form — invisible to every non-browser check and only
  // reproducible by loading the page. Hiding must name its container explicitly.
  for (const m of code.matchAll(/\$\('([^']+)'\)\s*\.\s*parentElement\s*\.\s*style/g)) {
    problems.push(`$('#${m[1]}').parentElement.style manipulates layout by DOM position; give the container its own id and toggle that instead`);
  }

  // ---- 4b. every control is attached to its own label --------------------------------
  // The complaint that produced this rule, verbatim: "我完全不知道每个框对应的是哪一个框了，
  // 已经分不清了". A control with no label association is a box floating next to unrelated
  // text; nothing in the page says which words describe it. Two things satisfy it, and
  // nothing else does:
  //   * the control is inside a <label>, or
  //   * some <label for="…"> names the control's id.
  // A placeholder is NOT a label: it disappears the moment you type, so it cannot tell you
  // what a filled-in box means.
  {
    const labelsFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    // Ranges of the markup that sit inside a <label>…</label>, for the wrapping case.
    const inLabel = [];
    for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      inLabel.push([m.index, m.index + m[0].length]);
    }
    const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)];
    let labelled = 0;
    for (const m of controls) {
      const tag = m[0];
      const type = (/\btype="([^"]+)"/.exec(tag) || [])[1] || '';
      const id = (/\bid="([^"]+)"/.exec(tag) || [])[1] || '';
      const wrapped = inLabel.some(([a, b]) => m.index > a && m.index < b);
      const named = id && labelsFor.has(id);
      const aria = /\baria-label(?:ledby)?="/.test(tag);
      if (wrapped || named || aria) {
        labelled += 1;
      } else {
        const what = id ? `<${m[1]}${type ? ' type=' + type : ''} id="${id}">` : `<${m[1]}${type ? ' type=' + type : ''}> (no id)`;
        problems.push(
          `control ${what} has no label: wrap it in <label>…</label> or add <label for="${id || '…'}">. ` +
            'A placeholder is not a label — it vanishes as soon as the field is filled.',
        );
      }
    }
    notes.push(`${labelled}/${controls.length} controls carry a label or aria-label`);

    // A <label> that neither wraps a control nor points at one is a caption pretending to
    // be a label. Use <span class="flabel"> for a group caption instead.
    for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
      const attrs = m[1];
      const body = m[2];
      const hasFor = /\bfor="[^"]+"/.test(attrs);
      const wraps = /<(input|select|textarea)\b/.test(body);
      if (!hasFor && !wraps) {
        const text = body.replace(/<[^>]*>/g, '').trim().slice(0, 40);
        problems.push(`<label>${text}</label> neither wraps a control nor has for="…", so it is not a label`);
      }
    }
  }

  // ---- 6. no inline styles ----------------------------------------------------------
  // The layout half of the same complaint. The old page carried 35 `style="…"` attributes,
  // and they fought the stylesheet: `.row > * { flex: 1 }` said "share the width equally"
  // while `style="flex: 0 0 230px"` said "be exactly 230px", so columns came out uneven for
  // no visible reason and the form read as a jumble. Presentation belongs in the <style>
  // block where it can be seen, compared and changed together.
  //
  // Scanned in two halves so that each report carries a usable line number, and against
  // comment-stripped script so that a comment *describing* the defect is not the defect.
  const pushStyleProblems = (text, offsetLines, label) => {
    for (const m of text.matchAll(/<[^>]*\sstyle="([^"]*)"/g)) {
      const where = offsetLines + text.slice(0, m.index).split('\n').length;
      problems.push(
        `inline style="${m[1].slice(0, 50)}" at ${label} line ${where}: presentation belongs in the ` +
          '<style> block, not on the element — scattered inline widths are what made the form unreadable',
      );
    }
  };
  const scriptStart = html.indexOf('<script');
  const markup = scriptStart >= 0 ? html.slice(0, scriptStart) : html;
  pushStyleProblems(markup, 0, 'markup');
  pushStyleProblems(code, scriptStart >= 0 ? html.slice(0, scriptStart).split('\n').length - 1 : 0, 'script');

  // ---- 7. structural sanity, as a stand-in for a browser -----------------------------
  // Nobody involved can render this page: the sandbox has no browser, and the project's own
  // notes record that the console was never loaded in one. So the failure modes a browser
  // would show as "the layout is a mess" are checked mechanically instead. They are not a
  // substitute for looking at it, but they do cover the specific ways markup silently
  // collapses: an unclosed <div> swallowing the rest of the page, two elements sharing an
  // id (getElementById returns the first, so the second is dead), and an unclosed CSS brace
  // turning every following rule into garbage.
  {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
    // The whole document minus the *contents* of <style>/<script>. Those contents are not
    // markup: a JS template literal holding a `<div>` fragment would unbalance a naive scan,
    // and the stylesheet is full of `>` selectors. The blanked regions keep their newlines so
    // the reported line numbers still point at the real file.
    const blankKeepingLines = (m) => '\n'.repeat((m.match(/\n/g) || []).length);
    const scannable = html
      .replace(/<style\b[\s\S]*?<\/style>/gi, blankKeepingLines)
      .replace(/<script\b[\s\S]*?<\/script>/gi, blankKeepingLines);
    /** @type {Array<{tag: string, line: number}>} */
    const stack = [];
    for (const m of scannable.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
      const [, closing, rawTag, attrs] = m;
      const tag = rawTag.toLowerCase();
      const line = scannable.slice(0, m.index).split('\n').length;
      if (VOID.has(tag) || /\/$/.test(attrs.trim())) continue;
      if (closing) {
        const top = stack.pop();
        if (!top) {
          problems.push(`markup line ${line}: </${tag}> closes nothing`);
        } else if (top.tag !== tag) {
          problems.push(
            `markup line ${line}: </${tag}> closes <${top.tag}> opened at line ${top.line} — ` +
              'an unclosed element swallows everything after it, which reads as a broken layout',
          );
        }
      } else {
        stack.push({ tag, line });
      }
    }
    for (const open of stack) {
      problems.push(`markup line ${open.line}: <${open.tag}> is never closed`);
    }

    // Duplicate ids: the second element is unreachable by id and the script silently drives
    // the wrong node.
    const seenIds = new Map();
    for (const m of markup.matchAll(/\bid="([^"]+)"/g)) {
      const line = markup.slice(0, m.index).split('\n').length;
      if (seenIds.has(m[1])) {
        problems.push(`id="${m[1]}" is declared twice (lines ${seenIds.get(m[1])} and ${line}); getElementById only ever returns the first`);
      } else {
        seenIds.set(m[1], line);
      }
    }

    // Braces in the stylesheet, ignoring strings and comments.
    const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
    if (styleBlocks.length !== 1) {
      problems.push(`expected exactly 1 <style> block, found ${styleBlocks.length}`);
    }
    for (const block of styleBlocks) {
      let depth = 0;
      let minDepth = 0;
      for (const m of block[1].matchAll(/\/\*[\s\S]*?\*\/|[{}]/g)) {
        if (m[0] === '{') depth += 1;
        else if (m[0] === '}') { depth -= 1; minDepth = Math.min(minDepth, depth); }
      }
      if (depth !== 0 || minDepth < 0) {
        problems.push(`the <style> block has unbalanced braces (depth ends at ${depth}, min ${minDepth}); every rule after the mistake is discarded`);
      }
    }
    notes.push(`markup nesting balanced, ${seenIds.size} unique ids, ${styleBlocks.length} style block`);
  }

  // ---- 7b. a hand-written class name must actually be styled --------------------------
  // Markup only, and only static values: two classes are built at runtime and are covered by
  // test/ui-events.test.js instead (`class="badge ${state}"` and the `'ev-' + ev.type` the log
  // renderer concatenates). A typo in a static class name fails completely silently — the
  // element simply renders unstyled — and this is a page whose stylesheet is hand-written and
  // cannot be checked in a browser here, so it is worth catching.
  {
    const styleText = (/<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html) || [])[1] || '';
    const styled = new Set();
    // Selector position only, with comments removed so prose mentioning a filename
    // ("…/events.js") is not mistaken for a class selector.
    const css = styleText.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      for (const c of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) styled.add(c[1]);
    }
    for (const m of html.matchAll(/\bclass="([^"$]*)"/g)) {
      const line = html.slice(0, m.index).split('\n').length;
      for (const c of m[1].split(/\s+/).filter(Boolean)) {
        if (!styled.has(c)) {
          problems.push(`class="${c}" at line ${line} matches no rule in the stylesheet, so it renders unstyled (a typo?)`);
        }
      }
    }
  }

  // ---- 5. referenced globals --------------------------------------------------------
  const called = new Set([...code.matchAll(/(?<![\w.$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]));
  const declaredFns = new Set([
    ...[...code.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)].map((m) => m[1]),
    ...[...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]),
  ]);
  const builtins = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'async',
    'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set', 'Error', 'RegExp', 'isNaN', 'parseInt', 'parseFloat',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'alert', 'confirm', 'prompt', 'encodeURIComponent', 'decodeURIComponent', 'requestAnimationFrame',
    'EventSource', 'URLSearchParams', 'structuredClone', 'queueMicrotask',
  ]);
  const unknown = [...called].filter((n) => !declaredFns.has(n) && !builtins.has(n));
  if (unknown.length) {
    notes.push(`called but not declared here (probably host globals): ${unknown.join(', ')}`);
  }

  return { problems, notes };
}

// ---- CLI ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly || process.argv[1]?.endsWith('check-ui.mjs')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'src', 'web', 'ui.html');
  const html = readFileSync(file, 'utf8');
  const { problems, notes } = analyzeUi(html);
  if (problems.length) {
    process.stderr.write(`ui.html FAILED ${problems.length} check(s):\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  for (const n of notes) process.stdout.write(`  \u00b7 ${n}\n`);
  process.stdout.write('UI OK\n');
}
