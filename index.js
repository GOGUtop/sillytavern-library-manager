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
    if (document.getElementById('stlm-settings')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const block = document.createElement('div');
    block.id = 'stlm-settings';
    block.className = 'extension_container stlm-entry';
    // Tavern owns the click animation and icon state for inline-drawer-toggle.
    // Reuse its markup so the entry inherits the user's theme and row sizing.
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false" aria-controls="stlm-entry-content">
                <b>资料管家</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
            </div>
            <div class="inline-drawer-content" id="stlm-entry-content" style="display: none;"></div>
        </div>`;
    const header = block.querySelector('.inline-drawer-header');
    const icon = block.querySelector('.inline-drawer-icon');
    const content = block.querySelector('.inline-drawer-content');
    header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            header.click();
        }
    });
    new MutationObserver(() => header.setAttribute('aria-expanded', String(icon.classList.contains('up'))))
        .observe(icon, { attributes: true, attributeFilter: ['class'] });
    const button = document.createElement('button');
    button.id = 'stlm-open';
    button.className = 'menu_button';
    button.type = 'button';
    button.innerHTML = '<i class="fa-solid fa-table-cells" aria-hidden="true"></i><span>打开资料管家</span>';
    button.addEventListener('click', open);
    const hint = document.createElement('p');
    hint.className = 'stlm-entry-description';
    hint.textContent = '批量管理角色卡、世界书、预设、主题和正则';
    content.append(hint, button);
    host.append(block);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
const ctx = getContext();
if (ctx.eventTypes?.APP_READY) ctx.eventSource.once(ctx.eventTypes.APP_READY, mount);
