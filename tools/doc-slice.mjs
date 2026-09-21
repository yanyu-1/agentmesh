// Fetch a URL and print a character window of the tag-stripped text.
const [url, startS, lenS] = process.argv.slice(2);
function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x3C;/g, "<").replace(/&#x26;/g, "&")
    .replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
const r = await fetch(url, { headers: { "user-agent": "research/0.1" } });
let t = await r.text();
if ((r.headers.get("content-type") || "").includes("html")) t = strip(t);
const start = Number(startS || 0), len = Number(lenS || 4000);
console.log(`LEN=${t.length} window=[${start},${start + len})`);
console.log(t.slice(start, start + len));
