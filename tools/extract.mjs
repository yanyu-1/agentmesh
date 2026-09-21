#!/usr/bin/env node
// Extract compact facts from saved GitHub API JSON / npm docs.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('research/raw');
const mode = process.argv[2] || 'repo';

async function readJson(file) {
  const t = await readFile(path.join(dir, file), 'utf8');
  const j = JSON.parse(t.split(/\n={60}\n/).slice(1).join('\n').trim());
  return j;
}

if (mode === 'repo') {
  const files = (await readdir(dir)).filter(f => f.startsWith('api.github.com_repos_') || f.startsWith('api.github.com_orgs_'));
  for (const f of files) {
    try {
      const j = await readJson(f);
      const rows = Array.isArray(j) ? j : [j];
      for (const r of rows) {
        if (!r.full_name) continue;
        console.log([r.full_name, 'stars=' + r.stargazers_count, 'forks=' + r.forks_count,
          'archived=' + r.archived, 'pushed=' + r.pushed_at, 'created=' + r.created_at,
          'branch=' + r.default_branch, 'lic=' + (r.license && r.license.spdx_id),
          '| ' + (r.description || '').replace(/\s+/g, ' ').slice(0, 120)].join('  '));
      }
    } catch (e) { console.log('ERR ' + f + ' ' + e.message); }
  }
}

if (mode === 'rel') {
  const files = (await readdir(dir)).filter(f => f.includes('releases'));
  for (const f of files) {
    try {
      const j = await readJson(f);
      const rows = Array.isArray(j) ? j : [j];
      for (const r of rows.slice(0, 6)) {
        console.log([f.slice(0, 60), r.tag_name, r.name, 'published=' + r.published_at, 'prerelease=' + r.prerelease].join('  '));
      }
    } catch (e) { console.log('ERR ' + f + ' ' + e.message); }
  }
}

if (mode === 'search') {
  const files = (await readdir(dir)).filter(f => f.includes('search_repositories'));
  for (const f of files) {
    const j = await readJson(f);
    console.log('### ' + f);
    for (const r of (j.items || []).slice(0, 20)) {
      console.log([r.full_name, 'stars=' + r.stargazers_count, 'pushed=' + (r.pushed_at || '').slice(0, 10),
        '| ' + (r.description || '').replace(/\s+/g, ' ').slice(0, 130)].join('  '));
    }
  }
}

if (mode === 'npm') {
  const t = await readFile(path.join(dir, 'registry.npmjs.org_' + process.argv[3] + '.txt'), 'utf8');
  const j = JSON.parse(t.split(/\n={60}\n/).slice(1).join('\n').trim());
  const latest = j['dist-tags'] && j['dist-tags'].latest;
  const times = j.time || {};
  console.log('name:', j.name);
  console.log('dist-tags:', JSON.stringify(j['dist-tags']));
  console.log('versions count:', Object.keys(j.versions || {}).length);
  console.log('created:', times.created, 'modified:', times.modified);
  const vs = Object.keys(j.versions || {});
  console.log('first versions:', vs.slice(0, 6).join(', '));
  console.log('last versions:', vs.slice(-8).join(', '));
  console.log('latest time:', times[latest]);
  console.log('desc:', (j.description || '').replace(/\s+/g, ' '));
  const lv = (j.versions || {})[latest] || {};
  console.log('latest bin:', JSON.stringify(lv.bin), 'deps:', JSON.stringify(lv.dependencies));
}
