// Fetches the call log totals from the published "Dashboard feed" tab and saves them per day.
// Privacy: the feed only holds date, query, subquery and a count. If it ever contains
// any other columns, this script stops without saving anything.

const fs = require('fs');
const path = require('path');

const CSV_URL = process.env.CALL_LOG_CSV_URL;
const DAYS = 60;
const OUTPUT = path.join(__dirname, '..', 'data', 'call-log.json');
const EXPECTED = ['date', 'query', 'subquery', 'calls'];

if (!CSV_URL) {
  console.error('Missing the CALL_LOG_CSV_URL secret.');
  process.exit(1);
}

function sastDay(date) {
  return new Date(date.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

// Small CSV reader that handles quoted values
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'category-map-calls.json'), 'utf8'));
const categories = Object.keys(map.categories);
const queryToCategory = {};
for (const [category, queries] of Object.entries(map.categories)) {
  for (const q of queries) queryToCategory[q.trim().toLowerCase()] = category;
}
const excluded = new Set(map.excluded.map(q => q.trim().toLowerCase()));
const noSubquery = new Set(map.no_subquery.map(q => q.trim().toLowerCase()));

async function main() {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    console.error(`Google Sheets returned an error: ${res.status} ${res.statusText}`);
    console.error('Check the sheet is still published to the web and the CALL_LOG_CSV_URL secret is the CSV link.');
    process.exit(1);
  }
  const rows = parseCsv(await res.text());
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());

  // Safety check: only the four expected columns are allowed
  if (header.length !== EXPECTED.length || EXPECTED.some((h, i) => header[i] !== h)) {
    console.error('Stopped: the published feed does not have exactly these columns: date, query, subquery, calls.');
    console.error('Nothing was saved. Check that only the "Dashboard feed" tab is published, and that its formula has not changed.');
    process.exit(1);
  }

  const now = new Date();
  const fromDay = sastDay(new Date(now.getTime() - (DAYS - 1) * 86400000));
  const toDay = sastDay(now);
  const daily = {}; const detail = {}; const unmapped = {};

  for (const [day, query, subquery, calls] of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < fromDay || day > toDay) continue;
    const n = Number(calls);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = (query || '').trim().toLowerCase();
    if (!key || excluded.has(key)) continue;
    const category = queryToCategory[key];
    if (!category) { unmapped[query.trim()] = (unmapped[query.trim()] || 0) + n; continue; }

    daily[day] = daily[day] || Object.fromEntries(categories.map(c => [c, 0]));
    daily[day][category] += n;

    if (!noSubquery.has(key) && subquery && subquery.trim()) {
      detail[day] = detail[day] || {};
      const label = `${category} | ${subquery.trim()}`;
      detail[day][label] = (detail[day][label] || 0) + n;
    }
  }

  // Days with no calls still appear, so gaps show as zero rather than missing
  for (let d = fromDay; d <= toDay; d = sastDay(new Date(new Date(d + 'T12:00:00Z').getTime() + 86400000 - 2 * 3600 * 1000))) {
    daily[d] = daily[d] || Object.fromEntries(categories.map(c => [c, 0]));
  }

  const sortedDaily = Object.fromEntries(Object.entries(daily).sort());
  const output = {
    source: 'Call log',
    measure: 'Calls logged on the call disposition form (one call counts once)',
    last_synced: now.toISOString(),
    timezone: 'Africa/Johannesburg',
    range: { from: fromDay, to: toDay },
    categories,
    daily: sortedDaily,
    subquery_daily: Object.fromEntries(Object.entries(detail).sort()),
    unmapped_queries: unmapped
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  const cutoff = sastDay(new Date(now.getTime() - 29 * 86400000));
  const totals = Object.fromEntries(categories.map(c => [c, 0]));
  for (const [day, counts] of Object.entries(sortedDaily)) if (day >= cutoff) for (const c of categories) totals[c] += counts[c];
  console.log(`Call log data saved for ${fromDay} to ${toDay}.`);
  console.log('Last 30 days by query type:');
  for (const [c, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  const newQueries = Object.keys(unmapped);
  if (newQueries.length) console.log(`Query types not in category-map-calls.json yet: ${newQueries.join(', ')}`);
}

main().catch(err => {
  console.error('The call log update failed:', err.message);
  process.exit(1);
});
