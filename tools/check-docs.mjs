// Cross-document consistency check. Docs that claim counts, links and test-file lists
// drift silently the moment one is updated and another is not; this catches that.
//
// Scope note: the numbers that must agree are the ones describing the *test suite*.
// Numbers like "15/15 通过" for an individual verify script are legitimately different,
// and prose like "4 个文件均为合法 UTF-8" is a historical incident note, not a claim.
// So the extraction is anchored to lines that actually talk about `npm test`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

let bad = 0;
const fail = (m) => { bad += 1; console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`ok   ${m}`);
const read = (f) => readFileSync(f, 'utf8');
const docs = ['README.md', 'USAGE.md', 'ACCEPTANCE.md'];

// ---- 1. test files on disk vs the chain in package.json ------------------------
const onDisk = readdirSync('test').filter((f) => f.endsWith('.test.js')).sort();
const pkg = JSON.parse(read('package.json'));
const inChain = [...pkg.scripts.test.matchAll(/test\/([a-z0-9-]+)\.test\.js/g)].map((m) => `${m[1]}.test.js`);
const missing = onDisk.filter((f) => !inChain.includes(f));
const extra = inChain.filter((f) => !onDisk.includes(f));
if (missing.length || extra.length) fail(`chain mismatch: missing=${missing} extra=${extra}`);
else ok(`all ${onDisk.length} test files are in the npm test chain`);

// ---- 2. suite counts must agree across docs -----------------------------------
// Only lines that describe the suite: they mention npm test, or the file/case summary.
const claimLines = [];
for (const d of docs) {
  read(d).split('\n').forEach((line, i) => {
    if (/npm test|个文件，\d+ 个用例|测试规模/.test(line)) claimLines.push([d, i + 1, line]);
  });
}

const nums = (re) => claimLines.flatMap(([d, n, l]) => [...l.matchAll(re)].map((m) => ({ d, n, v: Number(m[1]) })));
const fileClaims = nums(/(\d+)\s*个文件/g);
const caseClaims = nums(/(\d+)\s*个用例/g);
const passClaims = nums(/\*{0,2}(\d+)\s*通过/g);
const skipClaims = nums(/\+?\s*(\d+)\s*(?:个[^，。）]*?)?(?:沙箱)?跳过/g);

const uniq = (a) => [...new Set(a.map((x) => x.v))];
const show = (a) => a.map((x) => `${x.d}:${x.n}=${x.v}`).join(' ');

for (const [label, claims, expected] of [
  ['file count', fileClaims, onDisk.length],
  ['case count', caseClaims, null],
  ['pass count', passClaims, null],
  ['skip count', skipClaims, null],
]) {
  const u = uniq(claims);
  if (u.length !== 1) fail(`${label} disagrees across docs -> ${show(claims)}`);
  else if (expected !== null && u[0] !== expected) fail(`${label} claims ${u[0]} but reality is ${expected}`);
  else ok(`${label} consistent (${u[0]})`);
}

// Arithmetic: pass + skip must equal cases.
const c = uniq(caseClaims)[0];
const p = uniq(passClaims)[0];
const s = uniq(skipClaims)[0];
if (p + s !== c) fail(`pass+skip (${p}+${s}) != cases (${c})`);
else ok(`arithmetic holds: ${p} pass + ${s} skip = ${c}`);

// ---- 3. defect rows: contiguous 1..N, and N must match what the docs claim ----
const acc = read('ACCEPTANCE.md');
// Scope to the section-4 defect table only, so numbering in other tables is ignored.
const start = acc.indexOf('## 4. 验证过程中发现并修复的真实缺陷');
const end = acc.indexOf('\n## 5.', start);
const section4 = acc.slice(start, end);
const rows = [...section4.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
const maxRow = Math.max(...rows);
const contiguous = rows.every((n, i) => n === i + 1);
if (!contiguous) fail(`defect rows in section 4 are not contiguous 1..${maxRow} (got ${rows.length} rows)`);
else ok(`defect table rows are contiguous 1..${maxRow}`);

const claimedDefects = [...acc.matchAll(/抓出并修复的真实缺陷[：:]\s*\*{0,2}(\d+)|含验证过程中抓出的\s*\n?\s*(\d+)\s*个真实缺陷|含\s*(\d+)\s*个真实缺陷|推翻了\s*(\d+)\s*个/g)]
  .map((m) => Number(m[1] ?? m[2] ?? m[3] ?? m[4]));
const claimedU = [...new Set(claimedDefects)];
const crossDocs = [];
for (const d of docs) {
  for (const m of read(d).matchAll(/(\d+)\s*个真实缺陷/g)) crossDocs.push({ d, v: Number(m[1]) });
}
const allDefectClaims = [...new Set([...claimedU, ...crossDocs.map((x) => x.v)])];
if (allDefectClaims.length !== 1) fail(`defect count disagrees: ACCEPTANCE claims ${claimedU}, others ${crossDocs.map((x) => `${x.d}=${x.v}`)}`);
else if (allDefectClaims[0] !== maxRow) fail(`docs claim ${allDefectClaims[0]} defects but the table has ${maxRow}`);
else ok(`defect count consistent across docs and table (${maxRow})`);

// ---- 4. every relative markdown link resolves --------------------------------
const links = [];
for (const d of [...docs, 'PLAN.md'].filter(existsSync)) {
  for (const m of read(d).matchAll(/\[[^\]]*\]\(([^)#:]+?)(?:#[^)]*)?\)/g)) links.push([d, m[1]]);
}
const broken = links.filter(([d, l]) => !existsSync(join(dirname(d), l)));
if (broken.length) fail(`broken relative links: ${broken.map(([d, l]) => `${d}->${l}`).join(', ')}`);
else ok(`all ${links.length} relative links resolve`);

// ---- 5. USAGE.md section numbers are contiguous WITHIN each chapter ----------
const secs = [...read('USAGE.md').matchAll(/^### (\d+)\.(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
const chapters = new Map();
for (const [ch, n] of secs) {
  if (!chapters.has(ch)) chapters.set(ch, []);
  chapters.get(ch).push(n);
}
let secBad = [];
for (const [ch, list] of chapters) {
  if (!list.every((n, i) => n === i + 1)) secBad.push(`${ch}.x -> ${list.join(',')}`);
}
if (secBad.length) fail(`USAGE.md chapter numbering is not contiguous: ${secBad.join(' | ')}`);
else ok(`USAGE.md sections contiguous within all ${chapters.size} chapters (4.1..4.${chapters.get(4).length})`);

// ---- 6. scripts referenced by name must exist -------------------------------
const scriptRefs = new Set();
for (const d of docs) for (const m of read(d).matchAll(/tools\/([a-z0-9-]+\.mjs)/g)) scriptRefs.add(m[1]);
const absent = [...scriptRefs].filter((f) => !existsSync(join('tools', f)));
if (absent.length) fail(`docs reference missing scripts: ${absent.join(', ')}`);
else ok(`all ${scriptRefs.size} referenced tool scripts exist`);

// ---- 7. logs referenced by path must exist ----------------------------------
// logs/ is generated output and is gitignored, so a fresh clone legitimately has none
// of these files — `npm run check:docs` has to pass there, otherwise every new
// contributor's first command fails for a reason that is not their fault. When the
// directory *does* exist (a maintainer's working copy, where the transcripts were
// actually produced) the strict check stays, because there a missing file means the
// docs point at a transcription that was never written or has since been renamed.
const logRefs = new Set();
for (const d of docs) for (const m of read(d).matchAll(/logs\/([a-z0-9-]+\.txt)/g)) logRefs.add(m[1]);
if (!existsSync('logs')) {
  ok(`${logRefs.size} logs referenced; logs/ absent (generated, not shipped) — skipped`);
} else {
  const absentLogs = [...logRefs].filter((f) => !existsSync(join('logs', f)));
  if (absentLogs.length) fail(`docs reference missing logs: ${absentLogs.join(', ')}`);
  else ok(`all ${logRefs.size} referenced logs exist`);
}

console.log(bad ? `\n${bad} PROBLEM(S)` : '\nALL CONSISTENT');
process.exit(bad ? 1 : 0);
