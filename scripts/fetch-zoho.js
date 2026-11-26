// Fetches Zoho Desk tickets and saves classification counts per day.
// Privacy: only the classification and created time of each ticket are requested.
// Nothing else is saved or printed. Ticket IDs are used in memory only, to avoid double counting.

const fs = require('fs');
const path = require('path');

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID } = process.env;
const REGION = (process.env.ZOHO_REGION || 'com').trim(); // com, eu, in, com.au ...
const DEPARTMENT = (process.env.ZOHO_DEPARTMENT || 'Customer Support').trim(); // only this team's tickets
const DAYS = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 400;
const OUTPUT = path.join(__dirname, '..', 'data', 'zoho.json');

for (const [name, value] of Object.entries({ ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID })) {
  if (!value) { console.error(`Missing the ${name} secret.`); process.exit(1); }
}

function sastDay(date) {
  return new Date(date.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'category-map-zoho.json'), 'utf8'));
const categories = Object.keys(map.categories);
const toCategory = {};
for (const [category, values] of Object.entries(map.categories)) {
  for (const v of values) toCategory[v.trim().toLowerCase()] = category;
}
const excluded = new Set(map.excluded.map(v => v.trim().toLowerCase()));

async function getAccessToken() {
  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET, grant_type: 'refresh_token'
  });
  const res = await fetch(`https://accounts.zoho.${REGION}/oauth/v2/token`, { method: 'POST', body: params });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error(`Zoho sign-in failed${body.error ? ': ' + body.error : ''}.`);
    console.error('Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN come from the same Self Client, and that ZOHO_REGION in the workflow matches your Zoho Desk address.');
    process.exit(1);
  }
  return body.access_token;
}

async function getDepartmentId(token) {
  const res = await fetch(`https://desk.zoho.${REGION}/api/v1/departments?limit=100`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID }
  });
  if (!res.ok) {
    console.error(`Could not read the Zoho Desk departments: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  const departments = Array.isArray(body.data) ? body.data : [];
  const match = departments.find(d => (d.name || '').trim().toLowerCase() === DEPARTMENT.toLowerCase());
  if (!match) {
    console.error(`No Zoho Desk department called "${DEPARTMENT}" was found.`);
    console.error(`Departments available: ${departments.map(d => d.name).join(', ')}`);
    process.exit(1);
  }
  return match.id;
}

async function main() {
  const token = await getAccessToken();
  const departmentId = await getDepartmentId(token);
  const now = new Date();
  const fromDay = sastDay(new Date(now.getTime() - (DAYS - 1) * 86400000));
  const toDay = sastDay(now);

  const seen = new Set();
  const daily = {}; const detail = {}; const notCategorised = {}; const newCategories = {};
  let from = 0; let pages = 0; let done = false;

  while (!done && pages < MAX_PAGES) {
    const url = `https://desk.zoho.${REGION}/api/v1/tickets?from=${from}&limit=${PAGE_SIZE}&sortBy=-createdTime&departmentId=${departmentId}&fields=classification,createdTime`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID } });
    if (res.status === 204) break; // no more tickets
    if (!res.ok) {
      console.error(`Zoho Desk returned an error: ${res.status} ${res.statusText}`);
      if (res.status === 401 || res.status === 403) console.error('Check the ZOHO_ORG_ID secret, and that the token was created with the Desk.tickets.READ scope.');
      process.exit(1);
    }
    const body = await res.json();
    const tickets = Array.isArray(body.data) ? body.data : [];
    pages++;

    for (const t of tickets) {
      if (!t || !t.createdTime) continue;
      const day = sastDay(new Date(t.createdTime));
      if (day < fromDay) { done = true; continue; }
      if (day > toDay || seen.has(t.id)) continue;
      seen.add(t.id);

      // Classifications hold "Category :: Subcategory", e.g. "GSM Printer :: Fault"
      const value = typeof t.classification === 'string' ? t.classification.trim() : '';
      const [mainPart, ...subParts] = value.split('::').map(x => x.trim());
      const raw = mainPart || '';
      if (!raw || raw === '-None-') { notCategorised[day] = (notCategorised[day] || 0) + 1; continue; }
      const key = raw.toLowerCase();
      if (excluded.has(key)) continue;
      let category = toCategory[key];
      if (!category) { category = raw; newCategories[raw] = (newCategories[raw] || 0) + 1; }

      daily[day] = daily[day] || {};
      daily[day][category] = (daily[day][category] || 0) + 1;

      const sub = subParts.join(' :: ');
      if (sub && sub !== '-None-') {
        detail[day] = detail[day] || {};
        const label = `${category} | ${raw} > ${sub}`;
        detail[day][label] = (detail[day][label] || 0) + 1;
      }
    }
    if (tickets.length < PAGE_SIZE) done = true;
    from += PAGE_SIZE;
  }

  // Every category appears on every day, so gaps show as zero
  const allCategories = [...categories, ...Object.keys(newCategories).filter(c => !categories.includes(c))];
  const filled = {};
  for (let d = fromDay; d <= toDay; d = sastDay(new Date(new Date(d + 'T10:00:00Z').getTime() + 86400000))) {
    filled[d] = Object.fromEntries(allCategories.map(c => [c, (daily[d] && daily[d][c]) || 0]));
  }

  const output = {
    source: 'Zoho Desk',
    department: DEPARTMENT,
    measure: 'Tickets created, by ticket classification (one ticket counts once)',
    last_synced: now.toISOString(),
    timezone: 'Africa/Johannesburg',
    range: { from: fromDay, to: toDay },
    categories: allCategories,
    daily: filled,
    subcategory_daily: Object.fromEntries(Object.entries(detail).sort()),
    not_categorised_daily: Object.fromEntries(Object.entries(notCategorised).sort())
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  const cutoff = sastDay(new Date(now.getTime() - 29 * 86400000));
  const totals = Object.fromEntries(allCategories.map(c => [c, 0]));
  let uncategorised = 0;
  for (const [d, counts] of Object.entries(filled)) if (d >= cutoff) for (const c of allCategories) totals[c] += counts[c];
  for (const [d, n] of Object.entries(notCategorised)) if (d >= cutoff) uncategorised += n;
  console.log(`Zoho Desk data (${DEPARTMENT} department) saved for ${fromDay} to ${toDay} (${seen.size} tickets, ${pages} pages).`);
  console.log('Last 30 days by category:');
  for (const [c, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`Tickets with no category (not shown on the dashboard): ${uncategorised}`);
  const extra = Object.keys(newCategories);
  if (extra.length) console.log(`Categories not in category-map-zoho.json yet (shown under their own name): ${extra.join(', ')}`);
}

main().catch(err => {
  console.error('The Zoho Desk update failed:', err.message);
  process.exit(1);
});
