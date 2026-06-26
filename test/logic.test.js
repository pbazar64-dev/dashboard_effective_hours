process.env.VIBE_API_KEY = 'test';
process.env.APP_BASE_URL = 'https://example.com';
const assert = require('assert');
const mod = require('../server.js');

// ---- mock fetch routing by URL ----
function makeFetch(routes) {
  return async (url, opts) => {
    for (const [match, data] of routes) {
      if (url.includes(match)) {
        return { status: 200, text: async () => JSON.stringify(data) };
      }
    }
    return { status: 200, text: async () => JSON.stringify({ success: true, data: [] }) };
  };
}

// portal today: pin via overriding Intl? We'll just compute from function.
const today = mod.portalToday();
console.log('portalToday =', today);

// Build a date period that INCLUDES today (this month-ish)
const y = today.slice(0, 4), m = today.slice(5, 7);
const from = `${y}-${m}-01`;
const to = today;

// Tasks: one active (status 3), one completed in range (5), one completed OUT of range (5),
// one deferred (6), one without time tracking (should be excluded by code guard).
const closedInRange = `${today}T10:00:00+03:00`;
const closedOut = `2000-01-05T10:00:00+03:00`;

const tasks = {
  success: true,
  data: [
    { id: '101', title: 'Active', status: '3', responsibleId: '7', groupId: '147',
      closedDate: null, timeEstimate: '7200', timeSpentInLogs: '3600', allowTimeTracking: 'Y' },
    { id: '102', title: 'Done in range', status: '5', responsibleId: '7', groupId: '147',
      closedDate: closedInRange, timeEstimate: '3600', timeSpentInLogs: '5400', allowTimeTracking: 'Y' },
    { id: '103', title: 'Done out of range', status: '5', responsibleId: '7', groupId: '0',
      closedDate: closedOut, timeEstimate: '3600', timeSpentInLogs: '3600', allowTimeTracking: 'Y' },
    { id: '104', title: 'Deferred', status: '6', responsibleId: '7', groupId: '147',
      closedDate: closedInRange, timeEstimate: '0', timeSpentInLogs: '1800', allowTimeTracking: 'Y' },
    { id: '105', title: 'No time tracking', status: '3', responsibleId: '7', groupId: '147',
      closedDate: null, timeEstimate: '3600', timeSpentInLogs: '0', allowTimeTracking: 'N' },
  ],
  meta: { total: 5, hasMore: false },
};

const workgroups = { success: true, data: [{ id: '147', name: 'Юмедика' }] };
// task-time: executor (user 7) logged 90 min on task 102, 30 min on 101
const taskTime = {
  success: true,
  data: [
    { id: '1', taskId: '101', userId: '7', seconds: '1800' },
    { id: '2', taskId: '102', userId: '7', seconds: '5400' },
  ],
  meta: { total: 2, hasMore: false },
};
const me = { success: true, data: { portal: 'avrika.bitrix24.ru' } };

mod.__setFetch(makeFetch([
  ['/tasks?', tasks],
  ['/workgroups?', workgroups],
  ['/task-time?', taskTime],
  ['/me', me],
]));

(async () => {
  const res = await mod.computeDashboard('tok', { userId: '7', dateFrom: from, dateTo: to, rate: 1000 });
  const byId = Object.fromEntries(res.rows.map(r => [r.id, r]));
  console.log('Included task ids:', res.rows.map(r => r.id).sort());

  // period includes today -> active(101) shown, done-in-range(102) shown, deferred(104) shown,
  // done-out-of-range(103) excluded (not completed? it IS completed and not in range -> excluded),
  // no-time-tracking(105) excluded by guard.
  assert.deepStrictEqual(res.rows.map(r => r.id).sort(), ['101', '102', '104'], 'wrong inclusion set');
  assert.strictEqual(res.meta.periodIncludesToday, true);

  // project name + url
  assert.strictEqual(byId['101'].projectName, 'Юмедика');
  assert.ok(byId['101'].projectUrl.includes('/workgroups/group/147/'));
  assert.ok(byId['101'].taskUrl.includes('/tasks/task/view/101/'));

  // status labels
  assert.strictEqual(byId['101'].status, 'Выполняется');
  assert.strictEqual(byId['102'].status, 'Завершена');
  assert.strictEqual(byId['104'].status, 'Отложена');

  // spent from task-time map: 101 -> 1800s, 102 -> 5400s; 104 not in map -> fallback timeSpentInLogs 1800
  assert.strictEqual(byId['101'].spentSeconds, 1800);
  assert.strictEqual(byId['102'].spentSeconds, 5400);
  assert.strictEqual(byId['104'].spentSeconds, 1800);

  // spent color flags: 101 planned 7200 > spent 1800 -> under (dark green)
  assert.strictEqual(byId['101'].spentUnder, true);
  assert.strictEqual(byId['101'].spentOver, false);
  // 102 planned 3600 < spent 5400 -> over (red)
  assert.strictEqual(byId['102'].spentOver, true);

  // bonus: 101 planned 7200s=2h * 1000 = 2000
  assert.strictEqual(byId['101'].bonus, 2000);
  // 102 planned 3600s=1h * 1000 = 1000
  assert.strictEqual(byId['102'].bonus, 1000);
  // 104 planned 0 -> use spent 1800s=0.5h * 1000 = 500
  assert.strictEqual(byId['104'].bonus, 500);

  // completed flag
  assert.strictEqual(byId['102'].isCompleted, true);
  assert.strictEqual(byId['101'].isCompleted, false);

  // summary: only completed (status 5) -> only 102. effective planned = 3600s, bonus = 1000
  assert.strictEqual(res.summary.effectiveSeconds, 3600);
  assert.strictEqual(res.summary.confirmedBonus, 1000);

  console.log('--- TEST 1 (period includes today) PASSED ---');

  // ---- TEST 2: period in the PAST (excludes today) ----
  const res2 = await mod.computeDashboard('tok', { userId: '7', dateFrom: '1999-01-01', dateTo: '2001-01-01', rate: 1000 });
  console.log('Past period ids:', res2.rows.map(r => r.id).sort());
  // only closedDate in [1999,2001] -> task 103 (closed 2000) qualifies; others closed today/null excluded
  assert.deepStrictEqual(res2.rows.map(r => r.id).sort(), ['103']);
  assert.strictEqual(res2.meta.periodIncludesToday, false);
  console.log('--- TEST 2 (past period) PASSED ---');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
