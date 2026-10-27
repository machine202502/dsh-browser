# Regression suite

`node tests/regression.mjs` (или `npm test` в каталоге плагина) прогоняет все возможности
менеджера браузера на локальной тестовой странице и печатает `PASS`/`FAIL` по каждому пункту.

## Что нужно

- Chromium из Playwright (тот же, что использует плагин).
- Тестовая страница на `http://127.0.0.1:5099/`:

```powershell
node tests/qa-page.mjs
```

  Страницу можно подменить: `QA_PAGE=http://127.0.0.1:3000/ node tests/regression.mjs`.
  Своя страница должна иметь те же элементы: `#i`, `#echo`, `#out`, `#box`, `#alert`,
  `#idb`, `#download`, `#ws` и отдавать `/style.css` и `/file.txt`.

## Покрытие

| Проверка | Что подтверждает |
|---|---|
| open page | запуск Chromium, профиль, навигация |
| fill + click + dom text | действия и чтение DOM |
| keyboard enter | ввод с клавиатуры |
| snapshot | дерево доступности |
| dialog accept | ответ на `alert` |
| network list + detail + body | перехват запросов, заголовки, тело |
| css matched rules | правила и медиазапросы для элемента |
| assets list | инвентарь ресурсов |
| html to file | полный HTML в файл |
| screenshot page + element | снимок страницы и кроп элемента |
| diff two shots | пиксельное сравнение |
| console with args | аргументы консоли |
| indexeddb roundtrip | база → хранилище → строки |
| coverage start/stop | покрытие JS |
| emulate dark scheme | эмуляция медиа |
| download | файл в папке запуска |
| websocket frames | кадры в обе стороны |
| perf counters | счётчики производительности |
| context isolation | `ctx2` не делит storage с `ctx1` |
| close removes profile | профиль удалён после закрытия |

## Что тест не покрывает

- UI-часть: карточка в доке, сайдбар, форма настроек — проверяется глазами.
- `lighthouse` — внешний пакет, прогон занимает ~10 с и требует сети.
- Мост и прокси — зависят от запущенного приложения DSH.
