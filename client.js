window.__ModuleLoader__.load({
  id: '@machine202502/dsh-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // The card uses backdrop-filter, which would trap position:fixed children,
    // so the full-screen overlay is portaled to <body>.
    let primitives = null;
try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { primitives = null; }
// Generic tools render IconSparkleRegular in the built-in row (VARIANT_ICONS.others).
const TOOL_ICON_NAMES = ['IconSparkleRegular', 'IconApiOutlineRegular', 'IconCodeOutlineRegular'];
const ChevronUp = primitives ? primitives.IconChevronUpOutlineRegular : null;
const ChevronDown = primitives ? primitives.IconChevronDownOutlineRegular : null;
const ToolIcon = (() => {
  for (const name of TOOL_ICON_NAMES) {
    const candidate = primitives ? primitives[name] : null;
    if (typeof candidate === 'function') return candidate;
  }
  return null;
})();
let createPortal = null;
    try { createPortal = require('react-dom').createPortal; } catch { createPortal = null; }

    const PORT = 49221; // must match cordis.patch.yml bridgePort
    const base = `http://127.0.0.1:${PORT}`;
    /**
     * Diagnostics for a panel that disappears: a render crash or a console error
     * is posted to the host log instead of vanishing without a trace. The host
     * appends it to the same file as its own activation log.
     */
    const reported = new Set();
    const reportClient = (kind, detail) => {
      try {
        const text = `${kind}: ${String(detail ?? '').slice(0, 1200)}`;
        if (reported.has(text)) return;
        reported.add(text);
        if (reported.size > 50) reported.clear();
        fetch(`${base}/api/client-log`, { method: 'POST', body: text }).catch(() => {});
      } catch { /* diagnostics never break the panel */ }
    };
    const THUMB_W = 200;
    const THUMB_H = 125;

    // Chrome mirrors TodoPanel.module.css from @deepseek-ai/dsh-client-ui-conversation.
    // One document-wide stylesheet: tool rows must stay styled even when the
// browser card is not mounted (e.g. while a tool is still preparing).
const ensureStyles = () => {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin="browser-panel"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'browser-panel';
  tag.dataset.pluginCss = 'browser-panel';
  tag.textContent = CSS;
  document.head.appendChild(tag);
};


/**
 * Interface languages and the resolution order shared by the plugins in this
 * folder: a saved ru/en/zh wins, a saved `auto` follows the application
 * locale, and with no setting at all the default is ru.
 */
const UI_LANGUAGES = ['ru', 'en', 'zh'];
const LANGUAGES = [...UI_LANGUAGES, 'auto'];
const DEFAULT_LANGUAGE = 'ru';

/** The application locale, consulted only when the saved setting is `auto`. */
const detectLanguage = () => {
  const probes = [
    typeof document === 'undefined' ? '' : document.documentElement?.lang,
    typeof navigator === 'undefined' ? '' : navigator.language,
  ];
  for (const probe of probes) {
    const raw = String(probe ?? '').trim().toLowerCase();
    if (raw.length === 0) continue;
    if (raw.startsWith('ru')) return 'ru';
    if (raw.startsWith('zh')) return 'zh';
    return 'en';
  }
  return 'en';
};

const resolveLanguage = (preference) => {
  if (UI_LANGUAGES.includes(preference)) return preference;
  if (preference === 'auto') return detectLanguage();
  return DEFAULT_LANGUAGE;
};

/** Fill `{name}` holes in one localized string. */
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (match, key) => (values?.[key] === undefined ? match : String(values[key])));

/** Russian plural form: 1 вкладка, 2 вкладки, 5 вкладок. */
const pluralRu = (n, one, few, many) => {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

/**
 * Every user-visible string in this bundle. English is the reference wording;
 * ru and zh are translations of the same keys. Nothing outside this table is
 * rendered as interface copy.
 */
const STRINGS = {
  ru: {
    // Dock card
    browser: 'Браузер',
    tabs: (n) => `${n} ${pluralRu(n, 'вкладка', 'вкладки', 'вкладок')}`,
    closeTab: 'Закрыть вкладку',
    closeAll: 'Закрыть все',
    frame: 'кадр…',
    closed: 'вкладка закрыта',
    proxy: 'прокси',
    untitled: '(без названия)',
    subagentTab: 'вкладка подагента {key}',
    subagent: 'подагент',
    subagentBrowser: 'браузер подагента {key}',
    panelError: 'Ошибка панели браузера: {detail}',
    // Tool row
    tool: 'Инструмент',
    toolCall: 'Вызов инструмента',
    toolTitles: {
      browser_open: 'Браузер: открыть',
      browser_navigate: 'Браузер: перейти',
      browser_click: 'Браузер: клик',
      browser_resize: 'Браузер: размер',
      browser_drag: 'Браузер: перетаскивание',
      browser_run: 'Браузер: команда',
    },
    clickSelector: 'Клик по {selector}',
    resize: 'Размер {width}×{height}',
    dragOnPage: 'Перетаскивание на странице',
    toolGlyph: '>_',
    times: '×',
    in: 'ВХОД',
    out: 'ВЫХОД',
    screenshot: 'снимок экрана',
    openLarger: 'открыть крупнее',
    close: 'закрыть',
    closeGlyph: '×',
    // Sidebar
    browsers: (n) => `${n} ${pluralRu(n, 'браузер', 'браузера', 'браузеров')}`,
    tabsOpen: (n) => `Открыто вкладок: ${n}`,
    openCount: (n) => `Открыто: ${n}`,
    openSession: 'Открыть сессию',
    noBrowsers: 'Нет открытых браузеров. Откройте браузер в сессии — он появится здесь.',
    sessionFallback: 'Сессия {id}',
    // Settings form
    settingsSummary: 'Изолированный браузер Playwright на сессию',
    saved: 'Сохранено — применится к новым браузерам',
    save: 'Сохранить',
    saving: 'Сохранение…',
    loading: 'Загрузка…',
    unavailable: 'Сервис настроек недоступен',
    saveFailed: 'Не удалось сохранить',
    headless: 'Без окна',
    viewport: 'Вьюпорт',
    screenshots: 'Скриншоты',
    screenshotQuality: 'Качество скриншотов',
    viewportHint: 'Размер окна по умолчанию для новых вкладок',
    qualityHint: 'Качество JPEG, 10–100',
    language: 'Язык',
    languageHint: 'Язык интерфейса; «Авто» — по языку приложения',
    languageRu: 'Русский',
    languageEn: 'English',
    languageZh: '中文',
    languageAuto: 'Авто',
  },
  en: {
    // Dock card
    browser: 'Browser',
    tabs: (n) => `${n} tab${n === 1 ? '' : 's'}`,
    closeTab: 'Close tab',
    closeAll: 'Close all',
    frame: 'frame…',
    closed: 'tab closed',
    proxy: 'proxy',
    untitled: '(untitled)',
    subagentTab: 'subagent tab {key}',
    subagent: 'subagent',
    subagentBrowser: 'subagent browser {key}',
    panelError: 'Browser panel error: {detail}',
    // Tool row
    tool: 'Tool',
    toolCall: 'Tool call',
    toolTitles: {
      browser_open: 'Browser open',
      browser_navigate: 'Browser navigate',
      browser_click: 'Browser click',
      browser_resize: 'Browser resize',
      browser_drag: 'Browser drag',
      browser_run: 'Browser run',
    },
    clickSelector: 'Click {selector}',
    resize: 'Resize {width}×{height}',
    dragOnPage: 'Drag on page',
    toolGlyph: '>_',
    times: '×',
    in: 'IN',
    out: 'OUT',
    screenshot: 'screenshot',
    openLarger: 'open larger',
    close: 'close',
    closeGlyph: '×',
    // Sidebar
    browsers: (n) => `${n} browser${n === 1 ? '' : 's'}`,
    tabsOpen: (n) => `${n} tab${n === 1 ? '' : 's'} open`,
    openCount: (n) => `${n} open`,
    openSession: 'Open session',
    noBrowsers: 'No open browsers. Open one from a session and it will appear here.',
    sessionFallback: 'Session {id}',
    // Settings form
    settingsSummary: 'Isolated Playwright browser per session',
    saved: 'Saved — applies to newly opened browsers',
    save: 'Save',
    saving: 'Saving…',
    loading: 'Loading…',
    unavailable: 'Settings service is unavailable',
    saveFailed: 'save failed',
    headless: 'Headless',
    viewport: 'Viewport',
    screenshots: 'Screenshots',
    screenshotQuality: 'Screenshot quality',
    viewportHint: 'Default window size for new tabs',
    qualityHint: 'JPEG quality, 10–100',
    language: 'Language',
    languageHint: 'Interface language; Auto follows the application language',
    languageRu: 'Русский',
    languageEn: 'English',
    languageZh: '中文',
    languageAuto: 'Auto',
  },
  zh: {
    // Dock card
    browser: '浏览器',
    tabs: (n) => `${n} 个标签页`,
    closeTab: '关闭标签页',
    closeAll: '全部关闭',
    frame: '画面…',
    closed: '标签页已关闭',
    proxy: '代理',
    untitled: '（无标题）',
    subagentTab: '子代理标签页 {key}',
    subagent: '子代理',
    subagentBrowser: '子代理浏览器 {key}',
    panelError: '浏览器面板错误：{detail}',
    // Tool row
    tool: '工具',
    toolCall: '工具调用',
    toolTitles: {
      browser_open: '浏览器：打开',
      browser_navigate: '浏览器：导航',
      browser_click: '浏览器：点击',
      browser_resize: '浏览器：调整大小',
      browser_drag: '浏览器：拖动',
      browser_run: '浏览器：命令',
    },
    clickSelector: '点击 {selector}',
    resize: '调整大小 {width}×{height}',
    dragOnPage: '在页面上拖动',
    toolGlyph: '>_',
    times: '×',
    in: '输入',
    out: '输出',
    screenshot: '截图',
    openLarger: '放大查看',
    close: '关闭',
    closeGlyph: '×',
    // Sidebar
    browsers: (n) => `${n} 个浏览器`,
    tabsOpen: (n) => `已打开 ${n} 个标签页`,
    openCount: (n) => `已打开 ${n} 个`,
    openSession: '打开会话',
    noBrowsers: '没有打开的浏览器。在会话中打开一个，它就会出现在这里。',
    sessionFallback: '会话 {id}',
    // Settings form
    settingsSummary: '每会话独立的 Playwright 浏览器',
    saved: '已保存 — 对新打开的浏览器生效',
    save: '保存',
    saving: '保存中…',
    loading: '加载中…',
    unavailable: '设置服务不可用',
    saveFailed: '保存失败',
    headless: '无头模式',
    viewport: '视口',
    screenshots: '截图',
    screenshotQuality: '截图质量',
    viewportHint: '新标签页的默认窗口大小',
    qualityHint: 'JPEG 质量，10–100',
    language: '语言',
    languageHint: '界面语言；「自动」跟随应用语言',
    languageRu: 'Русский',
    languageEn: 'English',
    languageZh: '中文',
    languageAuto: '自动',
  },
};

/**
 * One language for every mount of this bundle: the dock card, the sidebar
 * page and the settings form live in separate slot roots, so a module-level
 * store is what keeps them in step without a DSH restart.
 */
let currentLanguage = DEFAULT_LANGUAGE;
let languagePreference; // undefined: not read yet, or no setting at all -> ru
const languageListeners = new Set();

const publishLanguage = () => {
  const next = resolveLanguage(languagePreference);
  if (next === currentLanguage) return;
  currentLanguage = next;
  for (const listener of [...languageListeners]) {
    try { listener(currentLanguage); } catch { /* a listener never breaks the panel */ }
  }
};

const setLanguagePreference = (preference) => {
  languagePreference = preference;
  publishLanguage();
};

/** Subscribe one slot component to the shared language. */
const useLanguage = () => {
  const [language, setLanguage] = React.useState(currentLanguage);
  React.useEffect(() => {
    languageListeners.add(setLanguage);
    setLanguage(currentLanguage);
    return () => { languageListeners.delete(setLanguage); };
  }, []);
  return language;
};

const useStrings = () => STRINGS[useLanguage()];

/**
 * Read the saved language once the bridge is up. Until it answers the default
 * (ru) applies; a few retries cover the host starting after this bundle.
 */
const loadLanguagePreference = async (attempt = 0) => {
  try {
    const response = await fetch(`${base}/api/settings`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    setLanguagePreference(body?.values?.language);
  } catch {
    if (attempt < 3) {
      setTimeout(() => { void loadLanguagePreference(attempt + 1); }, 1000 * (attempt + 1));
      return;
    }
    setLanguagePreference(undefined);
  }
};

const CSS = `
      .bp-root { box-sizing: border-box;
        width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
        max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-specific-menu);
        backdrop-filter: var(--dsw-menu-backdrop-filter);
        box-shadow: var(--dsw-elevation-panel);
        border: 0; flex: none; margin: 0 auto; overflow: hidden; }
      .bp-body { flex-direction: column; gap: 8px; padding: 6px 12px; display: flex; }
      .bp-head { text-align: left; cursor: pointer; background: 0 0; border: none; align-items: center; gap: 10px; width: 100%; padding: 0; display: flex; font: inherit; color: inherit; }
      .bp-lead { color: var(--dsw-alias-label-tertiary); flex: none; place-items: center; display: grid; position: relative; }
      .bp-title { color: var(--dsw-alias-label-primary); flex: none; font-size: 13px; font-weight: 500; line-height: 24px; }
      .bp-count { min-width: 0; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; flex: auto; font-size: 13px; font-weight: 400; line-height: 20px; overflow: hidden; }
      .bp-chev { color: var(--dsw-alias-label-tertiary); flex: none; place-items: center; display: grid; transition: transform .18s ease; }

      .bp-grid { display: flex; flex-wrap: wrap; gap: 10px; max-height: 232px; overflow-y: auto; animation: bp-in .18s ease-out; }
      @keyframes bp-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      .bp-tile { width: 200px; max-width: 100%; border: 0; padding: 0; background: 0 0; text-align: left; cursor: pointer;
        border-radius: var(--dsw-radius-md); color: inherit; font-family: inherit; display: flex; flex-direction: column; }
      .bp-frame { position: relative; overflow: hidden; border-radius: var(--dsw-radius-sm); }
      .bp-thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: contain; display: block; background: var(--dsw-alias-bg-base);
        border-radius: var(--dsw-radius-sm); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l1); }
      .bp-tile:hover .bp-thumb { box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l1), 0 2px 8px rgba(0,0,0,.10); }
      /* The close control lives in the caption, never over the thumbnail: a red
         button in the thumbnail's corner is a click trap — it sits where people
         click to open the live view, and the tab really closes. */
      .bp-cap-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
      .bp-close { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 0; padding: 0;
        background: 0 0; color: var(--dsw-alias-label-tertiary); display: grid; place-items: center;
        cursor: pointer; opacity: .55; transition: opacity 100ms ease, background 100ms ease, color 100ms ease; }
      .bp-close:hover, .bp-close:focus-visible { opacity: 1; background: #e5484d; color: #fff; }
      .bp-owner { position: absolute; top: 4px; left: 4px; width: 18px; height: 18px; border-radius: 9px;
        background: #7c5cff; color: #fff; display: grid; place-items: center;
        box-shadow: 0 1px 3px rgba(0,0,0,.28); }
      .bp-tool-row { display: flex; align-items: center; height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0; color: var(--dsw-alias-label-tertiary); transition: color 100ms ease; cursor: pointer; user-select: none; }
.bp-tool-row:hover { color: var(--dsw-alias-label-secondary); }
.bp-tool-leading { flex: none; width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px)); display: inline-flex; align-items: center;
  justify-content: center; margin-right: 6px; padding: 0; border: none; background: none; color: inherit; }
.bp-tool-leading svg { width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px)); }
.bp-tool-name { flex: none; font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: inherit; }
.bp-tool-sep { flex: none; width: 2px; height: 2px; border-radius: 1px; margin: 0 8px;
  background: var(--dsw-alias-label-caption); }
.bp-tool-args { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); }
.bp-shot-box { position: relative; display: inline-block; line-height: 0; }
.bp-shot-pointer { position: absolute; width: 14px; height: 18px; pointer-events: none;
  transform: translate(-1px, -1px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
.bp-body-wrap { display: flex; flex-direction: column; }
.bp-io-card { display: flex; flex-direction: column; margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-markdown-code-block); font: var(--dsw-font-markdown-code-block-small); }
.bp-io-section { display: grid; grid-template-columns: max-content 1fr; column-gap: 14px;
  align-items: baseline; padding: 12px 16px; max-height: 150px; overflow-y: auto; }
.bp-io-label { color: var(--dsw-alias-label-caption); align-self: start; position: sticky; top: 0; }
.bp-io-divider { flex: none; height: 0.5px; background: var(--dsw-alias-border-l2); }
.bp-io-text { white-space: pre-wrap; word-break: break-word; min-width: 0;
  color: var(--dsw-alias-label-secondary); }
.bp-tool-body { margin: 4px 0 6px 22px; font-size: 12px; line-height: 18px; white-space: pre-wrap;
  color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.bp-shot-indent { margin-left: 22px; }
.bp-lightbox { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
  bottom: 0 !important; z-index: 4000 !important; display: flex !important; align-items: center; justify-content: center;
  background: rgba(12,12,14,.78) !important; cursor: zoom-out; }
.bp-lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 12px; background: #fff;
  box-shadow: 0 24px 64px rgba(0,0,0,.55); }
.bp-lightbox-close { position: absolute; top: 18px; right: 22px; width: 34px; height: 34px; border-radius: 17px;
  border: none; cursor: pointer; font-size: 20px; line-height: 30px; color: #fff; background: rgba(255,255,255,.16); }
.bp-shot { display: block; width: auto; height: auto; max-width: 260px; max-height: 162px;
  box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-specific-input-major, #f3f3f4);
  cursor: zoom-in; }
.bp-shot-wrap { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 6px; max-width: 440px; }
.bp-shot-caption { font-size: var(--dsh-content-font-size-secondary, 13px); color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bp-cursor { position: absolute; width: 14px; height: 18px; pointer-events: none; display: block;
        transform: translate(-1px, -1px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.55)); }
      .bp-cursor[data-down="true"] { filter: drop-shadow(0 0 3px rgba(229,72,77,.95)) drop-shadow(0 1px 2px rgba(0,0,0,.55)); }
      .bp-cap { display: flex; flex-direction: column; gap: 1px; padding: 6px 2px 0; min-width: 0; }
      .bp-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bp-size { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }

      .bp-foot { display: flex; justify-content: flex-end; }
      .bp-ghost { background: 0 0; border: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; cursor: pointer; padding: 0; font-family: inherit; }
      .bp-ghost:hover { color: var(--dsw-alias-label-secondary); }
      .bp-empty { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
      .bp-dot { position: absolute; right: -1px; bottom: -1px; width: 6px; height: 6px; border-radius: 3px; background: #3ba55d; box-shadow: 0 0 0 2px var(--dsw-specific-menu, #fff); }

      .bp-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72); z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 28px; cursor: zoom-out; }
      /* Browser frame: the shot plus a chrome bar, never larger than the window. */
      .bp-live { display: flex; flex-direction: column; box-sizing: border-box; max-width: 100%; max-height: 100%;
        border-radius: var(--dsw-radius-md); overflow: visible; background: var(--dsw-alias-bg-base, #fff);
        box-shadow: 0 18px 56px rgba(0,0,0,.55); }
      .bp-live-shot { position: relative; display: flex; min-height: 0; flex: 0 1 auto; background: var(--dsw-alias-bg-base);
        border-radius: var(--dsw-radius-md) var(--dsw-radius-md) 0 0; }
      .bp-live img { display: block; max-width: 100%; max-height: 100%; object-fit: contain;
        border-radius: var(--dsw-radius-md) var(--dsw-radius-md) 0 0; }
      .bp-live-bar { border-radius: 0 0 var(--dsw-radius-md) var(--dsw-radius-md); flex: none; display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-secondary);
        font-size: 12px; line-height: 18px; }
      .bp-live-globe { flex: none; color: var(--dsw-alias-label-tertiary); display: grid; place-items: center; }
      .bp-live-url { flex: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-primary); font-size: 12.5px; }
      .bp-live-size { flex: none; color: var(--dsw-alias-label-tertiary); }
      .bp-live-proxy { flex: none; padding: 1px 6px; border-radius: 6px; background: rgba(124,92,255,.14);
        color: #6b4ee6; font-size: 11px; line-height: 15px; }
    .bp-side { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; max-width: 520px; }
.bp-side-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); padding: 2px 0 8px; }
.bp-side-empty { font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.bp-side-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-radius: var(--dsw-radius-lg); border: .5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-input-major, transparent); }
.bp-side-main { min-width: 0; flex: auto; display: flex; flex-direction: column; gap: 2px; }
.bp-side-name { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.bp-side-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.bp-side-action { flex: none; font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
  border-radius: var(--dsw-radius-sm); border: .5px solid var(--dsw-alias-border-l3);
  background: transparent; color: var(--dsw-alias-label-secondary); }
.bp-side-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
.bp-side-danger:hover { color: var(--dsw-alias-state-error-primary); }
`;

    const leadIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { display: 'block' }, 'aria-hidden': true,
    },
      h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
      h('path', { d: 'M3 9h18' }),
    );

    const chevron = (open) => h('span', { className: 'bp-chev', style: { transform: open ? 'none' : 'rotate(180deg)' } },
      h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M6 9l6 6 6-6' })),
    );

    const cursorArrow = (down) => h('svg', {
      className: 'bp-cursor', 'data-down': down ? 'true' : 'false',
      width: 14, height: 18, viewBox: '0 0 14 18', fill: 'none', 'aria-hidden': true,
    }, h('path', {
      d: 'M1 1 L1 15 L5 11.5 L7.5 17 L10 16 L7.5 10.5 L12.5 10.5 Z',
      fill: '#fff', stroke: '#111', strokeWidth: 1.2, strokeLinejoin: 'round',
    }));

    const robotBadge = (key, strings) => h('span', { className: 'bp-owner', title: fill(strings.subagentTab, { key }) },
      h('svg', { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 4, y: 8, width: 16, height: 12, rx: 3 }),
        h('path', { d: 'M12 4v4' }),
        h('circle', { cx: 9, cy: 14, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 14, r: 1, fill: 'currentColor', stroke: 'none' }),
      ));

    // Thumbnails letterbox the page inside a 200x125 frame, so page coordinates
    // map through that rendered box rather than the frame itself.
    function cursorStyle(tab) {
      if (!tab.cursor || !tab.viewport) return { display: 'none' };
      const vw = tab.viewport.width || 1;
      const vh = tab.viewport.height || 1;
      const scale = Math.min(THUMB_W / vw, THUMB_H / vh);
      const cx = tab.cursor.x;
      const cy = tab.cursor.y;
      return {
        left: (THUMB_W - vw * scale) / 2 + cx * scale,
        top: (THUMB_H - vh * scale) / 2 + cy * scale,
      };
    }

    function cursorOverlay(tab) {
      if (!tab || !tab.cursor || !tab.viewport) return null;
      const vw = tab.viewport.width || 1;
      const vh = tab.viewport.height || 1;
      // No clamping: a pointer outside the page renders outside the frame.
      const pctX = (tab.cursor.x / vw) * 100;
      const pctY = (tab.cursor.y / vh) * 100;
      return h('span', {
        style: { position: 'absolute', left: `${pctX}%`, top: `${pctY}%` },
      }, cursorArrow(tab.cursor.down));
    }

    function withPortal(node) {
      if (!createPortal) return node;
      try { return createPortal(node, document.body); } catch { return node; }
    }

    /** Keeps one panel crash from taking the whole composer card with it. */
    class PanelBoundaryState extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        reportClient('panel-crash', `${error?.message ?? error}\n${error?.stack ?? ''}\n${info?.componentStack ?? ''}`);
      }
      render() {
        if (!this.state.error) return this.props.children;
        const strings = STRINGS[this.props.language] ?? STRINGS[DEFAULT_LANGUAGE];
        return h('div', { className: 'bp-root' },
          h('div', { className: 'bp-body' },
            h('span', { className: 'bp-empty' }, fill(strings.panelError, { detail: String(this.state.error?.message ?? this.state.error) }))));
      }
    }

    /** Subscribes the error boundary to the language, even while it shows an error. */
    function PanelBoundary({ children }) {
      const language = useLanguage();
      return h(PanelBoundaryState, { language }, children);
    }



    // Sidebar rail icon: the same globe the fullscreen bar uses.
    function BrowserRailIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
        h('path', { d: 'M3 9h18' }),
      );
    }

    const robotMark = (key, strings) => h('span', {
      title: fill(strings.subagentBrowser, { key }),
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
        padding: '1px 6px', borderRadius: 999, fontSize: 11, lineHeight: '15px',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
      },
    },
      h('svg', {
        width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { x: 4, y: 8, width: 16, height: 12, rx: 3 }),
        h('path', { d: 'M12 4v4' }),
        h('circle', { cx: 9, cy: 14, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 14, r: 1, fill: 'currentColor', stroke: 'none' }),
      ),
      strings.subagent,
    );

    // Sidebar section mirroring the built-in page layout (TaskManagerPage):
    // 960px column, 28px heading inset, 20/28 heading, card rows.
    const S = {
      page: {
        display: 'flex', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'auto',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
        fontSize: 14, lineHeight: 1.6,
      },
      content: { maxWidth: 960, margin: '0 auto', width: '100%', padding: '0 clamp(24px, 4vw, 48px) 48px', boxSizing: 'border-box' },
      heading: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))', marginBottom: 24,
      },
      h1: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 500 },
      hint: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg)',
        padding: '12px 16px', marginBottom: 12, background: 'var(--dsw-alias-bg-base)',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
      cardTitle: {
        fontSize: 14, color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto',
      },
      cardMeta: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', flex: 'none', whiteSpace: 'nowrap' },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
        borderTop: '.5px solid var(--dsw-alias-border-l1)',
      },
      main: { minWidth: 0, flex: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
      nameLine: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      name: { fontSize: 14, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
      action: {
        flex: 'none', font: 'inherit', fontSize: 13, height: 28, padding: '0 12px', cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-md)', border: '.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        display: 'flex', alignItems: 'center', flexDirection: 'column', padding: '48px 20px',
        textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 14,
      },
    };

    function BrowsersPanel(props) {
      const strings = useStrings();
      const [list, setList] = React.useState([]);
      const [busy, setBusy] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const closed = new Set();
        const load = async () => {
          try {
            const res = await fetch(`${base}/api/browsers`);
            const body = await res.json();
            const rows = Array.isArray(body.browsers) ? body.browsers : [];
            if (!alive) return;
            setList(rows);

            // Archiving a Session emits no lifecycle event, so reconcile here:
            // a browser whose Session left the visible list is shut down.
            let archived = null;
            try { archived = props.archivedIds ? props.archivedIds() : null; } catch { archived = null; }
            if (archived) {
              for (const item of rows) {
                if (!item.running) continue;
                const own = item.sessionId ?? item.key;
                const root = item.rootSessionId ?? own;
                // Only the browser's *own* Session being archived retires it.
                // The root is the Session that spawned a subagent: archiving a
                // parent must not kill the browser of a live child Session, and
                // a resumed/forked Session inherits that root id.
                if (!archived.has(own)) continue;
                if (closed.has(item.key)) continue;
                closed.add(item.key);
                reportClient('archived-purge', `key=${item.key} own=${own} root=${root} archived=${[...archived].slice(0, 6).join(',')}`);
                fetch(`${base}/api/close-browser?key=${encodeURIComponent(item.key)}&purge=1`, { method: 'POST' }).catch(() => {});
              }
            }
          } catch { /* bridge is down; keep the last snapshot */ }
        };
        load();
        const id = setInterval(load, 2000);
        return () => { alive = false; clearInterval(id); };
      }, []);

      // SessionTarget is a plain SessionId, and titles live in the sessions list.
      const titleOf = (item) => {
        const id = item.rootSessionId ?? item.sessionId;
        try {
          const snap = props.sessions?.list?.getSnapshot?.() ?? props.sessions?.getSnapshot?.();
          const row = snap?.byId?.[id];
          const title = row?.displayTitle ?? row?.title;
          if (title) return title;
        } catch { /* fall through */ }
        return item.title ?? fill(strings.sessionFallback, { id: String(id ?? item.key).slice(-8) });
      };

      const openSession = (sessionId) => {
        try { props.uiWorkspace?.openSession(sessionId); } catch { /* navigation unavailable */ }
      };
      const live = list.filter((item) => item.running && item.tabs > 0);

      // One card per session: a session may own several browsers (a subagent's
      // browser hangs off the same root), so group by that root id.
      const groups = [];
      const bySession = new Map();
      for (const item of live) {
        const sessionKey = item.rootSessionId ?? item.sessionId ?? item.key;
        let group = bySession.get(sessionKey);
        if (!group) {
          group = { sessionKey, items: [], title: titleOf(item) };
          bySession.set(sessionKey, group);
          groups.push(group);
        }
        group.items.push(item);
      }

      const closeBrowser = async (key, sessionId) => {
        setBusy(key);
        await fetch(`${base}/api/close-browser?key=${encodeURIComponent(key)}&purge=1`, { method: 'POST' }).catch(() => {});
        setBusy(null);
      };

      const cards = groups.map((group) => h('div', { key: group.sessionKey, style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, group.title),
          h('span', { style: S.cardMeta }, strings.browsers(group.items.length)),
          h('button', {
            type: 'button', style: S.action,
            onClick: () => openSession(group.sessionKey),
          }, strings.openSession),
        ),
        group.items.map((item) => {
          const isSubagent = Boolean(item.sessionId && item.rootSessionId && item.sessionId !== item.rootSessionId);
          return h('div', { key: item.key, style: S.row },
          h('div', { style: S.main },
            h('div', { style: S.nameLine },
              h('span', { style: S.name }, strings.browser),
              isSubagent ? robotMark(item.key, strings) : null,
            ),
            h('div', { style: S.meta }, strings.tabsOpen(item.tabs)),
          ),
          h('button', {
            type: 'button', style: { ...S.action, opacity: busy === item.key ? 0.5 : 1 },
            disabled: busy === item.key,
            onClick: () => closeBrowser(item.key, group.sessionKey),
          }, strings.close),
          );
        }),
      ));

      return h('div', { style: S.page },
        h('div', { style: S.content },
          h('div', { style: S.heading },
            h('h1', { style: S.h1 }, strings.browser),
            live.length > 0 ? h('span', { style: S.hint }, strings.openCount(live.length)) : null,
          ),
          live.length === 0
            ? h('div', { style: S.empty }, strings.noBrowsers)
            : cards,
        ),
      );
    }

    // Tool-call view for browser actions: mirrors the default tool row (chevron,
    // name, args) and adds the captured frame underneath, indented.
    function ShotRow(props) {
      const strings = useStrings();
      const { block } = props;
      const content = Array.isArray(block?.content) ? block.content : [];
      const joined = content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
      const marker = /\[shot:([^|\]]+)(?:\|([^\]]*))?\]([^\n]*)/.exec(joined);
      const plain = joined.replace(/\[shot:[^\]]+\][^\n]*/, '').trim();
      const [expanded, setExpanded] = React.useState(false);
      const [open, setOpen] = React.useState(false);

      const args = block?.args && typeof block.args === 'object' ? block.args : {};
      const name = block?.name ?? 'browser';
      // Row titles and summaries are localized in STRINGS.toolTitles.
      const title = strings.toolTitles[name] ?? strings.toolCall;
      const looksLikeCode = (value) => /[{}]|=>|function\s*\(/.test(value);
      const pick = (...candidates) => candidates.find((value) => typeof value === 'string' && value.length > 0 && !looksLikeCode(value)) ?? '';
      const fromMarker = marker ? marker[3].trim() : '';
      let summary = fromMarker;
      if (!summary) {
        if (name === 'browser_click') summary = pick(args.description, args.selector ? fill(strings.clickSelector, { selector: args.selector }) : '');
        else if (name === 'browser_resize') summary = args.width && args.height ? fill(strings.resize, { width: args.width, height: args.height }) : '';
        else if (name === 'browser_drag') summary = strings.dragOnPage;
        else summary = pick(args.description, args.url, args.tab);
      }
      const short = summary.length > 70 ? summary.slice(0, 70) + '…' : summary;

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      // Same class names the built-in ToolRow uses, so type, colour and the
      // dot separator come from the original stylesheet rather than a copy.
      const header = h('div', {
        className: 'bp-tool-row',
        onClick: () => setExpanded((value) => !value),
      },
        h('span', { className: 'bp-tool-leading' },
          expanded && ChevronUp
            ? h(ChevronUp, { size: 14 })
            : ToolIcon
              ? h(ToolIcon, { size: 14 })
              : h('span', { className: 'bp-tool-glyph' }, strings.toolGlyph),
        ),
        h('span', { className: 'bp-tool-name hKdVjq_title' }, strings.tool),
        h('span', { className: 'hKdVjq_sep' }),
        h('span', { className: 'bp-tool-args hKdVjq_summary' }, title),
      );

      const argsObject = block?.args && typeof block.args === 'object' ? block.args : null;
      const inputText = (() => {
        if (!argsObject) return null;
        const clean = {};
        for (const key of ['tab', 'ctx', 'selector', 'url', 'width', 'height', 'fromX', 'fromY', 'toX', 'toY', 'text', 'all', 'host']) {
          if (argsObject[key] !== undefined) clean[key] = argsObject[key];
        }
        return Object.keys(clean).length ? JSON.stringify(clean, null, 2) : null;
      })();
      const body = expanded
        ? h('div', { className: 'bp-body-wrap' },
            h('div', { className: 'bp-io-card' },
              inputText !== null
                ? h('div', { className: 'bp-io-section' },
                    h('span', { className: 'bp-io-label' }, strings.in),
                    h('span', { className: 'bp-io-text' }, inputText),
                  )
                : null,
              inputText !== null && plain ? h('span', { className: 'bp-io-divider' }) : null,
              plain
                ? h('div', { className: 'bp-io-section' },
                    h('span', { className: 'bp-io-label' }, strings.out),
                    h('span', { className: 'bp-io-text' }, plain),
                  )
                : null,
            ),
          )
        : null;

      if (!marker) {
        return h('div', null, header, body);
      }

      const full = `${base}/api/frame/${marker[1]}`;
      const lightbox = open
        ? createPortal(
            h('div', { className: 'bp-lightbox', onClick: () => setOpen(false) },
              h('img', { src: full, alt: strings.screenshot }),
              h('button', {
                className: 'bp-lightbox-close',
                onClick: (event) => { event.stopPropagation(); setOpen(false); },
                title: strings.close,
              }, strings.closeGlyph),
            ),
            document.body,
          )
        : null;

      const cursorValues = marker && marker[2]
        ? marker[2].split(',').map((value) => Number(value))
        : null;
      const inside = cursorValues !== null && cursorValues.length === 4
        && cursorValues.every((n) => Number.isFinite(n))
        && cursorValues[2] > 0 && cursorValues[3] > 0
        && cursorValues[0] >= 0 && cursorValues[0] <= cursorValues[2]
        && cursorValues[1] >= 0 && cursorValues[1] <= cursorValues[3];
      const pointer = inside
        ? h('svg', {
            className: 'bp-shot-pointer',
            viewBox: '0 0 12 17',
            style: {
              left: `${(cursorValues[0] / cursorValues[2]) * 100}%`,
              top: `${(cursorValues[1] / cursorValues[3]) * 100}%`,
            },
          },
            h('path', {
              d: 'M1 1 L1 15 L5 11.5 L7.5 17 L10 16 L7.5 10.5 L12.5 10.5 Z',
              fill: '#fff',
              stroke: '#1b1b1f',
              strokeWidth: 1.2,
              strokeLinejoin: 'round',
            }),
          )
        : null;

      return h('div', null,
        header,
        body,
        h('div', { className: 'bp-shot-indent' },
          h('div', { className: 'bp-shot-box' },
            h('img', {
              className: 'bp-shot',
              src: full,
              alt: strings.screenshot,
              title: strings.openLarger,
              onClick: () => setOpen(true),
            }),
            pointer,
          ),
        ),
        lightbox,
      );
    }

    function useTabs(expanded, sessionId, archivedIds) {
      const [state, setState] = React.useState({ running: false, tabs: [] });
      /** Consecutive failed polls: one dropped request must not blank the card. */
      const misses = React.useRef(0);
      React.useEffect(() => {
        let alive = true;
        const closed = new Set();
        const tick = async () => {
          try {
            const [res, proxyRes] = await Promise.all([
              fetch(`${base}/api/tabs?session=${encodeURIComponent(sessionId ?? '')}`),
              fetch(`${base}/api/proxy-state`).catch(() => null),
            ]);
            if (!res.ok) throw new Error(String(res.status));
            const body = await res.json();
            if (proxyRes && proxyRes.ok) {
              const proxy = await proxyRes.json().catch(() => null);
              body.proxyHosts = proxy?.hosts ?? [];
              body.proxyAll = proxy?.all === true;
            }
            // Archiving emits no lifecycle event; shut down browsers whose
            // Session left the visible list.
            try {
              const archived = archivedIds ? archivedIds() : null;
              if (archived && archived.size > 0) {
                for (const tab of body.tabs ?? []) {
                  const key = tab.key;
                  if (!key || closed.has(key)) continue;
                  // Own Session only: a live child of an archived parent keeps
                  // its browser (see the sidebar reconcile above).
                  if (!archived.has(tab.sessionId)) continue;
                  closed.add(key);
                  reportClient('archived-purge', `key=${key} session=${tab.sessionId} root=${tab.rootSessionId} archived=${[...archived].slice(0, 6).join(',')}`);
                  fetch(`${base}/api/close-browser?key=${encodeURIComponent(key)}&purge=1`, { method: 'POST' }).catch(() => {});
                }
              }
            } catch { /* archive view unavailable */ }
            if (alive) {
              misses.current = 0;
              setState(body);
            }
          } catch {
            // A transient polling failure must not blank the panel: the last good
            // snapshot stays on screen and only three misses in a row drop it.
            if (alive) {
              misses.current += 1;
              if (misses.current >= 3) setState({ running: false, tabs: [] });
            }
          }
        };
        tick();
        const id = setInterval(tick, expanded ? 1200 : 2500);
        return () => { alive = false; clearInterval(id); };
      }, [expanded, sessionId]);
      return state;
    }

    const ownerKey = (tab) => String(tab.id).split(':')[0];
    const hostOf = (tab) => {
      try { return new URL(tab.url).hostname; } catch { return ''; }
    };
    const isProxied = (tab, hosts, all) => Boolean(all) || Boolean(hosts && hosts.includes(hostOf(tab)));

    function BrowserPanel({ sessionId, archivedIds }) {
      const strings = useStrings();
      const [open, setOpen] = React.useState(false);
      const [shotTab, setShotTab] = React.useState(null);
      const [shotImg, setShotImg] = React.useState(null);
      /** When the live view opened: a backdrop click right after opening is the
          open click itself, not a request to dismiss the view. */
      const viewOpenedAt = React.useRef(0);
      const state = useTabs(open, sessionId, archivedIds);
      const tabs = state.tabs || [];

      // Live full-size view: refresh the frame while the overlay is open and
      // preload each one so the previous frame stays visible instead of flashing.
      React.useEffect(() => {
        if (!shotTab) return undefined;
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const res = await fetch(`${base}/api/shot?tab=${encodeURIComponent(shotTab)}`);
            const body = await res.json();
            if (alive && body.image) {
              const preload = new Image();
              preload.onload = () => { if (alive) setShotImg(body.image); };
              preload.src = body.image;
            }
          } catch { /* keep the last frame */ }
          if (alive) timer = setTimeout(tick, 700);
        };
        tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [shotTab]);

      // No tabs means no browser: the Host shuts the process down with the last tab.
      if (!state.running || tabs.length === 0) return null;

      const closeTab = async (event, id) => {
        event.stopPropagation();
        await fetch(`${base}/api/close?tab=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {});
      };
      const closeAll = async (event) => {
        event.stopPropagation();
        await fetch(`${base}/api/close-all?session=${encodeURIComponent(sessionId ?? '')}`, { method: 'POST' }).catch(() => {});
      };
      const openShot = (id) => {
        setShotImg(null);
        viewOpenedAt.current = Date.now();
        setShotTab(id);
      };

      return h('section', { className: 'bp-root' },
        h('div', { className: 'bp-body' },
          h('button', { type: 'button', className: 'bp-head', onClick: () => setOpen((v) => !v), 'aria-expanded': open },
            h('span', { className: 'bp-lead' }, leadIcon(), h('span', { className: 'bp-dot' })),
            h('span', { className: 'bp-title' }, strings.browser),
            h('span', { className: 'bp-count' }, strings.tabs(tabs.length)),
            chevron(open),
          ),
          open
            ? h('div', { className: 'bp-grid' }, tabs.map((t) => h('div', {
                key: t.id, className: 'bp-tile', role: 'button', onClick: () => openShot(t.id),
              },
              h('div', { className: 'bp-frame' },
                t.thumb ? h('img', { className: 'bp-thumb', src: t.thumb, alt: '' }) : h('div', { className: 'bp-thumb' }),
                t.owner === 'sub' ? robotBadge(ownerKey(t), strings) : null,
                h('span', { style: { ...cursorStyle(t), position: 'absolute', display: cursorStyle(t).display } }, cursorArrow(t.cursor?.down)),
              ),
              h('div', { className: 'bp-cap' },
                h('div', { className: 'bp-cap-row' },
                  h('span', { className: 'bp-name' }, t.title || strings.untitled),
                  h('button', {
                    type: 'button', className: 'bp-close', title: strings.closeTab, 'aria-label': strings.closeTab,
                    onClick: (e) => closeTab(e, t.id),
                  }, h('svg', { width: 9, height: 9, viewBox: '0 0 10 10', fill: 'none' },
                      h('path', { d: 'M1.5 1.5l7 7M8.5 1.5l-7 7', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })),
                  ),
                ),
                h('span', { className: 'bp-size' },
                  (t.ctx && t.ctx !== 'ctx1' ? `${t.ctx}  ·  ` : '') +
                  `${t.viewport.width}×${t.viewport.height}` +
                  (isProxied(t, state.proxyHosts, state.proxyAll) ? `  ·  ${strings.proxy}` : '')),
              ),
            )))
            : null,
          open && tabs.length
            ? h('div', { className: 'bp-foot' },
                h('button', { type: 'button', className: 'bp-ghost', onClick: closeAll }, strings.closeAll))
            : null,
        ),
        shotTab ? withPortal(h('div', { className: 'bp-overlay', onClick: () => { if (Date.now() - viewOpenedAt.current < 300) return; setShotTab(null); } },
          (() => {
            const tab = tabs.find((t) => t.id === shotTab);
            return h('div', { className: 'bp-live', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'bp-live-shot' },
                shotImg
                  ? h('img', { src: shotImg, alt: '' })
                  : h('div', { style: { padding: 24, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } }, strings.frame),
                cursorOverlay(tab),
              ),
              h('div', { className: 'bp-live-bar' },
                h('span', { className: 'bp-live-globe' },
                  h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                    strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
                    h('circle', { cx: 12, cy: 12, r: 9 }),
                    h('path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18' }),
                  )),
                h('span', { className: 'bp-live-url', title: tab ? tab.url : '' }, tab ? tab.url : strings.closed),
                tab && isProxied(tab, state.proxyHosts, state.proxyAll) ? h('span', { className: 'bp-live-proxy' }, strings.proxy) : null,
                h('span', { className: 'bp-live-size' }, tab ? `${tab.viewport.width}×${tab.viewport.height}` : ''),
              ),
            );
          })())) : null,
      );
    }

    return {
      inject: ['slots', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        ensureStyles();
        void loadLanguagePreference();
        // Report what the console already knows: without this a crashed render
        // just removes the card and leaves nothing in the host log.
        if (typeof window !== 'undefined' && !window.__dshBrowserDiag) {
          window.__dshBrowserDiag = true;
          window.addEventListener('error', (event) => reportClient('window.error', `${event.message}\n${event.error?.stack ?? ''}`));
          window.addEventListener('unhandledrejection', (event) => reportClient('unhandledrejection', String(event.reason?.stack ?? event.reason)));
          const originalError = console.error;
          console.error = (...args) => {
            try {
              const text = args.map((value) => (value instanceof Error ? `${value.message}\n${value.stack ?? ''}` : typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
              // Only this bundle's own failures: the host console also carries
              // other plugins' noise, which must not land in the browser log.
              if (/BrowserPanel|browser-panel|dsh-browser|\bbp-/.test(text)) reportClient('console.error', text);
            } catch { /* ignore */ }
            originalError.apply(console, args);
          };
        }
        /**
     * Settings form for the Plugins page.
     *
     * The page only renders a form whose plugin registers one into
     * `plugins.row.config`, so the fields live here and write through the bridge
     * instead of the Settings namespace service.
     */
    /** Styles for the settings form: same tokens the Settings page uses. */
    const ensureSettingsStyles = () => {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="browser-settings"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'browser-settings';
      tag.textContent = `
.bp-set { display: flex; flex-direction: column; gap: 18px; max-width: 560px; padding: 4px 0 8px; font-size: 13px; line-height: 20px; }
.bp-set-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 36px; }
.bp-set-row--stack { align-items: flex-start; }
.bp-set-label { color: inherit; }
.bp-set-hint { margin-top: 2px; font-size: 12px; line-height: 16px; color: #8a8a8a; }
.bp-set-input { width: 148px; height: 32px; padding: 0 10px; border: 1px solid #dcdcdc; border-radius: 10px; background: #fff; color: inherit; font: inherit; outline: none; box-sizing: border-box; }
.bp-set-input:focus { border-color: #9a9a9a; }
.bp-set-input--short { width: 88px; }
.bp-set-select { width: 148px; cursor: pointer; }
.bp-set-group { display: flex; align-items: center; gap: 8px; }
.bp-set-x { color: #8a8a8a; }
.bp-set-switch { appearance: none; -webkit-appearance: none; position: relative; width: 36px; height: 20px; margin: 0; border-radius: 999px; background: #d9d9d9; cursor: pointer; transition: background 120ms ease; flex: none; }
.bp-set-switch:checked { background: #1f1f1f; }
.bp-set-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 120ms ease; }
.bp-set-switch:checked::after { transform: translateX(16px); }
.bp-set-actions { display: flex; align-items: center; gap: 12px; padding-top: 6px; }
.bp-set-save { height: 34px; padding: 0 16px; border: none; border-radius: 10px; background: #1f1f1f; color: #fff; font: inherit; cursor: pointer; }
.bp-set-save:disabled { opacity: 0.45; cursor: default; }
.bp-set-status { font-size: 12px; color: #8a8a8a; }
.bp-set-status--error { color: #c0392b; }
`;
      document.head.appendChild(tag);
    };

    /**
     * Settings form for the Plugins page.
     *
     * Fields mirror the operator-level knobs only: proxy rules stay with the
     * agent's tools, deployment values stay in the profile patch.
     */
    function BrowserSettingsForm() {
      ensureSettingsStyles();
      const uiLanguage = useLanguage();
      const [state, setState] = React.useState({ status: 'loading', values: {} });
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState({ text: '', error: false });

      // The select previews the picked language immediately; the saved setting
      // still decides what the rest of the UI uses until Save is pressed.
      const language = state.status === 'ready' ? resolveLanguage(state.values?.language) : uiLanguage;
      const strings = STRINGS[language];

      React.useEffect(() => {
        let alive = true;
        fetch(`${base}/api/settings`)
          .then((response) => response.json())
          .then((data) => {
            if (alive) {
              // Normalize once: a missing or unknown value is the ru default, and
              // the select then always has a real option selected.
              const savedLanguage = LANGUAGES.includes(data.values?.language)
                ? data.values.language
                : DEFAULT_LANGUAGE;
              setState({ status: 'ready', values: { ...(data.values ?? {}), language: savedLanguage } });
              // The form may mount before the initial language read finishes.
              setLanguagePreference(savedLanguage);
            }
          })
          .catch(() => {
            if (alive) setState({ status: 'error', values: {} });
          });
        return () => { alive = false; };
      }, []);

      const setPath = (path, value) => {
        setState((current) => {
          const next = { ...current.values };
          const keys = path.split('.');
          let cursor = next;
          for (const key of keys.slice(0, -1)) {
            cursor[key] = { ...(cursor[key] ?? {}) };
            cursor = cursor[key];
          }
          cursor[keys[keys.length - 1]] = value;
          return { ...current, values: next };
        });
      };

      const save = async () => {
        setSaving(true);
        setNotice({ text: '', error: false });
        try {
          const response = await fetch(`${base}/api/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(state.values),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? strings.saveFailed);
          // Language changes apply here and in every other mount, no restart.
          setLanguagePreference(state.values?.language);
          setNotice({ text: strings.saved, error: false });
        } catch (error) {
          setNotice({ text: String(error.message ?? error), error: true });
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'loading') {
        return h('div', { className: 'bp-set', style: { color: '#8a8a8a' } }, strings.loading);
      }
      if (state.status === 'error') {
        return h('div', { className: 'bp-set', style: { color: '#c0392b' } }, strings.unavailable);
      }

      const values = state.values ?? {};
      const row = (label, control, hint) =>
        h('div', { className: 'bp-set-row' },
          h('div', null,
            h('div', { className: 'bp-set-label' }, label),
            hint ? h('div', { className: 'bp-set-hint' }, hint) : null,
          ),
          control,
        );

      const switchInput = (path, checked) =>
        h('input', {
          type: 'checkbox',
          className: 'bp-set-switch',
          checked,
          onChange: (event) => setPath(path, event.target.checked),
        });

      const numberInput = (path, value, extraClass) =>
        h('input', {
          type: 'number',
          className: `bp-set-input${extraClass ? ` ${extraClass}` : ''}`,
          value: value ?? '',
          onChange: (event) => setPath(path, Number(event.target.value)),
        });

      const languageLabels = {
        ru: strings.languageRu,
        en: strings.languageEn,
        zh: strings.languageZh,
        auto: strings.languageAuto,
      };

      return h('div', { className: 'bp-set' },
        row(strings.language,
          h('select', {
            className: 'bp-set-input bp-set-select',
            value: values.language ?? DEFAULT_LANGUAGE,
            onChange: (event) => setPath('language', event.target.value),
          }, LANGUAGES.map((value) => h('option', { key: value, value }, languageLabels[value]))),
          strings.languageHint,
        ),
        row(strings.headless, switchInput('headless', values.headless !== false)),
        row(strings.viewport,
          h('div', { className: 'bp-set-group' },
            numberInput('viewport.width', values.viewport?.width, 'bp-set-input--short'),
            h('span', { className: 'bp-set-x' }, strings.times),
            numberInput('viewport.height', values.viewport?.height, 'bp-set-input--short'),
          ),
          strings.viewportHint,
        ),
        row(strings.screenshots, switchInput('shots.enabled', values.shots?.enabled !== false)),
        row(strings.screenshotQuality, numberInput('shots.quality', values.shots?.quality),
          strings.qualityHint),
        h('div', { className: 'bp-set-actions' },
          h('button', { type: 'button', className: 'bp-set-save', onClick: save, disabled: saving },
            saving ? strings.saving : strings.save),
          notice.text
            ? h('span', { className: `bp-set-status${notice.error ? ' bp-set-status--error' : ''}` }, notice.text)
            : null,
        ),
      );
    }

    /** Plugin-row summary, localized through the same shared language store. */
    function BrowserSummary() {
      return useStrings().settingsSummary;
    }

    try {
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-browser#browser',
        locale: 'browser',
      }, ({ view }) => (view === 'summary'
        ? h(BrowserSummary)
        : h(BrowserSettingsForm))));
    } catch (error) {
      console.warn('browser-panel: settings form registration failed', error);
    }

    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'browser-panel',
          order: 15,
          locale: 'browser-panel',
          inject: (sessionId, t) => ({
            sessionId,
            t,
            archivedIds: () => {
              const ws = ctx.get?.('workspaces') ?? ctx.workspaces;
              const snapshot = ws?.list?.getSnapshot?.() ?? ws?.getSnapshot?.();
              return new Set(snapshot?.archivedSessionIds ?? []);
            },
          }),
        }, (props) => h(PanelBoundary, null, h(BrowserPanel, props))));

        // Sidebar section: an icon in the rail plus the panel it selects.
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'browsers',
            order: 40,
            label: () => STRINGS[currentLanguage].browser,
          }, BrowserRailIcon));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'browsers',
            inject: () => ({
              uiWorkspace: ctx.uiWorkspace,
              sessions: ctx.sessions,
              archivedIds: () => {
                const ws = ctx.get?.('workspaces') ?? ctx.workspaces;
                const snapshot = ws?.list?.getSnapshot?.() ?? ws?.getSnapshot?.();
                const ids = snapshot?.archivedSessionIds ?? [];
                return new Set(ids);
              },
            }),
          }, BrowsersPanel));
        } catch (error) {
          console.warn('browser-panel: sidebar registration failed', error);
        }

        // Pilot: a dedicated view for browser_click rows.
        try {
          for (const key of ['browser_open', 'browser_navigate', 'browser_click', 'browser_resize', 'browser_drag', 'browser_run']) {
            ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
              name: 'tool.call.toolview',
              key,
            }, ShotRow));
          }
        } catch (error) {
          console.warn('browser-panel: toolview registration failed', error);
        }
      },
    };
  },
});
