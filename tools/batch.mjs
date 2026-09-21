#!/usr/bin/env node
// Batch fetch URLs, save full bodies to research/raw/<slug>.txt
// Usage: node tools/batch.mjs <urlfile.txt>   (one URL per line, # = comment)
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const listFile = process.argv[2];
if (!listFile) { console.error('usage: node tools/batch.mjs <urlfile>'); process.exit(2); }

const HEADERS = {
  'user-agent': 'hermes-control-plane-research/0.1 (+local)',
  accept: 'text/html,application/json,text/plain,*/*',
};

function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const slugOf = (url) => {
  return url.replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 150);
};

const dir = path.resolve('research/raw');
await mkdir(dir, { recursive: true });

const lines = (await readFile(listFile, 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(l => l && !l.startsWith('#'));
const results = [];

async function one(url) {
  const slug = slugOf(url);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    let body = await res.text();
    if (ct.includes('html')) body = strip(body);
    const out = `URL: ${url}\nSTATUS: ${res.status}\nCT: ${ct}\nLEN: ${body.length}\n${'='.repeat(60)}\n${body}`;
    await writeFile(path.join(dir, slug + '.txt'), out, 'utf8');
    results.push({ url, status: res.status, ct, len: body.length, file: slug + '.txt' });
    console.log(`OK   ${res.status} ${body.length}\t${url}`);
  } catch (e) {
    await writeFile(path.join(dir, slug + '.txt'), `URL: ${url}\nERROR: ${e.message}\n`, 'utf8');
    results.push({ url, status: 0, error: e.message, file: slug + '.txt' });
    console.log(`FAIL      ${e.message}\t${url}`);
  }
}

// limited concurrency
const CONC = 6;
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < lines.length) {
    const idx = i++;
    await one(lines[idx]);
  }
}));

await writeFile(path.join(dir, '_index.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(`\ndone: ${results.length} urls -> ${dir}`);
