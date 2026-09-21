#!/usr/bin/env node
// Minimal HTTPS fetcher used for research on this machine.
// Windows schannel is unavailable in this sandbox, so we use Node's bundled
// OpenSSL TLS stack instead of curl / Invoke-WebRequest.
//
// Usage:
//   node tools/fetch.mjs <url> [maxChars]
//   node tools/fetch.mjs --json <url> [jq-ish path...]

const args = process.argv.slice(2);
let maxChars = 6000;
const urls = [];

for (const a of args) {
  if (/^\d+$/.test(a)) maxChars = Number(a);
  else urls.push(a);
}

if (urls.length === 0) {
  console.error('usage: node tools/fetch.mjs <url> [maxChars]');
  process.exit(2);
}

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

for (const url of urls) {
  console.log('='.repeat(72));
  console.log('URL:', url);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    let body = await res.text();
    if (ct.includes('html')) body = strip(body);
    console.log('STATUS:', res.status, '| CT:', ct, '| LEN:', body.length);
    console.log('-'.repeat(72));
    console.log(body.length > maxChars ? body.slice(0, maxChars) + `\n...[truncated ${body.length - maxChars} chars]` : body);
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
