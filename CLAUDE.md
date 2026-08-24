# Дашборд эффективных часов (Битрикс24 · VibeCode)

Паспорт проекта и контекст для Claude Code. Прочитай целиком перед изменениями —
здесь собраны рецепт деплоя и все «грабли» портала, найденные в предыдущих сессиях.

## Что это

Веб‑дашборд по данным Битрикс24: фильтры (период дат, один сотрудник, ставка часа),
таблица задач (Проект, Задача, Статус, Потраченные часы, Плановые часы, Премия) с
сортировкой по всем колонкам, и итоговые карточки «Эффективные часы» и «Подтверждённая
премия». Дизайн — в стиле журнала (Bodoni, стеклянные элементы), логотип ava·tetis.

Портал: **avrika.bitrix24.ru**. Приложение VibeCode «Дашборд по ЭЧ проектов».

## Структура

```
server.js            # Node 20, без внешних зависимостей: статика + REST API /api/*
public/index.html    # фронтенд (вёрстка + вся клиентская логика в одном файле)
public/logo.png      # логотип ava·tetis (оригинал, отдаётся как image/png)
test/logic.test.js   # юнит‑тесты бизнес‑логики (мокают fetch, эмулируют фильтры B24)
package.json         # start: node server.js (никаких зависимостей)
```

## Локальный запуск и тесты

```bash
node --check server.js                 # синтаксис
node test/logic.test.js                # тесты (должно быть ALL TESTS PASSED)
VIBE_API_KEY=x APP_BASE_URL=https://example.com PORT=3999 node server.js   # локально
```
Любое изменение логики в `server.js` сопровождай обновлением `test/logic.test.js`.

## Ветка разработки

Разрабатывай на **`claude/bitrix24-task-dashboard-h93ny0`**, коммить и пушь туда же
(`git push -u origin claude/bitrix24-task-dashboard-h93ny0`). PR не создавай без явной просьбы.

## Аутентификация (важно понимать)

- Ключ приложения — **OAuth‑app ключ** (`vibe_app_*`). Читать данные Битрикс24 он может
  только с пользовательской сессией: заголовки `X-Api-Key: <ключ>` + `Authorization: Bearer <session>`.
- Приложение развёрнуто за шлюзом **Black Hole** (accessPolicy = OWNER_ONLY). Когда владелец
  открывает приложение в браузере и логинится, шлюз сам подставляет `X-Vibe-Authorization:
  Bearer vibe_session_*` в каждый запрос к нашему серверу. Бэкенд берёт этот заголовок как Bearer.
- Резервный путь (прямой доступ по URL) — собственный OAuth‑флоу: `/callback` уже
  зарегистрирован как redirect_uri у приложения. Обычно не нужен — работает шлюз.
- `server.js:resolveBearer()` разбирает оба случая. Ссылки на задачи строятся в контексте
  **текущего** пользователя (`/v1/me` → `currentUser.bitrixUserId`), а не ответственного.

## Деплой на VibeCode (рецепт)

Не секретные идентификаторы (можно хранить в репозитории — без ключа они бесполезны):

| Что | Значение |
|-----|----------|
| SERVER_ID | `227d0cae-b757-4f8b-8de4-1eb3fbfed474` (STANDALONE / BLACKHOLE) |
| APP_ID | `b57f3996-9130-42c2-b1ee-aa6b0f3906e8` |
| APP_URL | `https://app-6df669b18fae.vibecode.bitrix24.tech` |
| API base | `https://vibecode.bitrix24.tech/v1` |
| runtime / port / start | `node20` / `3000` / `cd /opt/app && node server.js` |
| healthPath | `/health` |

**Секрет — только `VIBE_API_KEY`** (ключ `vibe_app_*`). В репозиторий НЕ коммить (репозиторий
публичный). Владелец передаёт ключ в первом сообщении новой сессии (или через env аккаунта).

Деплой = base64‑архив в `source.content` (сервер STANDALONE это поддерживает). Шаги:

```bash
export VIBE_API_KEY="<ключ_vibe_app_*_из_сообщения_владельца>"
SID=227d0cae-b757-4f8b-8de4-1eb3fbfed474
BASE=https://vibecode.bitrix24.tech/v1

# 0) дождаться готовности сервера (деплой авто‑будит, но статус должен стать running+CONNECTED)
for i in $(seq 1 30); do
  ST=$(curl -sS "$BASE/infra/servers/$SID" -H "X-Api-Key: $VIBE_API_KEY" \
    | python3 -c "import sys,json;d=json.load(sys.stdin).get('data',{});print(d.get('status'),d.get('blackholeStatus'))")
  echo "$ST"; echo "$ST" | grep -q "running CONNECTED" && break; sleep 10
done

# 1) упаковать приложение (server.js в корне архива)
tar -czf /tmp/app.tar.gz package.json server.js public

# 2) задеплоить (env пишется в .env; секрет не попадает в репозиторий)
B64=$(base64 -w0 /tmp/app.tar.gz)
python3 - "$B64" "$VIBE_API_KEY" <<'PY' > /tmp/payload.json
import sys,json
json.dump({
  "source":{"content":sys.argv[1]},
  "runtime":"node20","start":"cd /opt/app && node server.js",
  "port":3000,"healthPath":"/health","serviceName":"app",
  "env":{"NODE_ENV":"production","VIBE_API_KEY":sys.argv[2],
         "APP_BASE_URL":"https://app-6df669b18fae.vibecode.bitrix24.tech",
         "VIBE_BASE":"https://vibecode.bitrix24.tech/v1"}
}, open("/tmp/payload.json","w"))
PY
curl -sS -X POST "$BASE/infra/servers/$SID/deploy?stream=false" \
  -H "X-Api-Key: $VIBE_API_KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/payload.json | python3 -m json.tool
```
Проверка после деплоя: `GET $APP_URL/health` → `{"ok":true}` (снаружи нужен bearer‑токен
шлюза: `POST $BASE/infra/servers/$SID/access-tokens {"mode":"api-bearer"}` — это машинный
токен для проверки доставки, пользовательской сессии Битрикс24 он не несёт).

Документация платформы: `GET https://vibecode.bitrix24.tech/v1/me` (машиночитаемое описание),
раздел `/docs/infra`. Тексты доков: `https://vibecode.bitrix24.tech/docs-content/<путь>.md`.

## Модель данных Битрикс24 и особенности портала (грабли — читай!)

Все обращения — через обёртку VibeCode (`/v1/...`, entity API). Числовые поля приходят
строками; даты — ISO. Итоги считаем в `computeDashboard()` в `server.js`.

1. **Отбор задач — ЦЕЛЕВЫМИ запросами, а не «все задачи + фильтр в коде».** У активного
   исполнителя задач больше, чем помещается в окно `limit`+`order=id desc`, и старые задачи
   (низкий id), закрытые в периоде, выпадали. Делаем два «ведра»:
   - закрытые в периоде: `filter[>=closedDate]`/`filter[<=closedDate]` (нужно всегда);
   - незавершённые: `filter[REAL_STATUS][]=1..4,6` (только если период включает сегодня).
2. **НЕ фильтруй по `allowTimeTracking`.** На этом портале флаг «Учёт времени» выключен
   даже у реальных задач (по умолчанию false при создании через API, напр. запуск проекта
   из сметы), хотя план/затраченное время проставлены. Фильтр по флагу терял задачи.
3. **`closedDate` приходит в UTC (`…Z`)**, а Битрикс фильтрует в часовом поясе портала
   (Москва). Не перепроверяй дату закрытия в коде по срезу строки — доверяй серверному
   фильтру `closedDate`, иначе теряются задачи на границе суток. `portalToday()` считает
   сегодня в `Europe/Moscow`.
4. **Названия проектов:** часть групп (архивные) не приходит в общем списке
   `GET /v1/workgroups`. Недостающие имена добираем по id: `GET /v1/workgroups/:id`
   (`resolveGroupNames()`), есть кросс‑запросный кэш. Иначе покажется «Проект #id».
5. **`?select=` — только через запятую** (`select=id,name`). Повторяющийся `?select=a&select=b`
   обёртка НЕ понимает и молча ломает выборку полей. Для `/api/users` select вообще не шлём
   (берём полные записи), иначе были «ID undefined».
6. **Статусы задач (число):** 5=Завершена, 6=Отложена, 3/4=Выполняется, 1/2=Ждёт выполнения.
   Итоговые карточки считаются ТОЛЬКО по завершённым (status 5).
7. **Ссылки:** задача — `/company/personal/user/<id_текущего_пользователя>/tasks/task/view/<id>/`;
   проект — `/workgroups/group/<groupId>/`. Часы — формат «X ч Y мин». Деньги — «руб.» (не ₽).
8. **Премия** = ставка × плановые часы; если плановых нет — ставка × затраченные. Затраченные
   часы берём по исполнителю: `GET /v1/task-time?userId=<id>` (сумма по taskId), фолбэк —
   поле задачи `timeSpentInLogs`.

## Диагностика

`GET /api/debug/tasks?ids=1893,1999,...` (нужна авторизация) — сырые поля задач
(`responsibleId`, `status`, `closedDate`, `timeEstimate`, `timeSpentInLogs`, `allowTimeTracking`).
Полезно, когда «задача не подтягивается»: сразу видно причину в данных. Временный эндпоинт —
можно убрать, когда не нужен.

## Как продолжить в новой сессии / другом аккаунте

1. В новом аккаунте Claude подключить GitHub‑доступ к `pbazar64-dev/dashboard_effective_hours`
   и открыть сессию Claude Code на ветке `claude/bitrix24-task-dashboard-h93ny0`.
2. В первом сообщении вставить `VIBE_API_KEY` (ключ `vibe_app_*`). Больше ничего вставлять не
   нужно — все остальные идентификаторы есть в этом файле.
3. Claude читает `CLAUDE.md`, и можно сразу присылать задачи на исправление: правь `server.js`
   / `public/index.html`, обновляй тесты, коммить в ветку и деплой по рецепту выше.
