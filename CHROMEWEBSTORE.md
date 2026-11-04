# Chrome Web Store submission — Path Tracer for n8n

Черновик листинга и обоснований для ревью. Актуальная версия — из `extension/manifest.json` (сейчас 1.4.0).

Расширение неофициальное и не связано с n8n. Это нужно явно указать в листинге.

## Manifest facts

```json
{
  "manifest_version": 3,
  "name": "Path Tracer for n8n",
  "short_name": "Path Tracer",
  "version": "1.4.0",
  "minimum_chrome_version": "111",
  "permissions": [],
  "host_permissions": [],
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["path-tracer.js"],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ]
}
```

- Нет `permissions`, нет `host_permissions`, нет фонового service worker, нет сетевых запросов.
- Единственный content script, `world: "MAIN"` (нужен доступ к клиентскому стору n8n).

## Single purpose (EN)

Trace and highlight execution paths from a trigger to the selected node in the n8n workflow editor, and isolate a single path on click.

## Single purpose (RU)

Трассировка и подсветка путей от триггера до выбранной ноды в редакторе n8n, с изоляцией одного пути по клику.

## Обоснование широких matches (permission justification, EN)

The extension only works on n8n instances. n8n can be self-hosted on any domain, so the content script must be allowed to start on any HTTP(S) page. It immediately exits unless the page is an n8n editor, detected by the `n8n:config:rest-endpoint` meta tag or by the n8n workflow canvas (`/workflow/*` plus `.vue-flow`). No page content is transmitted, stored, or modified on any other site. There is no remote code.

## Обоснование (RU)

Расширение работает только с n8n. n8n можно развернуть на любом домене, поэтому content script объявлен на все HTTP(S)-страницы. На любой странице, кроме редактора n8n, скрипт завершается на первой проверке: наличие мета-тега `n8n:config:rest-endpoint` или канваса n8n (`/workflow/*` + `.vue-flow`). Данные никуда не отправляются и не сохраняются, удалённый код не загружается.

## Data usage declaration

- Сбор данных: нет.
- Передача данных третьим лицам: нет.
- Использование данных для определения кредитоспособности / кредитов: нет.
- Remote code: нет.
- Аналитика/телеметрия: нет.
- Хранение: нет.

Privacy policy: страница `docs/privacy.html`, опубликовать по публичному URL (например, GitHub Pages) и вставить ссылку в листинг. Плейсхолдер: `https://<your-domain>/privacy.html`.

## Store listing

**Name:** Path Tracer for n8n

**Short description (EN, ≤132):**
Trace workflow paths from a trigger to any node in n8n. Unofficial, not affiliated with n8n.

**Краткое описание (RU, ≤132):**
Показывает пути от триггера до выбранной ноды в n8n. Неофициальное расширение, не связано с n8n.

**Detailed description (RU):**

Path Tracer for n8n — неофициальное расширение для редактора n8n. Кликните по ноде, и расширение подсветит все пути, которые ведут к ней от триггеров. Цвет закреплён за веткой: общий участок остаётся одного цвета, а на развилке ветки получают разные цвета. Клик по стрелке оставляет только выбранный путь; клик по пустому месту канваса или Esc снимает изоляцию. Кнопка с иконкой расширения в правом нижнем углу (или Alt+T) выключает и включает трассировку.

Работает в n8n Cloud и на self-hosted: проверено на n8n 1.123.x (до 31.12.2026), 2.41+, 2.45 stable, 2.46 beta и 3.0 beta. Никаких сетевых запросов, аналитики и хранения данных: расширение только читает открытый воркфлоу на клиенте и рисует оверлей.

Это расширение не связано с n8n, не одобрено и не спонсируется n8n.

**Detailed description (EN):**

Path Tracer for n8n is an unofficial extension for the n8n workflow editor. Click any node and it highlights every path from a trigger to that node. Each branch keeps its own color: shared segments stay one color, and new colors appear only at forks. Click a connection to isolate its path; click empty canvas or press Esc to reset. The button in the bottom-right corner (or Alt+T) turns tracing on and off.

Works with n8n Cloud and self-hosted instances: verified on n8n 1.123.x (supported until 2026-12-31), 2.41+, 2.45 stable, 2.46 beta and 3.0 beta. No network requests, no analytics, no data storage: it only reads the open workflow locally and draws an overlay.

This extension is not affiliated with, endorsed by, or sponsored by n8n.

## Supported n8n versions (verified 2026-11-01)

- n8n 1.123.91 (v1 line, security support until 2026-12-31) — works via DOM fallback.
- n8n 2.41.7 (oldest currently patched 2.x line).
- n8n 2.45.7 (stable).
- n8n 2.46.3 (beta).
- n8n 3.0.1 (v3 beta; 3.0 stable expected in December 2026).

Details and re-check command: `docs/compatibility.md`, `npm run compat -- <versions>`.

## Category

Developer Tools (или Productivity → Developer Tools).

## Assets

- Иконка 128×128: `extension/icons/128.png`.
- Скриншоты 1280×800: `store/01-fork-colors.png`, `store/02-isolated-path.png`.
- Опционально промо-картинки 440×280 и 920×680 — можно собрать из скриншотов.

## Инструкция для ревьюера (test instructions)

1. Установите расширение (unpacked/ZIP).
2. Откройте любой инстанс n8n: n8n Cloud или self-hosted, например `docker run -p 5678:5678 docker.n8n.io/n8nio/n8n`.
3. Создайте воркфлоу: Manual Trigger → Node1 → два узла (Node2, Node3) → общий узел End.
4. Откройте воркфлоу, нажмите кнопку с иконкой в правом нижнем углу (она активна по умолчанию), затем кликните по последнему узлу.
5. Ожидаемо: участок Trigger → Node1 одного цвета; на развилке ветки получают разные цвета; лишние узлы приглушены. Клик по цветной связи оставляет только её путь; Esc сбрасывает.
6. На любом не-n8n сайте (например example.com) расширение ничего не делает и не создаёт элементов.

## Чек-лист перед отправкой

- [ ] `npm run build:ext` — `extension/path-tracer.js` совпадает с корневым.
- [ ] `npm test` и `npm run test:ext` — зелёные.
- [ ] `npm run pack` — ZIP `dist/path-tracer-for-n8n-1.4.0.zip` собран.
- [ ] Версия в `extension/manifest.json` и `package.json` одинаковая.
- [ ] Опубликован `docs/privacy.html` по публичному URL и вставлен в листинг.
- [ ] Название «Path Tracer for n8n» и дисклеймер «not affiliated with n8n» в листинге.
- [ ] Заполнены single purpose и обоснование широких matches (тексты выше).
- [ ] Загружены иконка 128 и скриншоты 1280×800 из `store/`.
- [ ] Проверена установка из ZIP на чистом профиле Chrome.
- [ ] Аккаунт разработчика Chrome Web Store активирован ($5, email, 2FA).
