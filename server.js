'use strict';

/*
 * Дашборд эффективных часов на основе данных Битрикс24 (VibeCode).
 *
 * Бэкенд (без внешних зависимостей, Node 20+):
 *  - отдаёт статику фронтенда из ./public
 *  - проксирует обращения к VibeCode API, добавляя X-Api-Key и Bearer-сессию
 *  - реализует OAuth-флоу для прямого доступа по URL приложения
 *  - поддерживает BFF-режим (placement): заголовок X-Vibe-Authorization, который
 *    шлюз VibeCode подставляет при открытии приложения внутри Битрикс24
 *  - считает таблицу задач и итоговые карточки
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const VIBE_BASE = (process.env.VIBE_BASE || 'https://vibecode.bitrix24.tech/v1').replace(/\/$/, '');
const API_KEY = process.env.VIBE_API_KEY || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const REDIRECT_URI = APP_BASE_URL ? APP_BASE_URL + '/callback' : '';

if (!API_KEY) console.error('[warn] VIBE_API_KEY is not set');
if (!APP_BASE_URL) console.error('[warn] APP_BASE_URL is not set (OAuth redirect will not work)');

// ---- in-memory session store: sid -> { token, expiresAt } -----------------
const sessions = new Map();
const oauthStates = new Map(); // state -> createdAt
const SESSION_TTL = 23 * 60 * 60 * 1000; // 23h, под токен на 24h

function cleanupMaps() {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt <= now) sessions.delete(sid);
  for (const [st, ts] of oauthStates) if (now - ts > 15 * 60 * 1000) oauthStates.delete(st);
}
setInterval(cleanupMaps, 5 * 60 * 1000).unref();

// кэш домена портала (для построения ссылок)
let portalDomainCache = null;

// ---- helpers ---------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function resolveBearer(req) {
  // 1) BFF / placement: шлюз подставляет сессию
  const injected = req.headers['x-vibe-authorization'];
  if (injected) {
    return String(injected).replace(/^Bearer\s+/i, '').trim();
  }
  // 2) собственная OAuth-сессия по cookie
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (sid && sessions.has(sid)) {
    const s = sessions.get(sid);
    if (s.expiresAt > Date.now()) return s.token;
    sessions.delete(sid);
  }
  return null;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// обращение к VibeCode API с обоими заголовками
async function vibe(method, pathAndQuery, token, body) {
  const url = VIBE_BASE + pathAndQuery;
  const headers = { 'X-Api-Key': API_KEY };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let json = null;
  const text = await r.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function getPortalDomain(token) {
  if (portalDomainCache) return portalDomainCache;
  try {
    const { json } = await vibe('GET', '/me', token);
    const portal = json && json.data && json.data.portal;
    if (portal) { portalDomainCache = portal; return portal; }
  } catch (e) { /* ignore */ }
  return null;
}

// ---- OAuth -----------------------------------------------------------------
function buildAuthorizeUrl() {
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now());
  const params = new URLSearchParams({
    app_key: API_KEY,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return VIBE_BASE + '/oauth/authorize?' + params.toString();
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !oauthStates.has(state)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h3>Ошибка авторизации: неверный state или code.</h3><a href="/">На главную</a>');
    return;
  }
  oauthStates.delete(state);
  try {
    const r = await fetch(VIBE_BASE + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: API_KEY, code, redirect_uri: REDIRECT_URI }),
    });
    const data = await r.json();
    const token = data && (data.access_token || (data.data && data.data.access_token));
    if (!token) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Не удалось обменять код на сессию.</h3><pre>' +
        escapeHtml(JSON.stringify(data)) + '</pre><a href="/">Повторить</a>');
      return;
    }
    const expiresIn = Number(data.expires_in || 86400) * 1000;
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { token, expiresAt: Date.now() + Math.min(expiresIn, SESSION_TTL) });
    res.writeHead(302, {
      'Set-Cookie': `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
      'Location': '/',
    });
    res.end();
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h3>Ошибка обмена кода: ' + escapeHtml(String(e.message)) + '</h3><a href="/">Повторить</a>');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- статус задачи: коды Битрикс24 -> требуемые подписи --------------------
function statusLabel(code) {
  switch (Number(code)) {
    case 5: return 'Завершена';
    case 6: return 'Отложена';
    case 3: return 'Выполняется';
    case 4: return 'Выполняется';   // ожидает контроля ~ выполняется
    case 2: return 'Ждет выполнения';
    case 1: return 'Ждет выполнения';
    case 7: return 'Отложена';      // отклонена
    default: return 'Ждет выполнения';
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// today в часовом поясе портала (Москва для *.bitrix24.ru)
function portalToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

// ---- основной расчёт дашборда ---------------------------------------------
async function computeDashboard(token, params) {
  const userId = String(params.userId || '').trim();
  const dateFrom = String(params.dateFrom || '').trim(); // YYYY-MM-DD
  const dateTo = String(params.dateTo || '').trim();
  const rate = num(params.rate);
  if (!userId) throw httpError(400, 'Не выбран сотрудник');
  if (!dateFrom || !dateTo) throw httpError(400, 'Не указан период');

  const today = portalToday();
  const periodIncludesToday = dateFrom <= today && today <= dateTo;

  // 1) задачи сотрудника с включённым учётом времени
  const select = [
    'id', 'title', 'status', 'responsibleId', 'groupId',
    'closedDate', 'timeEstimate', 'timeSpentInLogs', 'allowTimeTracking',
  ];
  const qp = new URLSearchParams();
  qp.set('filter[responsibleId]', userId);
  qp.set('filter[allowTimeTracking]', 'Y');
  qp.set('select', select.join(',')); // comma-форма (повторяющийся ?select= ломает выборку)
  qp.set('order[id]', 'desc');
  qp.set('limit', '5000');

  const tasksResp = await vibe('GET', '/tasks?' + qp.toString(), token);
  if (tasksResp.status === 401) throw httpError(401, 'Сессия истекла');
  if (!tasksResp.json || tasksResp.json.success === false) {
    throw httpError(502, 'Ошибка получения задач: ' + JSON.stringify(tasksResp.json && tasksResp.json.error));
  }
  const allTasks = Array.isArray(tasksResp.json.data) ? tasksResp.json.data : [];

  // 2) карта названий рабочих групп (проектов)
  const groupsMap = new Map();
  try {
    const gq = new URLSearchParams();
    gq.set('select', 'id,name');
    gq.set('limit', '500');
    const gr = await vibe('GET', '/workgroups?' + gq.toString(), token);
    if (gr.json && Array.isArray(gr.json.data)) {
      for (const g of gr.json.data) groupsMap.set(String(g.id), g.name || '');
    }
  } catch (e) { /* ignore */ }

  // 3) залогированное исполнителем время по задачам (сумма по taskId)
  const spentByTask = new Map();
  try {
    let offset = 0;
    const pageLimit = 500;
    for (let page = 0; page < 80; page++) {
      const tq = new URLSearchParams();
      tq.set('userId', userId);
      tq.set('limit', String(pageLimit));
      tq.set('offset', String(offset));
      const tr = await vibe('GET', '/task-time?' + tq.toString(), token);
      if (!tr.json || !Array.isArray(tr.json.data)) break;
      for (const it of tr.json.data) {
        const tid = String(it.taskId);
        spentByTask.set(tid, (spentByTask.get(tid) || 0) + num(it.seconds));
      }
      const hasMore = tr.json.meta && tr.json.meta.hasMore;
      if (!hasMore || tr.json.data.length === 0) break;
      offset += pageLimit;
    }
  } catch (e) { /* ignore, упадём на timeSpentInLogs */ }

  const portal = await getPortalDomain(token);
  const portalUrl = portal ? 'https://' + portal : '';

  // 4) фильтрация и сборка строк
  const rows = [];
  for (const t of allTasks) {
    // защита: учёт времени включён
    const att = t.allowTimeTracking !== undefined ? t.allowTimeTracking : t.ALLOW_TIME_TRACKING;
    if (att !== undefined && att !== null) {
      const enabled = att === 'Y' || att === true || att === 1 || att === '1';
      if (!enabled) continue;
    }

    const statusNum = Number(t.status);
    const isCompleted = statusNum === 5;
    const closedRaw = t.closedDate || t.CLOSED_DATE || null;
    const closedDay = closedRaw ? String(closedRaw).slice(0, 10) : null;
    const closedInRange = closedDay && closedDay >= dateFrom && closedDay <= dateTo;

    const include = periodIncludesToday
      ? (!isCompleted || closedInRange)
      : closedInRange;
    if (!include) continue;

    const groupId = String(t.groupId || '0');
    const plannedSeconds = num(t.timeEstimate);
    const spentSeconds = spentByTask.has(String(t.id))
      ? spentByTask.get(String(t.id))
      : num(t.timeSpentInLogs);

    // премия: ставка * плановые часы; если плановых нет — ставка * потраченные
    const hoursForBonus = plannedSeconds > 0 ? plannedSeconds / 3600 : spentSeconds / 3600;
    const bonus = rate * hoursForBonus;

    const respId = String(t.responsibleId || userId);
    const projectName = groupsMap.get(groupId) || (groupId !== '0' ? 'Проект #' + groupId : 'Без проекта');
    const projectUrl = (portalUrl && groupId !== '0')
      ? `${portalUrl}/workgroups/group/${groupId}/` : '';
    const taskUrl = portalUrl
      ? `${portalUrl}/company/personal/user/${respId}/tasks/task/view/${t.id}/` : '';

    rows.push({
      id: String(t.id),
      projectName,
      projectUrl,
      title: t.title || ('Задача #' + t.id),
      taskUrl,
      statusCode: statusNum,
      status: statusLabel(statusNum),
      isCompleted,
      spentSeconds,
      plannedSeconds,
      spentOver: plannedSeconds > 0 && spentSeconds > plannedSeconds,
      spentUnder: plannedSeconds > 0 && spentSeconds < plannedSeconds,
      bonus,
    });
  }

  // 5) итоговые карточки — только завершённые задачи
  let effectiveSeconds = 0;
  let confirmedBonus = 0;
  for (const r of rows) {
    if (r.statusCode === 5) {
      effectiveSeconds += r.plannedSeconds;
      confirmedBonus += r.bonus;
    }
  }

  return {
    rows,
    summary: { effectiveSeconds, confirmedBonus },
    meta: { today, periodIncludesToday, count: rows.length, portal },
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// ---- API -------------------------------------------------------------------
async function handleApi(req, res, url, token) {
  const p = url.pathname;

  if (p === '/api/me') {
    if (!token) {
      return sendJson(res, 200, { authenticated: false, authorizeUrl: REDIRECT_URI ? buildAuthorizeUrl() : null });
    }
    const { status, json } = await vibe('GET', '/me', token);
    if (status === 401 || !json || json.success === false) {
      return sendJson(res, 200, { authenticated: false, authorizeUrl: REDIRECT_URI ? buildAuthorizeUrl() : null });
    }
    const cu = json.data && json.data.currentUser;
    if (json.data && json.data.portal) portalDomainCache = json.data.portal;
    return sendJson(res, 200, {
      authenticated: true,
      portal: json.data && json.data.portal,
      userId: cu && cu.bitrixUserId,
    });
  }

  if (!token) return sendJson(res, 401, { error: 'unauthorized', authorizeUrl: REDIRECT_URI ? buildAuthorizeUrl() : null });

  if (p === '/api/users') {
    // НЕ передаём select (повторяющийся ?select=a&select=b ломает выборку полей в
    // обёртке) и не передаём order — берём полные записи, фильтруем/сортируем тут
    const { status, json } = await vibe('GET', '/users?limit=1000', token);
    if (status === 401) return sendJson(res, 401, { error: 'unauthorized', authorizeUrl: buildAuthorizeUrl() });
    if (!json || json.success === false) return sendJson(res, 502, { error: json && json.error });

    const pick = (u, ...keys) => {
      for (const k of keys) {
        if (u[k] !== undefined && u[k] !== null && String(u[k]).trim() !== '') return String(u[k]).trim();
      }
      return '';
    };
    const users = (json.data || [])
      .filter((u) => {
        const a = u.active !== undefined ? u.active : u.ACTIVE;
        return a === undefined || a === null || a === true || a === 'Y' || a === 1 || a === '1';
      })
      .map((u) => {
        const id = pick(u, 'id', 'ID', 'iD');
        const first = pick(u, 'name', 'NAME');
        const last = pick(u, 'lastName', 'LAST_NAME');
        const second = pick(u, 'secondName', 'SECOND_NAME');
        // «Фамилия Имя» — имена и фамилии сотрудников; запасные варианты, если ФИО пустые
        let label = [last, first].filter(Boolean).join(' ').trim();
        if (!label) label = second || pick(u, 'email', 'EMAIL') || pick(u, 'login', 'LOGIN') || (id ? 'ID ' + id : '');
        return { id, label, position: pick(u, 'workPosition', 'WORK_POSITION') };
      })
      .filter((u) => u.id && u.label);
    users.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    return sendJson(res, 200, { users });
  }

  if (p === '/api/dashboard' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return sendJson(res, 400, { error: 'bad json' }); }
    try {
      const result = await computeDashboard(token, body);
      return sendJson(res, 200, result);
    } catch (e) {
      const st = e.httpStatus || 500;
      if (st === 401) return sendJson(res, 401, { error: 'unauthorized', authorizeUrl: buildAuthorizeUrl() });
      return sendJson(res, st, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ---- статика ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveStatic(res, file) {
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---- сервер ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/health' || p === '/api/status') {
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/callback') {
      return handleCallback(req, res, url);
    }
    if (p.startsWith('/api/')) {
      const token = resolveBearer(req);
      return await handleApi(req, res, url, token);
    }
    if (p === '/' || p === '/index.html') {
      return serveStatic(res, 'index.html');
    }
    // прочая статика
    return serveStatic(res, p.replace(/^\//, ''));
  } catch (e) {
    console.error('[error]', e);
    try { sendJson(res, 500, { error: 'internal error' }); } catch { /* */ }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Dashboard listening on :${PORT}`);
  });
}

// экспорт чистых функций для тестов
module.exports = { server, statusLabel, portalToday, computeDashboard, __setFetch: (f) => { globalThis.fetch = f; } };
