import { clone, PRESETS } from '../core.js';
import { TavernApi } from '../api.js';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YkAAAAASUVORK5CYII=';
export const script = (id, label = id) => ({ id, scriptName: label, findRegex: '/test/g', replaceString: 'word', placement: [2], disabled: false });
export function fixture() {
    const settings = {
        world_names: ['晨雾之城', '旧世界书'], themes: [{ name: '当前主题', blur: 10 }, { name: '旧主题', custom_css: 'body { color: red; }' }],
        openai_setting_names: ['当前预设', '写作预设'],
        openai_settings: [JSON.stringify({ temperature: 1, extensions: {} }), JSON.stringify({ temperature: .7, extensions: { regex_scripts: [script('p1', '预设正则')] } })],
        instruct: [{ name: '指令模板 A', input_sequence: 'USER:' }], context: [], sysprompt: [], reasoning: [],
        textgenerationwebui_presets: [], textgenerationwebui_preset_names: [], novelai_settings: [], novelai_setting_names: [], koboldai_settings: [], koboldai_setting_names: [],
    };
    const chars = [
        { name: '当前角色', avatar: '当前角色.png', fav: true, chat: 'current-chat', data: { extensions: { regex_scripts: [], world: '晨雾之城' } } },
        { name: '旅行者', avatar: '旅行者.v2.png', fav: true, chat: 'journey', data: { extensions: { fav: true, regex_scripts: [script('c1', '角色正则')] } } },
        { name: '归档角色', avatar: '归档角色.png', data: { extensions: {} } },
    ];
    const worlds = { 晨雾之城: { entries: { 0: { content: '晨雾从河面升起' } } }, 旧世界书: { entries: { 0: { content: 'archive' } } } };
    const ctx = {
        characters: clone(chars), characterId: 0, groups: [], chatMetadata: {}, extensionSettings: { regex: [script('g1', '格式清理'), script('g2', '台词修正')] },
        powerUserSettings: { theme: '当前主题' }, selectedPresets: { openai: '当前预设' }, activeWorlds: ['晨雾之城'], isGenerating: false,
    };
    let saved = { extension_settings: clone(ctx.extensionSettings) };
    const calls = [];
    const failures = new Map();
    function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
    const fetcher = async (path, init) => {
        const body = init.body instanceof FormData ? init.body : JSON.parse(init.body);
        calls.push({ path, body, headers: init.headers });
        if (failures.has(path)) return json({ error: true }, failures.get(path));
        if (path === '/api/settings/get') return json({ ...settings, settings: JSON.stringify(saved) });
        if (path === '/api/characters/all') return json(chars);
        if (path === '/api/characters/get') return chars.some(c => c.avatar === body.avatar_url) ? json(chars.find(c => c.avatar === body.avatar_url)) : json({}, 404);
        if (path === '/api/characters/export') return new Response(Uint8Array.from(atob(PNG), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
        if (path === '/api/characters/delete') { chars.splice(chars.findIndex(c => c.avatar === body.avatar_url), 1); return json({ ok: true }); }
        if (path === '/api/characters/import') {
            const name = body.get('preserved_name').replace(/\.png$/, '');
            chars.push({ name, avatar: name + '.png', data: { extensions: {} } });
            return json({ file_name: name });
        }
        if (path === '/api/characters/merge-attributes') {
            const char = chars.find(c => c.avatar === body.avatar);
            if (body.data?.extensions) Object.assign(char.data.extensions, clone(body.data.extensions));
            if ('fav' in body) char.fav = body.fav;
            if ('chat' in body) char.chat = body.chat;
            return json({ ok: true });
        }
        if (path === '/api/worldinfo/get') return json(worlds[body.name] || { entries: {} });
        if (path === '/api/worldinfo/delete') { delete worlds[body.name]; settings.world_names.splice(settings.world_names.indexOf(body.name), 1); return json({ ok: true }); }
        if (path === '/api/worldinfo/edit') { worlds[body.name] = clone(body.data); settings.world_names.push(body.name); return json({ ok: true }); }
        if (path === '/api/themes/delete') { settings.themes.splice(settings.themes.findIndex(t => t.name === body.name), 1); return json({ ok: true }); }
        if (path === '/api/themes/save') { settings.themes.push(clone(body)); return json({ ok: true }); }
        if (['/api/presets/delete', '/api/presets/save'].includes(path)) {
            const [, , field, namesField] = PRESETS.find(p => p[0] === body.apiId);
            const names = namesField ? settings[namesField] : settings[field].map(p => p.name);
            const index = names.indexOf(body.name);
            if (path.endsWith('/delete')) {
                settings[field].splice(index, 1);
                if (namesField) names.splice(index, 1);
            } else if (index >= 0) settings[field][index] = namesField ? JSON.stringify(body.preset) : clone(body.preset);
            else { settings[field].push(namesField ? JSON.stringify(body.preset) : clone(body.preset)); if (namesField) names.push(body.name); }
            return json({ name: body.name });
        }
        throw new Error('Unexpected endpoint: ' + path);
    };
    const api = new TavernApi({ context: () => ctx, headers: ({ omitContentType } = {}) => omitContentType ? { 'X-CSRF-Token': 'test' } : { 'X-CSRF-Token': 'test', 'Content-Type': 'application/json' }, saveSettings: async () => { saved = { extension_settings: clone(ctx.extensionSettings) }; }, account: 'test-user', fetcher });
    return { api, settings, chars, ctx, calls, failures, worlds, setSaved: value => { saved = value; } };
}
export class MemoryStore {
    rows = new Map();
    async put(record) { this.rows.set(record.id, clone(record)); }
    async list() { return [...this.rows.values()].map(clone); }
}
