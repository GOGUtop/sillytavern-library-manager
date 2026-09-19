import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogFrom, parseBundle, createBundle, runBatch, makeItem, regexItems, same, restoreOrder } from '../core.js';
import { fixture, MemoryStore, script } from './fixtures.js';

test('Preset category matches Chat Completion names, excluding templates with the same name', () => {
    const { settings, chars, ctx } = fixture();
    settings.instruct.push({ name: '写作预设' });
    const items = catalogFrom(settings, chars, ctx);
    const presets = items.filter(i => i.type === 'preset');
    assert.deepEqual(presets.map(i => i.name), settings.openai_setting_names);
    assert.ok(presets.every(i => i.apiId === 'openai'));
    assert.equal(presets.filter(i => i.name === '写作预设').length, 1);
    for (const name of ['当前角色.png', '当前主题', '当前预设', '晨雾之城']) assert.ok(items.find(i => i.name === name).locked);
});
test('137 mixed presets produce only the two Chat Completion items in the visible catalog', async () => {
    const { api, settings } = fixture();
    settings.instruct = Array.from({ length: 135 }, (_, i) => ({ name: `默认指令模板 ${i}` }));
    const items = (await api.list()).filter(item => item.type === 'preset');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.name), settings.openai_setting_names);
});
test('Backup transaction failure prevents deletion for that item and processing continues', async () => {
    const { api, chars } = fixture();
    const items = (await api.list()).filter(i => i.type === 'character' && !i.locked);
    const store = new MemoryStore();
    const put = store.put.bind(store);
    store.put = record => record.item.name === '旅行者.v2.png' ? Promise.reject(new Error('quota exceeded')) : put(record);
    const result = await runBatch(items, { action: 'delete', api, store });
    assert.equal(result.failed.length, 1); assert.equal(result.succeeded.length, 1);
    assert.ok(chars.some(c => c.avatar === '旅行者.v2.png'));
    assert.ok(!chars.some(c => c.avatar === '归档角色.png'));
});
test('Delete requires committed backup before mutation; chats are retained; original dotted filename is restored', async () => {
    const { api, chars, calls } = fixture();
    const item = (await api.list()).find(i => i.name === '旅行者.v2.png');
    const store = new MemoryStore();
    const remove = api.remove.bind(api);
    api.remove = async (...args) => { assert.equal((await store.list()).length, 1); await remove(...args); };
    const result = await runBatch([item], { action: 'delete', api, store });
    assert.equal(result.succeeded.length, 1);
    assert.equal(calls.find(c => c.path === '/api/characters/delete').body.delete_chats, false);
    const [record] = await store.list();
    const restored = await runBatch([record], { action: 'restore', api, store });
    assert.equal(restored.succeeded.length, 1);
    assert.equal(calls.find(c => c.path === '/api/characters/import').body.get('preserved_name'), '旅行者.v2.png');
    const char = chars.find(c => c.avatar === item.name);
    assert.equal(char.fav, true); assert.equal(char.chat, 'journey');
});
test('Current resources and generation are checked at mutation time', async () => {
    const { api, ctx } = fixture();
    const item = (await api.list()).find(i => i.name === '旧主题');
    ctx.powerUserSettings.theme = item.name;
    const result = await runBatch([item], { action: 'delete', api, store: new MemoryStore() });
    assert.equal(result.succeeded.length, 0); assert.match(result.failed[0].message, /当前主题/);
    ctx.powerUserSettings.theme = '当前主题'; ctx.isGenerating = true;
    await assert.rejects(() => api.assertDeletable(item), /生成回复/);
});
test('Restore collisions do not write or overwrite any resource', async () => {
    const { api, calls } = fixture();
    const item = (await api.list()).find(i => i.name === '旧主题');
    const record = await api.backup(item);
    calls.length = 0;
    await assert.rejects(() => api.restore(record), /同名资料/);
    assert.equal(calls.some(c => c.path.endsWith('/save')), false);
});
test('Failed HTTP deletion keeps a recoverable backup with an explicit uncertain status', async () => {
    const { api, failures, settings } = fixture();
    const item = (await api.list()).find(i => i.name === '旧主题');
    failures.set('/api/themes/delete', 500);
    const store = new MemoryStore();
    const result = await runBatch([item], { action: 'delete', api, store });
    assert.equal(result.failed.length, 1); assert.equal(result.succeeded.length, 0);
    assert.equal((await store.list())[0].status, 'check');
    assert.ok(settings.themes.some(t => t.name === '旧主题'));
});
test('Theme, world and presets round-trip through real endpoint request shapes', async () => {
    const { api } = fixture();
    const items = (await api.list()).filter(i => ['旧主题', '旧世界书', '写作预设'].includes(i.name));
    const store = new MemoryStore();
    const result = await runBatch(items, { action: 'delete', api, store });
    assert.equal(result.succeeded.length, 3);
    const restored = await runBatch(await store.list(), { action: 'restore', api, store });
    assert.equal(restored.succeeded.length, 3);
});
test('Selecting every visible preset cannot delete an instruction template or other backend preset', async () => {
    const { api, settings, calls } = fixture();
    settings.instruct.push({ name: '写作预设', input_sequence: 'keep this' });
    settings.textgenerationwebui_preset_names = ['写作预设'];
    settings.textgenerationwebui_presets = [JSON.stringify({ temperature: 1.2 })];
    const before = structuredClone({ instruct: settings.instruct, text: settings.textgenerationwebui_presets });
    const selected = (await api.list()).filter(item => item.type === 'preset' && !item.locked);
    const result = await runBatch(selected, { action: 'delete', api, store: new MemoryStore() });
    assert.equal(result.succeeded.length, 1);
    assert.deepEqual(settings.instruct, before.instruct);
    assert.deepEqual(settings.textgenerationwebui_presets, before.text);
    const deletions = calls.filter(call => call.path === '/api/presets/delete');
    assert.deepEqual(deletions.map(call => call.body), [{ name: '写作预设', apiId: 'openai' }]);
});
test('Old template backups remain restorable and still refuse same-name collisions after upgrade', async () => {
    const { api, settings, calls } = fixture();
    const item = makeItem('preset', '指令模板 A', { apiId: 'instruct' });
    const record = await api.backup(item);
    const [imported] = parseBundle(JSON.stringify(createBundle([record])));
    await assert.rejects(() => api.restore(imported), /同名资料/);
    assert.equal(calls.some(call => call.path === '/api/presets/save'), false);
    settings.instruct = [];
    await api.restore(imported);
    assert.deepEqual(settings.instruct, [{ name: '指令模板 A', input_sequence: 'USER:' }]);
    assert.ok(!(await api.list()).some(row => row.apiId === 'instruct'));
});
test('Changed contents after the committed backup are never deleted', async () => {
    const { api, settings, calls } = fixture();
    const item = (await api.list()).find(i => i.name === '旧主题');
    const record = await api.backup(item);
    settings.themes.find(t => t.name === '旧主题').custom_css = 'new edit';
    await assert.rejects(() => api.remove(item, record), /发生了变化/);
    assert.equal(calls.some(c => c.path.endsWith('/delete')), false);
});
test('Global and embedded regexes delete exactly one script without changing unrelated fields', async () => {
    const { api, chars, settings, ctx } = fixture();
    const { items } = await api.scanRegex();
    const selected = items.filter(i => ['g1', 'c1', 'p1'].includes(i.name));
    const store = new MemoryStore();
    const result = await runBatch(selected, { action: 'delete', api, store });
    assert.equal(result.succeeded.length, 3, JSON.stringify(result.failed));
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), ['g2']);
    assert.equal(chars[1].data.extensions.fav, true);
    assert.equal(JSON.parse(settings.openai_settings[1]).temperature, .7);
    const restored = await runBatch(await store.list(), { action: 'restore', api, store });
    assert.equal(restored.succeeded.length, 3, JSON.stringify(restored.failed));
});
test('Silent global settings save failures are not reported as successful deletion', async () => {
    const { api, ctx } = fixture();
    const before = structuredClone(ctx.extensionSettings.regex);
    api.saveSettings = async () => {};
    const item = (await api.list()).find(i => i.name === 'g1');
    const store = new MemoryStore();
    const result = await runBatch([item], { action: 'delete', api, store });
    assert.equal(result.failed.length, 1); assert.equal(result.succeeded.length, 0);
    assert.ok(same(ctx.extensionSettings.regex, before)); assert.equal((await store.list()).length, 1);
});
test('Backup bundle rejects unknown formats, path traversal and prototype injection', () => {
    assert.throws(() => parseBundle('{}'), /不是本插件/);
    const item = makeItem('world', '../../settings');
    assert.throws(() => parseBundle(JSON.stringify(createBundle([{ item, payload: { entries: {} } }]))), /文件名/);
    assert.throws(() => parseBundle('{"__proto__":{}}'), /对象字段/);
    assert.throws(() => parseBundle(JSON.stringify(createBundle([{ item: makeItem('server', 'x'), payload: {} }]))), /类型/);
});
test('Legacy regexes without ids survive backup validation', async () => {
    const { api, ctx, setSaved } = fixture();
    const legacy = script(undefined, '旧正则'); delete legacy.id;
    ctx.extensionSettings.regex = [legacy]; setSaved({ extension_settings: { regex: [legacy] } });
    const item = (await api.list()).find(i => i.type === 'regex');
    const record = await api.backup(item);
    assert.equal(parseBundle(JSON.stringify(createBundle([record]))).length, 1);
});
test('Duplicate regex ids refuse ambiguous deletion', async () => {
    const { api, ctx, setSaved } = fixture();
    ctx.extensionSettings.regex = [script('dup'), script('dup')];
    setSaved({ extension_settings: cloneScripts(ctx.extensionSettings.regex) });
    const item = regexItems(ctx.extensionSettings.regex, { kind: 'global' }, '全局')[0];
    await assert.rejects(() => api.backup(item), /重复标识/);
});
const cloneScripts = regex => ({ regex: structuredClone(regex) });
test('Stopping retains completed records and avoids starting the next deletion', async () => {
    const { api } = fixture();
    const items = (await api.list()).filter(i => i.type === 'theme' || i.type === 'world').filter(i => !i.locked);
    let stopped = false;
    const result = await runBatch(items, { action: 'delete', api, store: new MemoryStore(), stopped: () => stopped, onProgress: () => { stopped = true; } });
    assert.equal(result.succeeded.length, 1); assert.equal(result.stopped, true);
});
test('Restoring regexes sorts by original index, independent of UI alphabetical sorting', async () => {
    const { api, ctx, setSaved } = fixture();
    ctx.extensionSettings.regex = [script('a', 'Z'), script('b', 'A'), script('c', 'C')];
    setSaved({ extension_settings: { regex: structuredClone(ctx.extensionSettings.regex) } });
    const items = (await api.list()).filter(i => ['a', 'b'].includes(i.name));
    const store = new MemoryStore();
    await runBatch(items, { action: 'delete', api, store });
    const records = (await store.list()).reverse();
    const result = await runBatch(restoreOrder(records), { action: 'restore', api, store });
    assert.equal(result.succeeded.length, 2);
    assert.deepEqual(ctx.extensionSettings.regex.map(s => s.id), ['a', 'b', 'c']);
});
