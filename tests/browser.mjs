import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = http.createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const hostStubs = {
            '/script.js': `export const getRequestHeaders = window.entryState.api.headers; export const saveSettings = window.entryState.api.saveSettings; export const isGenerating = () => false;`,
            '/scripts/extensions.js': `export const getContext = () => ({...window.entryState.ctx,eventSource:{once(){}},eventTypes:{APP_READY:'app_ready'}});`,
            '/scripts/preset-manager.js': `export const getPresetManager = id => ({getSelectedPresetName: () => window.entryState.ctx.selectedPresets[id]});`,
            '/scripts/user.js': `export const getCurrentUserHandle = () => 'entry-test';`,
            '/scripts/world-info.js': `export const selected_world_info = ['晨雾之城']; export const world_info = {};`,
        };
        if (hostStubs[pathname]) { res.setHeader('Content-Type', 'text/javascript'); res.end(hostStubs[pathname]); return; }
        const normalized = pathname.replace('/scripts/extensions/third-party/library-manager/', '/');
        const filename = path.resolve(root, '.' + normalized);
        if (!filename.startsWith(root)) { res.writeHead(403).end(); return; }
        const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css' };
        res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
        res.end(await fs.readFile(filename));
    } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/tests/harness.html`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 940 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ready = async () => { await page.waitForFunction(() => window.ready && !window.ui.busy); };
const category = async label => { await page.locator('.stlm-nav button').filter({ hasText: label }).click(); };
const action = async name => page.locator(`[data-action=${name}]`).click();
const confirm = async phrase => {
    await page.locator('.stlm-confirm input').fill(phrase);
    await page.locator('.stlm-confirm-actions button').last().click();
    await page.waitForFunction(() => !window.ui.busy);
};
try {
    await page.goto(url); await ready();
    assert.equal(await page.locator('.stlm-row').count(), 3);
    await category('预设');
    assert.equal(await page.locator('.stlm-row').count(), 2);
    assert.match(await page.locator('.stlm-subtitle').innerText(), /对话补全预设/);
    assert.ok(!(await page.locator('.stlm-list').innerText()).includes('指令模板 A'));
    await category('角色卡');
    // Search and selection semantics: hidden selections must never survive a filter change.
    await page.getByRole('checkbox', { name: '选择 旅行者', exact: true }).check();
    await page.getByRole('searchbox').fill('当前');
    assert.match(await page.locator('.stlm-selection').innerText(), /已选 0 项/);
    await page.getByRole('searchbox').fill('');
    await page.getByRole('checkbox', { name: '选择 旅行者', exact: true }).check();
    await action('delete');
    assert.equal(await page.locator('.stlm-confirm-actions button').last().isDisabled(), true);
    await confirm('删除 1');
    assert.match(await page.locator('.stlm-status').innerText(), /成功 1 项/);
    assert.equal(await page.evaluate(() => state.calls.find(c => c.path === '/api/characters/delete').body.delete_chats), false);
    assert.equal(await page.evaluate(async () => (await store.list())[0].status), 'deleted');
    await category('本地回收副本');
    await page.getByRole('checkbox', { name: '全选筛选结果', exact: true }).check();
    await action('restore');
    await page.locator('.stlm-confirm-actions button').last().click();
    await page.waitForFunction(() => !window.ui.busy);
    assert.match(await page.locator('.stlm-status').innerText(), /成功 1 项/);
    assert.equal(await page.evaluate(() => state.chars.find(c => c.avatar === '旅行者.v2.png').chat), 'journey');
    // IndexedDB is actually used, persists across another connection, and isolates accounts.
    const dbCheck = await page.evaluate(async () => {
        const { BackupStore } = await import('../storage.js');
        const sameAccount = await new BackupStore('browser-test').open();
        const other = await new BackupStore('another-account').open();
        return [(await sameAccount.list()).length, (await other.list()).length];
    });
    assert.deepEqual(dbCheck, [1, 0]);
    await category('主题 UI');
    await page.getByRole('checkbox', { name: '选择 旧主题', exact: true }).check();
    await page.evaluate(() => state.failures.set('/api/themes/delete', 500));
    await action('delete'); await confirm('删除 1');
    assert.match(await page.locator('.stlm-status').innerText(), /失败 1 项/);
    assert.equal(await page.getByRole('checkbox', { name: '选择 旧主题', exact: true }).count(), 1);
    await category('正则'); await action('scan');
    await page.waitForFunction(() => !window.ui.busy);
    assert.equal(await page.locator('.stlm-row').count(), 3); // imported test card has no embedded script, preset still does
    // User-controlled names render as text, never HTML.
    await page.evaluate(() => { state.settings.themes.push({ name: '<img src=x onerror=alert(1)>', custom_css: '' }); });
    await category('主题 UI'); await action('refresh'); await page.waitForFunction(() => !window.ui.busy);
    assert.equal(await page.locator('.stlm-row img').count(), 0);
    assert.ok((await page.locator('.stlm-list').innerText()).includes('<img src=x onerror=alert(1)>'));
    // Import and export use a downloadable bundle and do not mutate server data on import.
    await page.getByRole('checkbox', { name: '选择 旧主题', exact: true }).check();
    const downloadPromise = page.waitForEvent('download');
    await action('export');
    const download = await downloadPromise;
    const text = await fs.readFile(await download.path(), 'utf8');
    assert.equal(JSON.parse(text).records.length, 1);
    await page.waitForFunction(() => !window.ui.busy);
    await category('本地回收副本');
    await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.waitForFunction(() => !window.ui.busy);
    assert.match(await page.locator('.stlm-status').innerText(), /已导入 1 项/);
    // Screenshot clean sample state on desktop and phone.
    await category('角色卡');
    await page.evaluate(() => { ui.$('.stlm-log').open = false; ui.status('已读取资料。选择需要整理的项目，开始批量管理。'); });
    const screenshots = process.env.STLM_SCREENSHOTS;
    if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'desktop.png') }); }
    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, window: innerWidth, main: ui.$('.stlm-main').scrollWidth, client: ui.$('.stlm-main').clientWidth }));
    assert.ok(widths.body <= widths.window, JSON.stringify(widths));
    assert.ok(widths.main <= widths.client + 1, JSON.stringify(widths));
    assert.ok(await page.locator('[data-action=export]').isVisible());
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'mobile.png') });
    await page.getByRole('button', { name: '关闭资料管家', exact: true }).click();
    assert.equal(await page.evaluate(() => window.didReload), true);
    // Load the actual extension entry point at Tavern's third-party URL depth.
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/entry.html`);
    const drawerHeader = page.getByRole('button', { name: '资料管家', exact: true });
    const openButton = page.getByRole('button', { name: '打开资料管家', exact: true });
    assert.equal(await openButton.isVisible(), false);
    assert.equal(await drawerHeader.getAttribute('aria-expanded'), 'false');
    const otherHeader = page.locator('.inline-drawer-header').filter({ hasText: '快速回复' });
    assert.equal((await drawerHeader.boundingBox()).height, (await otherHeader.boundingBox()).height);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'entry-mobile.png') });
    await page.setViewportSize({ width: 1060, height: 740 });
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'entry-desktop.png') });
    await drawerHeader.click();
    assert.equal(await openButton.isVisible(), true);
    assert.equal(await drawerHeader.getAttribute('aria-expanded'), 'true');
    await drawerHeader.press('Enter');
    assert.equal(await openButton.isVisible(), false);
    await drawerHeader.press('Space');
    assert.equal(await openButton.isVisible(), true);
    await openButton.click();
    await page.waitForFunction(() => document.querySelector('.stlm-status')?.textContent.includes('已读取'));
    assert.equal(await page.locator('.stlm-row').count(), 3);
    await category('预设');
    const nativeNames = await page.locator('#settings_preset_openai option').allTextContents();
    const managerNames = await page.locator('.stlm-row .stlm-info strong').allTextContents();
    assert.deepEqual(managerNames.sort(), nativeNames.sort());
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'presets-desktop.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: browser delete/restore, HTTP failure, selection, IndexedDB persistence/account isolation, text-only names, export/import, desktop/mobile layout, reload after mutation, actual manifest entry/import paths, native drawer mouse/keyboard interaction and row height, exact Chat Completion preset names/count.');
} finally {
    await browser.close(); server.close();
}
