# hsb-browser

DSH plugin: an isolated Playwright browser per session — live tab thumbnails in the composer dock,
a **Browser** section in the sidebar, a per-site proxy and DevTools-grade tooling for agents.
16 tools, 27 `browser_run` commands, a settings form, and a regression suite.

Изолированный браузер для каждой сессии DSH: настоящий Chromium (Playwright), живые миниатюры в доке,
раздел **Browser** в сайдбаре, прокси на уровне сайта и полный доступ к DevTools.


## Установка

1. Зависимости (Chromium ставится отдельно, `playwright-core` его не тянет):

```bash
npm install
npx playwright install chromium
```

2. Подключить плагин к профилю DSH — в `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": { "@local/browser": "link:C:\\path\\to\\hsb-browser" },
  "dsh": { "profile": { "bundles": ["…", "@local/browser"] } }
}
```

3. Перезапустить DSH: в сайдбаре появится раздел **Browser**, в доке — карточка браузера.

4. Проверка: `npm test` (нужна страница `node tests/qa-page.mjs`).

## Что даёт

- **Свой браузер на агента.** Отдельный процесс, отдельный временный профиль, свои вкладки.
  Подагент получает собственный браузер и не видит чужие.
- **Контексты.** `ctx1`, `ctx2`, … — изолированные куки и storage внутри одного браузера,
  чтобы тестировать двух клиентов на одном сервере.
- **Живые кадры.** Карточка в доке показывает миниатюры вкладок и виртуальный указатель;
  после действий (`open`, `navigate`, `click`, `resize`, `drag`) в ленту чата попадает кадр.
- **Раздел Browser в сайдбаре.** Список открытых браузеров, сгруппированный по сессиям:
  имя сессии, число вкладок, переход в сессию, закрытие отдельного браузера.
- **Прокси по сайту.** Встроенный маршрутизирующий прокси на `127.0.0.1:49222`: он смотрит хост
  каждого соединения и направляет в Hiddify только сайты из списка, остальное — напрямую.
  Chromium 156 игнорирует PAC (и `--proxy-pac-url`, и `chrome.proxy` из расширения), поэтому
  решение принимается вне браузера. Список сайтов сохраняется между перезапусками
  (`%LOCALAPPDATA%\dsh-browser\proxy-state.json`).
- **Отладка.** Сеть, консоль, куки, storage, IndexedDB, покрытие, снимок доступности, Lighthouse.

## Инструменты

| Инструмент | Назначение |
|---|---|
| `browser_open` | открыть вкладку (можно в конкретном `ctx`) |
| `browser_navigate` | перейти по адресу |
| `browser_click` | клик по CSS-селектору (не блокируется диалогом) |
| `browser_fill` | заполнить поле |
| `browser_hover` / `browser_drag` | указатель и перетаскивание (в пределах вьюпорта) |
| `browser_resize` | размер вьюпорта |
| `browser_text` | текст страницы |
| `browser_tabs` | список вкладок |
| `browser_close` | закрыть вкладку (последняя гасит браузер) |
| `browser_cdp` | сырой вызов Chrome DevTools Protocol |
| `browser_run` | диспетчер команд (см. ниже) |
| `browser_proxy_enable` / `browser_proxy_disable` / `browser_proxy_status` / `browser_proxy_list` | прокси |

Все инструменты принимают `timeout` (мс). По умолчанию 10–45 с в зависимости от операции.

## Команды `browser_run`

`browser_run({ command: "list" })` — каталог; `{ command: "help", args: { name: "network" } }` — детали.

| Команда | Что делает |
|---|---|
| `console` | `console.*` и ошибки страницы, включая асинхронные |
| `network` | запросы с кодами, типами и ошибками |
| `cookies` | get / set / clear |
| `storage` | `localStorage` / `sessionStorage` |
| `idb` | IndexedDB: базы, хранилища, строки |
| `eval` | выполнить JS, вернуть значение |
| `dom` | html / text / attrs / styles / count элемента |
| `snapshot` | дерево доступности (роль и имя) |
| `keyboard` | `press`, `type`, `down`, `up` |
| `dialog` | `accept` / `dismiss` / текст для `prompt` |
| `emulate` | сеть, цветовая схема, CPU, часовой пояс, геолокация |
| `metrics` | метрики производительности страницы |
| `trace` | запись Playwright-трейса |
| `coverage` | покрытие JS между start и stop |
| `downloads` | файлы, скачанные браузером |
| `lighthouse` | аудит: оценки, метрики, проваленные проверки |
| `report` | разбор сохранённого отчёта: список или один аудит |
| `css` | сработавшие правила для элемента: селекторы, свойства, медиазапросы, шрифты |
| `assets` | ресурсы страницы по типам, `download: true` — сохранить на диск |
| `html` | полный HTML документа в файл |
| `screenshot` | снимок страницы или элемента в файл (открывается `read_image`) |
| `diff` | пиксельное сравнение двух скриншотов |
| `ws` | WebSocket-соединения и кадры в обе стороны |
| `wait` | ждать селектор или текст |
| `ctx` | вкладки по контекстам |
| `cdp` | произвольный метод протокола |

## Конфигурация

```yaml
- id: browser
  name: '@local/browser'
  config:
    headless: true
    bridgePort: 49221
    idleTimeoutMs: 900000
    viewport: { width: 1280, height: 800 }
    proxy:
      server: 127.0.0.1:10901
    shots:
      enabled: true
      on: [open, navigate, click, resize, drag]
      quality: 55
      minIntervalMs: 1500
```

## Архитектура

- **Host** (`index.js`) держит по менеджеру на агента, регистрирует инструменты и мост
  `127.0.0.1:49221` для клиентской части.
- **Менеджер** (`src/browser-manager.js`) запускает Chromium через `launchPersistentContext`
  во временном профиле, который удаляется при закрытии браузера.
- **Мост** (`src/bridge.js`) отдаёт вкладки, кадры и состояние прокси клиенту.
- **Клиент** (`client.js`) рисует карточку в доке, раздел в сайдбаре и вид строки инструмента
  с миниатюрой кадра.
- **Прокси** (`src/routing-proxy.js`) маршрутизирует соединения по правилам из моста.

## Ограничения

- **`lighthouse`** требует установленного пакета; при его отсутствии команда вернёт
  понятную ошибку, остальной плагин продолжит работать.

## Требования

- Chromium из Playwright (`ms-playwright`), путь можно задать через `DSH_BROWSER_EXE`.
- `lighthouse` — необязательная зависимость: команда `lighthouse` вернёт понятную ошибку,
  если пакет не установлен. Остальной плагин работает без него.

## Завершение процессов

Браузер не переживает хост. Помимо штатного закрытия по `dispose`, рядом с каждым браузером
запускается отдельный сторож (`src/watchdog.mjs`): если процесс DSH исчез, он закрывает Chromium
через его собственный DevTools-эндпоинт. Платформа не важна — это Node и CDP, без `taskkill`.
