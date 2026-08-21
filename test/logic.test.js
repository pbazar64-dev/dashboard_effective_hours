process.env.VIBE_API_KEY = 'test';
process.env.APP_BASE_URL = 'https://example.com';
const assert = require('assert');
const mod = require('../server.js');

const today = mod.portalToday();
console.log('portalToday =', today);
const y = today.slice(0, 4), m = today.slice(5, 7);
const from = `${y}-${m}-01`;
const to = today;

const closedInRange = `${today}T10:00:00+03:00`;
const closedOut = `2000-01-05T10:00:00+03:00`;

// Полный набор задач сотрудника (как на портале). Мок ниже эмулирует серверную
// фильтрацию Битрикс24 по responsibleId / allowTimeTracking / closedDate / REAL_STATUS.
const MASTER = [
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
  { id: '106', title: 'Archived project task', status: '3', responsibleId: '7', groupId: '13',
    closedDate: null, timeEstimate: '3600', timeSpentInLogs: '900', allowTimeTracking: 'Y' },
  // Долгоиграющая задача: создана давно (низкий id), ЗАКРЫТА в июле 2026, и учёт времени
  // ВЫКЛЮЧЕН (allowTimeTracking=false) — как реальные задачи 1893/2097/2099 на портале.
  // Воспроизводит оба бага: окно «5000 новейших» и фильтр по флагу учёта времени.
  { id: '1893', title: 'Long-running, closed in July', status: '5', responsibleId: '7', groupId: '147',
    closedDate: '2026-07-15T10:00:00+03:00', timeEstimate: '3600', timeSpentInLogs: '3600', allowTimeTracking: false },
];

// Эмуляция серверной фильтрации tasks.task.list
function serverFilterTasks(fullUrl) {
  const qi = fullUrl.indexOf('?');
  const sp = new URLSearchParams(qi >= 0 ? fullUrl.slice(qi + 1) : '');
  let list = MASTER.slice();
  const resp = sp.get('filter[responsibleId]');
  if (resp) list = list.filter((t) => String(t.responsibleId) === resp);
  if (sp.get('filter[allowTimeTracking]') === 'Y') {
    list = list.filter((t) => (t.allowTimeTracking == null ? 'Y' : t.allowTimeTracking) === 'Y');
  }
  const ge = sp.get('filter[>=closedDate]');
  const le = sp.get('filter[<=closedDate]');
  if (ge != null || le != null) {
    const fromD = ge ? ge.slice(0, 10) : '0000-00-00';
    const toD = le ? le.slice(0, 10) : '9999-99-99';
    list = list.filter((t) => t.closedDate && t.closedDate.slice(0, 10) >= fromD && t.closedDate.slice(0, 10) <= toD);
  }
  const rs = sp.getAll('filter[REAL_STATUS][]');
  if (rs.length) list = list.filter((t) => rs.includes(String(t.status)));
  return { success: true, data: list, meta: { total: list.length, hasMore: false } };
}

const workgroups = { success: true, data: [{ id: '147', name: 'Юмедика' }] };
const group13 = { success: true, data: { id: '13', name: 'Прометей' } };
const taskTime = {
  success: true,
  data: [
    { id: '1', taskId: '101', userId: '7', seconds: '1800' },
    { id: '2', taskId: '102', userId: '7', seconds: '5400' },
  ],
  meta: { total: 2, hasMore: false },
};
const me = { success: true, data: { portal: 'avrika.bitrix24.ru', currentUser: { bitrixUserId: '99' } } };

const jsonResp = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
mod.__setFetch(async (url) => {
  if (url.includes('/task-time?')) return jsonResp(taskTime);
  if (url.includes('/tasks?')) return jsonResp(serverFilterTasks(url));
  if (url.includes('/workgroups/13')) return jsonResp(group13);
  if (url.includes('/workgroups?')) return jsonResp(workgroups);
  if (url.includes('/v1/me')) return jsonResp(me);
  return jsonResp({ success: true, data: [] });
});

(async () => {
  // ---- TEST 1: период включает сегодня ----
  const res = await mod.computeDashboard('tok', { userId: '7', dateFrom: from, dateTo: to, rate: 1000 });
  const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));
  console.log('TEST1 ids:', res.rows.map((r) => r.id).sort());

  // Учёт-времени-флаг больше не фильтрует → задача 105 (allowTimeTracking=N) тоже видна
  assert.deepStrictEqual(res.rows.map((r) => r.id).sort(), ['101', '102', '104', '105', '106'], 'wrong inclusion set');
  assert.strictEqual(res.meta.periodIncludesToday, true);
  assert.strictEqual(byId['105'].status, 'Выполняется');

  assert.strictEqual(byId['101'].projectName, 'Юмедика');
  assert.ok(byId['101'].projectUrl.includes('/workgroups/group/147/'));
  assert.strictEqual(byId['101'].taskUrl, 'https://avrika.bitrix24.ru/company/personal/user/99/tasks/task/view/101/');
  assert.ok(byId['102'].taskUrl.includes('/tasks/task/view/102/'));

  assert.strictEqual(byId['106'].projectName, 'Прометей');
  assert.ok(byId['106'].projectUrl.includes('/workgroups/group/13/'));

  assert.strictEqual(byId['101'].status, 'Выполняется');
  assert.strictEqual(byId['102'].status, 'Завершена');
  assert.strictEqual(byId['104'].status, 'Отложена');

  assert.strictEqual(byId['101'].spentSeconds, 1800);
  assert.strictEqual(byId['102'].spentSeconds, 5400);
  assert.strictEqual(byId['104'].spentSeconds, 1800);

  assert.strictEqual(byId['101'].spentUnder, true);
  assert.strictEqual(byId['101'].spentOver, false);
  assert.strictEqual(byId['102'].spentOver, true);

  assert.strictEqual(byId['101'].bonus, 2000);
  assert.strictEqual(byId['102'].bonus, 1000);
  assert.strictEqual(byId['104'].bonus, 500);

  assert.strictEqual(byId['102'].isCompleted, true);
  assert.strictEqual(byId['101'].isCompleted, false);

  assert.strictEqual(res.summary.effectiveSeconds, 3600);
  assert.strictEqual(res.summary.confirmedBonus, 1000);
  console.log('--- TEST 1 (period includes today) PASSED ---');

  // ---- TEST 2: период в прошлом (1999–2001) ----
  const res2 = await mod.computeDashboard('tok', { userId: '7', dateFrom: '1999-01-01', dateTo: '2001-01-01', rate: 1000 });
  console.log('TEST2 ids:', res2.rows.map((r) => r.id).sort());
  assert.deepStrictEqual(res2.rows.map((r) => r.id).sort(), ['103']);
  assert.strictEqual(res2.meta.periodIncludesToday, false);
  console.log('--- TEST 2 (past period) PASSED ---');

  // ---- TEST 3: РЕГРЕССИЯ на баг — задача, закрытая в прошлом периоде (июль 2026),
  //      с низким id (создана давно), должна подтягиваться ----
  const res3 = await mod.computeDashboard('tok', { userId: '7', dateFrom: '2026-07-01', dateTo: '2026-07-31', rate: 1000 });
  console.log('TEST3 ids:', res3.rows.map((r) => r.id).sort());
  assert.strictEqual(res3.meta.periodIncludesToday, false);
  assert.deepStrictEqual(res3.rows.map((r) => r.id).sort(), ['1893'], 'task closed in past period must be included');
  assert.strictEqual(res3.rows[0].isCompleted, true);
  console.log('--- TEST 3 (closed-in-past-period regression) PASSED ---');

  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e.stack || e.message); process.exit(1); });
