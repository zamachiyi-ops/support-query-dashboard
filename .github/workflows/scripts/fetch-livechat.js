// Fetches LiveChat tag counts and saves them as category totals per day.
// Privacy: this uses LiveChat's tag report, which only returns counts.
// No chat transcripts, names, emails or phone numbers are requested or saved.

const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = process.env.LIVECHAT_ACCOUNT_ID;
const TOKEN = process.env.LIVECHAT_TOKEN;
const DAYS = 60; // 60 days so the dashboard can compare this 30 days with the previous 30
const TZ_OFFSET = '+02:00'; // South Africa (SAST), no daylight saving
const OUTPUT = path.join(__dirname, '..', 'data', 'livechat.json');

if (!ACCOUNT_ID || !TOKEN) {
  console.error('Missing the LIVECHAT_ACCOUNT_ID or LIVECHAT_TOKEN secret.');
  process.exit(1);
}

// Date as YYYY-MM-DD in South African time
function sastDay(date) {
  return new Date(date.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

// Load the tag-to-category mapping
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'category-map.json'), 'utf8'));
const categories = Object.keys(map.categories);
const tagToCategory = {};
for (const [category, tags] of Object.entries(map.categories)) {
  for (const tag of tags) tagToCategory[tag.trim().toLowerCase()] = category;
}
const excluded = new Set(map.excluded.map(t => t.trim().toLowerCase()));

async function main() {
  const now = new Date();
  const fromDay = sastDay(new Date(now.getTime() - (DAYS - 1) * 86400000));
  const toDay = sastDay(now);

  const auth = Buffer.from(`${ACCOUNT_ID}:${TOKEN}`).toString('base64');
  const res = await fetch('https://api.livechatinc.com/v3.6/reports/chats/tags', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      distribution: 'day',
      timezone: 'Africa/Johannesburg',
      filters: { from: `${fromDay}T00:00:00${TZ_OFFSET}`, to: `${toDay}T23:59:59${TZ_OFFSET}` }
    })
  });

  if (!res.ok) {
    console.error(`LiveChat returned an error: ${res.status} ${res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.error('Check the LIVECHAT_ACCOUNT_ID and LIVECHAT_TOKEN secrets, and that the token has the reports_read scope.');
    }
    process.exit(1);
  }

  const body = await res.json();
  const records = body.records || {};
  const daily = {};
  const unmapped = {};

  for (const [day, tags] of Object.entries(records)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof tags !== 'object' || tags === null) continue;
    const counts = Object.fromEntries(categories.map(c => [c, 0]));
    for (const [tag, value] of Object.entries(tags)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue; // keep numbers only
      const key = tag.trim().toLowerCase();
      if (tagToCategory[key]) counts[tagToCategory[key]] += n;
      else if (!excluded.has(key) && n > 0) unmapped[tag] = (unmapped[tag] || 0) + n;
    }
    daily[day] = counts;
  }

  const output = {
    source: 'LiveChat',
    measure: 'Tag uses (one chat can have more than one tag)',
    last_synced: now.toISOString(),
    timezone: 'Africa/Johannesburg',
    range: { from: fromDay, to: toDay },
    categories,
    daily,
    unmapped_tags: unmapped
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  // Short summary for the Actions log (category totals only)
  const cutoff = sastDay(new Date(now.getTime() - 29 * 86400000));
  const totals = Object.fromEntries(categories.map(c => [c, 0]));
  for (const [day, counts] of Object.entries(daily)) {
    if (day >= cutoff) for (const c of categories) totals[c] += counts[c];
  }
  console.log(`LiveChat data saved for ${fromDay} to ${toDay}.`);
  console.log('Last 30 days by category:');
  for (const [c, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  const newTags = Object.keys(unmapped);
  if (newTags.length) console.log(`Tags not in category-map.json yet: ${newTags.join(', ')}`);
}

main().catch(err => {
  console.error('The LiveChat update failed:', err.message);
  process.exit(1);
});
