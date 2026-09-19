import { catalogFrom, regexItems, regexLock, makeItem, clone, same, safeName, findScript, validateRecord } from './core.js';

export class TavernApi {
    constructor({ context, headers, saveSettings, account, fetcher = globalThis.fetch.bind(globalThis) }) {
        Object.assign(this, { context, headers, saveSettings, account, fetcher });
        this.pins = new Set();
    }
    async request(path, body = {}, { blob = false, form = false } = {}) {
        const response = await this.fetcher(path, {
            method: 'POST', headers: this.headers({ omitContentType: form }),
            body: form ? body : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`酒馆接口失败 (${response.status})：${path}`);
        if (response.redirected || response.headers.get('content-type')?.includes('text/html')) throw new Error('登录已失效或接口不存在，请重新登录酒馆');
        if (blob) {
            const result = await response.blob();
            const signature = new Uint8Array(await result.slice(0, 8).arrayBuffer());
            if (signature.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('角色卡导出未返回有效的 PNG，已禁止删除');
            return result;
        }
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch { return text; }
        if (result?.error) throw new Error(`酒馆返回错误：${path}`);
        return result;
    }
    async settings() {
        const settings = await this.request('/api/settings/get');
        if (!Array.isArray(settings?.world_names) || !Array.isArray(settings?.themes)) throw new Error('酒馆资料接口格式不兼容');
        return settings;
    }
    async characters() {
        const data = await this.request('/api/characters/all');
        if (!Array.isArray(data)) throw new Error('角色列表格式不兼容');
        return data;
    }
    async list(options = {}) {
        const [settings, characters] = await Promise.all([this.settings(), this.characters()]);
        const context = this.context();
        const list = catalogFrom(settings, characters, context, options);
        for (const item of list) if (this.pins.has(item.key)) item.locked = item.locked || '手动保护';
        return list;
    }
    async scanRegex(progress = () => {}, stopped = () => false) {
        const [settings, characters] = await Promise.all([this.settings(), this.characters()]);
        const items = regexItems(this.context().extensionSettings?.regex || [], { kind: 'global' }, '全局');
        const failures = [];
        for (let i = 0; i < characters.length; i++) {
            if (stopped()) break;
            const char = characters[i];
            try {
                const data = await this.request('/api/characters/get', { avatar_url: char.avatar });
                items.push(...regexItems(data.data?.extensions?.regex_scripts || [], { kind: 'character', name: char.avatar }, `角色：${char.name}`));
            } catch (error) { failures.push(`${char.name}：${error.message}`); }
            progress(i + 1, characters.length);
        }
        for (const item of catalogFrom(settings, [], this.context(), { includeOtherPresets: true }).filter(i => i.type === 'preset')) {
            const scripts = item.payload.extensions?.regex_scripts;
            if (scripts) items.push(...regexItems(scripts, { kind: 'preset', name: item.name, apiId: item.apiId }, `${item.detail}：${item.name}`));
        }
        for (const item of items) item.locked = regexLock(item, this.context(), this.pins);
        return { items, failures };
    }
    async assertDeletable(item) {
        if (this.pins.has(item.key)) throw new Error('此资料已手动保护');
        if (this.context().isGenerating) throw new Error('酒馆正在生成回复，请结束后重试');
        if (item.type === 'regex') {
            const locked = regexLock(item, this.context(), this.pins);
            if (locked) throw new Error(`${locked}，请先切换角色或预设，或取消保护`);
            await this.readRegex(item); return;
        }
        const current = (await this.list()).find(row => row.key === item.key);
        if (!current) throw new Error('资料已经不存在，请刷新列表');
        if (current.locked) throw new Error(`${current.locked}，暂时不能删除`);
        safeName(item.name);
    }
    async fresh(item) {
        if (item.type === 'character') return this.request('/api/characters/get', { avatar_url: safeName(item.name) });
        if (item.type === 'world') {
            const settings = await this.settings();
            if (!settings.world_names.includes(item.name)) throw new Error('世界书已不存在');
            const data = await this.request('/api/worldinfo/get', { name: safeName(item.name) });
            if (!data?.entries || typeof data.entries !== 'object') throw new Error('世界书格式错误');
            return data;
        }
        if (item.type === 'regex') {
            const { scripts } = await this.readRegex(item);
            return clone(scripts[findScript(scripts, item)]);
        }
        const settings = await this.settings();
        const row = catalogFrom(settings, [], this.context(), { includeOtherPresets: true }).find(row => row.key === item.key);
        if (!row) throw new Error('资料已不存在');
        return clone(row.payload);
    }
    async backup(item) {
        const fresh = await this.fresh(item);
        let payload = fresh;
        if (item.type === 'character') {
            const blob = await this.request('/api/characters/export', { avatar_url: item.name, format: 'png' }, { blob: true });
            payload = await blobDataUrl(blob);
        }
        const record = {
            id: randomId(), createdAt: new Date().toISOString(), status: 'prepared',
            item: clone(item), payload,
        };
        // Character export intentionally strips these local fields. Keep them separately for restoration.
        if (item.type === 'character') record.local = { fav: fresh.fav ?? false, chat: fresh.chat, extensionFav: fresh.data?.extensions?.fav ?? false };
        record.fingerprint = clone(fresh);
        validateRecord(record);
        return record;
    }
    async remove(item, record) {
        const current = await this.fresh(item);
        if (!same(current, record.fingerprint)) throw new Error('备份后资料发生了变化，已停止删除，请重新选择');
        if (item.type === 'character') await this.request('/api/characters/delete', { avatar_url: item.name, delete_chats: false });
        else if (item.type === 'world') await this.request('/api/worldinfo/delete', { name: item.name });
        else if (item.type === 'preset') await this.request('/api/presets/delete', { name: item.name, apiId: item.apiId });
        else if (item.type === 'theme') await this.request('/api/themes/delete', { name: item.name });
        else if (item.type === 'regex') {
            const source = await this.readRegex(item);
            source.scripts.splice(findScript(source.scripts, item), 1);
            await this.writeRegex(item.owner, source);
        } else throw new Error('类型不受支持');
        await this.verifyAbsent(item);
    }
    async readRegex(item) {
        const owner = item.owner;
        if (owner?.kind === 'global') {
            const scripts = clone(this.context().extensionSettings.regex || []);
            const settings = await this.settings();
            const saved = typeof settings.settings === 'string' ? JSON.parse(settings.settings) : settings.settings;
            if (!same(saved?.extension_settings?.regex || [], scripts)) throw new Error('全局正则尚未保存或已被其他页面修改，请刷新酒馆再操作');
            return { scripts };
        }
        if (owner?.kind === 'character') {
            const data = await this.request('/api/characters/get', { avatar_url: safeName(owner.name) });
            return { scripts: clone(data.data?.extensions?.regex_scripts || []) };
        }
        if (owner?.kind === 'preset') {
            const item = makeItem('preset', safeName(owner.name), { apiId: owner.apiId });
            const preset = await this.fresh(item);
            return { scripts: clone(preset.extensions?.regex_scripts || []), preset };
        }
        throw new Error('正则所属资料不受支持');
    }
    async writeRegex(owner, source) {
        if (!Array.isArray(source.scripts)) throw new Error('正则格式不正确');
        if (owner.kind === 'global') {
            const context = this.context();
            const old = clone(context.extensionSettings.regex || []);
            context.extensionSettings.regex = clone(source.scripts);
            try {
                await this.saveSettings();
                const settings = await this.settings();
                const saved = typeof settings.settings === 'string' ? JSON.parse(settings.settings) : settings.settings;
                if (!same(saved?.extension_settings?.regex || [], source.scripts)) throw new Error('全局正则保存未确认，请刷新后检查');
            } catch (error) { context.extensionSettings.regex = old; throw error; }
        } else if (owner.kind === 'character') {
            await this.request('/api/characters/merge-attributes', { avatar: safeName(owner.name), data: { extensions: { regex_scripts: source.scripts } } });
        } else if (owner.kind === 'preset') {
            const preset = clone(source.preset);
            preset.extensions ||= {};
            preset.extensions.regex_scripts = source.scripts;
            await this.request('/api/presets/save', { apiId: owner.apiId, name: safeName(owner.name), preset });
        } else throw new Error('正则所属资料不受支持');
    }
    async verifyAbsent(item) {
        if (item.type === 'regex') {
            const { scripts } = await this.readRegex(item);
            if (scripts.some(s => item.payload.id ? s.id === item.payload.id : same(s, item.payload))) throw new Error('删除未确认：正则仍存在');
        } else {
            if ((await this.list({ includeOtherPresets: true })).some(row => row.key === item.key)) throw new Error('删除未确认：资料仍存在');
        }
    }
    async restore(record) {
        validateRecord(record);
        const { item, payload } = record;
        if (this.context().isGenerating) throw new Error('请在回复生成完成后恢复资料');
        if (item.type === 'regex') {
            const locked = regexLock(item, this.context(), this.pins);
            if (locked) throw new Error(`${locked}，请先切换角色或预设，或取消保护`);
            const source = await this.readRegex(item);
            if (source.scripts.some(s => payload.id ? s.id === payload.id : same(s, payload))) throw new Error('正则标识已存在，已跳过恢复');
            const index = Number.isInteger(item.index) && item.index >= 0 ? Math.min(item.index, source.scripts.length) : source.scripts.length;
            source.scripts.splice(index, 0, clone(payload));
            await this.writeRegex(item.owner, source);
            const after = await this.readRegex(item);
            if (!after.scripts.some(script => same(script, payload))) throw new Error('正则恢复未确认');
            return;
        }
        // Case-insensitive collision check also protects installations hosted on Windows.
        const existing = await this.list({ includeOtherPresets: true });
        if (existing.some(row => row.type === item.type && row.apiId === item.apiId && row.name.toLocaleLowerCase() === item.name.toLocaleLowerCase())) throw new Error('同名资料已存在，已跳过恢复，未覆盖');
        if (item.type === 'character') {
            const form = new FormData();
            form.append('avatar', dataUrlBlob(payload), item.name);
            form.append('file_type', 'png');
            form.append('preserved_name', item.name);
            const response = await this.request('/api/characters/import', form, { form: true });
            if (`${response?.file_name}.png` !== item.name) throw new Error('角色卡导入文件名与备份不同，请刷新后检查');
            if (record.local) {
                const fields = { avatar: item.name, fav: Boolean(record.local.fav), data: { extensions: { fav: Boolean(record.local.extensionFav) } } };
                if (typeof record.local.chat === 'string') fields.chat = record.local.chat;
                await this.request('/api/characters/merge-attributes', fields);
            }
        } else if (item.type === 'world') await this.request('/api/worldinfo/edit', { name: item.name, data: payload });
        else if (item.type === 'preset') await this.request('/api/presets/save', { name: item.name, apiId: item.apiId, preset: payload });
        else if (item.type === 'theme') await this.request('/api/themes/save', payload);
        const restored = await this.fresh(item);
        if (item.type !== 'character' && !same(restored, payload)) throw new Error('恢复内容与备份不同，请刷新后检查');
    }
}

export function randomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
async function blobDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return 'data:image/png;base64,' + btoa(text);
}
function dataUrlBlob(value) {
    const text = atob(value.split(',')[1]);
    return new Blob([Uint8Array.from(text, char => char.charCodeAt(0))], { type: 'image/png' });
}
