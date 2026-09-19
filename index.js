import { getContext } from '../../../extensions.js';
import { getRequestHeaders, saveSettings, isGenerating } from '../../../../script.js';
import { getPresetManager } from '../../../preset-manager.js';
import { getCurrentUserHandle } from '../../../user.js';
import { selected_world_info, world_info } from '../../../world-info.js';
import { PRESETS } from './core.js';
import { TavernApi } from './api.js';
import { BackupStore } from './storage.js';
import { LibraryUI } from './ui.js';

let ui;
function context() {
    const current = getContext();
    const selectedPresets = {};
    for (const [apiId] of PRESETS) {
        const manager = getPresetManager(apiId);
        if (manager) selectedPresets[apiId] = manager.getSelectedPresetName();
    }
    return { ...current, selectedPresets, activeWorlds: selected_world_info, worldInfo: world_info, isGenerating: isGenerating() };
}
async function open() {
    try {
        if (!ui) {
            const account = getCurrentUserHandle();
            const api = new TavernApi({ context, headers: getRequestHeaders, saveSettings, account });
            const store = new BackupStore(account);
            let storageError = '';
            try { await store.open(); } catch (error) { storageError = error.message; }
            ui = new LibraryUI({ api, store, storageError });
        }
        await ui.open();
    } catch (error) {
        console.error('[酒馆资料管家]', error);
        globalThis.toastr?.error(error.message, '资料管家打开失败');
    }
}
function mount() {
    if (document.getElementById('stlm-open')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const block = document.createElement('div');
    block.className = 'stlm-entry';
    const button = document.createElement('button');
    button.id = 'stlm-open';
    button.className = 'menu_button';
    button.type = 'button';
    button.textContent = '▦ 打开资料管家';
    button.addEventListener('click', open);
    const hint = document.createElement('small');
    hint.textContent = '批量管理角色卡、世界书、预设、主题和正则';
    block.append(button, hint);
    host.append(block);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
const ctx = getContext();
if (ctx.eventTypes?.APP_READY) ctx.eventSource.once(ctx.eventTypes.APP_READY, mount);
