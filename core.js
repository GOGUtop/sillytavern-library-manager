export const FORMAT = 'sillytavern-library-manager';
export const VERSION = 1;
export const CATEGORIES = {
    character: '角色卡', world: '世界书', preset: '预设', theme: '主题 UI', regex: '正则',
};
export const PRESETS = [
    ['openai', '聊天补全', 'openai_settings', 'openai_setting_names'],
    ['textgenerationwebui', '文本补全', 'textgenerationwebui_presets', 'textgenerationwebui_preset_names'],
    ['novel', 'NovelAI', 'novelai_settings', 'novelai_setting_names'],
    ['kobold', 'KoboldAI', 'koboldai_settings', 'koboldai_setting_names'],
    ['instruct', '指令模板', 'instruct'], ['context', '上下文模板', 'context'],
    ['sysprompt', '系统提示词', 'sysprompt'], ['reasoning', '推理模板', 'reasoning'],
];
export const clone = value => structuredClone(value);
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const same = (a, b) => canonical(a) === canonical(b);
export const keyOf = item => JSON.stringify([item.type, item.apiId || '', item.owner || null, item.name]);
export function safeName(name) {
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\x00-\x1f\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)) {
        throw new Error('文件名不受支持，已阻止操作');
    }
    return name;
}
export function objectFrom(value) {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('资料格式不正确');
    return result;
}
export function makeItem(type, name, data = {}) {
    const item = { type, name, label: name, ...data };
    item.key = keyOf(item);
    return item;
}
export function catalogFrom(settings, characters, context) {
    const list = [];
    const current = context.characters?.[context.characterId]?.avatar;
    const groupMembers = new Set((context.groups || []).flatMap(g => g.members || []));
    for (const char of characters) {
        list.push(makeItem('character', char.avatar, {
            label: char.name || char.avatar, detail: char.avatar, avatar: char.avatar,
            locked: char.avatar === current ? '当前角色' : groupMembers.has(char.avatar) ? '群聊成员' : '',
        }));
    }
    const power = context.powerUserSettings || {};
    const globalWorlds = context.activeWorlds || [];
    const boundWorlds = new Set([
        ...globalWorlds, context.chatMetadata?.world_info, power.persona_description_lorebook,
        ...characters.map(c => c.data?.extensions?.world),
        ...(context.worldInfo?.charLore || []).flatMap(c => c.extraBooks || []),
    ].filter(Boolean));
    for (const name of settings.world_names || []) {
        list.push(makeItem('world', name, { detail: '世界书文件', locked: boundWorlds.has(name) ? '已知的世界书绑定' : '' }));
    }
    for (const [apiId, title, field, namesField] of PRESETS) {
        const data = settings[field] || [];
        if (!Array.isArray(data)) throw new Error(`${title}列表格式不兼容`);
        const names = namesField ? settings[namesField] : data.map(p => p.name);
        if (!Array.isArray(names)) throw new Error(`${title}名称列表格式不兼容`);
        data.forEach((value, i) => {
            if (!names[i]) return;
            const name = names[i];
            const payload = objectFrom(value);
            list.push(makeItem('preset', name, {
                apiId, detail: title, payload,
                locked: context.selectedPresets?.[apiId] === name ? '当前选择的预设' : '',
            }));
        });
    }
    for (const theme of settings.themes || []) {
        if (theme.name) list.push(makeItem('theme', theme.name, { payload: theme, detail: '酒馆主题 · 含自定义 CSS', locked: power.theme === theme.name ? '当前主题' : '' }));
    }
    list.push(...regexItems(context.extensionSettings?.regex || [], { kind: 'global' }, '全局'));
    return list;
}
export function regexItems(scripts, owner, title) {
    if (!Array.isArray(scripts)) throw new Error('正则数组格式不正确');
    return scripts.map((script, index) => makeItem('regex', script.id || `@index:${index}`, {
        label: script.scriptName || `未命名正则 ${index + 1}`, detail: `${title} · ${script.disabled ? '已停用' : '已启用'}`,
        owner, payload: clone(script), index,
    }));
}
export function regexLock(item, context, pins = new Set()) {
    if (pins.has(item.key)) return '手动保护';
    const owner = item.owner;
    if (owner.kind === 'character') {
        if (context.characters?.[context.characterId]?.avatar === owner.name) return '属于当前角色';
        if ((context.groups || []).some(group => group.members?.includes(owner.name))) return '属于群聊成员';
        if (pins.has(keyOf(makeItem('character', owner.name)))) return '所属角色已保护';
    }
    if (owner.kind === 'preset') {
        if (context.selectedPresets?.[owner.apiId] === owner.name) return '属于当前预设';
        if (pins.has(keyOf(makeItem('preset', owner.name, { apiId: owner.apiId })))) return '所属预设已保护';
    }
    return '';
}
export function restoreOrder(records) {
    return [...records].sort((a, b) => {
        if (a.item.type === 'regex' && b.item.type !== 'regex') return 1;
        if (a.item.type !== 'regex' && b.item.type === 'regex') return -1;
        if (a.item.type !== 'regex') return 0;
        const owner = JSON.stringify(a.item.owner).localeCompare(JSON.stringify(b.item.owner));
        return owner || (a.item.index ?? 0) - (b.item.index ?? 0);
    });
}
export function findScript(scripts, item) {
    const matches = scripts.map((script, index) => ({ script, index })).filter(({ script }) =>
        item.payload.id ? script.id === item.payload.id : same(script, item.payload));
    if (matches.length !== 1 || !same(matches[0].script, item.payload)) {
        throw new Error('正则已变化、缺失或存在重复标识，请刷新后重新选择');
    }
    return matches[0].index;
}
export function validateRecord(record) {
    if (!record || !record.item || !Object.hasOwn(CATEGORIES, record.item.type)) throw new Error('备份类型不受支持');
    const { item, payload } = record;
    if (item.key !== keyOf(item)) throw new Error('备份资料标识与内容不匹配');
    if (item.type !== 'regex') safeName(item.name);
    else if (typeof item.name !== 'string' || !item.name) throw new Error('正则标识不正确');
    if (typeof item.label !== 'string') throw new Error('备份名称不正确');
    if (item.type === 'preset' && !PRESETS.some(p => p[0] === item.apiId)) throw new Error('预设类型不受支持');
    if (item.type === 'character') {
        if (!item.name.endsWith('.png') || typeof payload !== 'string' || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=\r\n]*$/.test(payload)) throw new Error('角色卡备份不是 PNG');
    } else {
        objectFrom(payload);
    }
    if (item.type === 'world' && (!payload.entries || typeof payload.entries !== 'object')) throw new Error('世界书备份缺少 entries');
    if (item.type === 'theme' && payload.name !== item.name) throw new Error('主题名称不匹配');
    if (item.type === 'regex') {
        if (!['global', 'character', 'preset'].includes(item.owner?.kind) || typeof payload.scriptName !== 'string' || typeof payload.findRegex !== 'string') throw new Error('正则备份格式不正确');
        if (item.owner.kind !== 'global') safeName(item.owner.name);
        if (item.owner.kind === 'character' && !item.owner.name.endsWith('.png')) throw new Error('角色文件名不正确');
        if (item.owner.kind === 'preset' && !PRESETS.some(p => p[0] === item.owner.apiId)) throw new Error('正则所属预设不正确');
        if (!same(item.payload, payload)) throw new Error('正则内容不匹配');
    }
    return record;
}
export function parseBundle(text) {
    const bundle = JSON.parse(text, (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('备份含不受支持的对象字段');
        return value;
    });
    if (bundle.format !== FORMAT || bundle.version !== VERSION || !Array.isArray(bundle.records) || bundle.records.length > 10000) throw new Error('不是本插件支持的备份文件');
    return bundle.records.map(validateRecord);
}
export function createBundle(records) {
    return { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), records };
}
/** A committed local backup is a hard prerequisite for every remote deletion. */
export async function runBatch(items, { action, api, store, onProgress = () => {}, stopped = () => false }) {
    const result = { succeeded: [], failed: [], stopped: false };
    for (const item of items) {
        if (stopped()) { result.stopped = true; break; }
        let record;
        let mutationStarted = false;
        try {
            if (action === 'delete') {
                await api.assertDeletable(item);
                record = await api.backup(item);
                await store.put(record);
                // Recheck immediately before mutation, after the backup transaction commits.
                await api.assertDeletable(item);
                mutationStarted = true;
                await api.remove(item, record);
                record.status = 'deleted';
                await store.put(record);
            } else if (action === 'restore') {
                validateRecord(item);
                mutationStarted = true;
                await api.restore(item);
                record = { ...item, status: 'restored' };
                await store.put(record);
            } else throw new Error('操作不受支持');
            result.succeeded.push(item);
        } catch (error) {
            result.failed.push({ item, message: error.message, uncertain: mutationStarted });
            if (record && action === 'delete' && mutationStarted) {
                try { await store.put({ ...record, status: 'check', error: error.message }); } catch { /* Preserve the already committed backup. */ }
            }
        }
        onProgress(result, item);
    }
    return result;
}
