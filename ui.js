import { CATEGORIES, clone, createBundle, parseBundle, runBatch, restoreOrder } from './core.js';
import { randomId } from './api.js';

const STATUS = { prepared: '备份已保存', deleted: '已删除', restored: '已恢复', check: '请核对服务器', imported: '导入的备份' };
const PAGE_SIZE = 60;
const icon = { character: '◉', world: '▤', preset: '≋', theme: '◐', regex: '.*', trash: '↺' };
function el(tag, className = '', text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}
function button(text, handler, className = '') {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}
function download(records) {
    const blob = new Blob([JSON.stringify(createBundle(records), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = `酒馆资料备份-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class LibraryUI {
    constructor({ api, store, storageError = '', reload = () => location.reload() }) {
        Object.assign(this, { api, store, storageError, reload });
        this.items = [];
        this.records = [];
        this.selected = new Set();
        this.category = 'character';
        this.busy = false;
        this.dirty = false;
        this.page = 0;
        this.scanDone = false;
        this.build();
    }
    build() {
        this.dialog = el('dialog', 'stlm');
        this.dialog.setAttribute('aria-label', '酒馆资料管家');
        this.dialog.innerHTML = `
            <header class="stlm-header"><div><span class="stlm-eyebrow">TAVERN LIBRARY · 1.0.1</span><h2>资料管家 <span>让酒馆轻一点。</span></h2></div><button type="button" class="stlm-close" aria-label="关闭资料管家">✕</button></header>
            <div class="stlm-layout"><nav class="stlm-nav" aria-label="资料分类"></nav><main class="stlm-main">
            <div class="stlm-heading"><div><h3></h3><p class="stlm-subtitle"></p></div><button type="button" data-action="refresh">↻ 刷新列表</button></div>
            <div class="stlm-storage-note"></div>
            <div class="stlm-tools"><input type="search" placeholder="搜索名称、文件名或所属资料…" aria-label="搜索资料"><select aria-label="排列顺序"><option value="asc">名称 A → Z</option><option value="desc">名称 Z → A</option></select><button type="button" data-action="scan">扫描内置正则</button><button type="button" data-action="import">导入备份</button></div>
            <div class="stlm-selectbar"><label><input type="checkbox" aria-label="全选筛选结果"> 全选筛选结果</label><button type="button" data-action="invert">反选</button><span class="stlm-selection"></span></div>
            <div class="stlm-list" role="list" aria-label="资料列表"></div>
            <div class="stlm-pagination"><button type="button" data-action="prev">上一页</button><span></span><button type="button" data-action="next">下一页</button></div>
            <div class="stlm-status" role="status" aria-live="polite">正在读取资料…</div><details class="stlm-log"><summary>操作记录</summary><pre></pre></details>
            <footer class="stlm-footer"><span class="stlm-footer-note">删除前自动保存本地副本</span><div><button type="button" data-action="stop">停止后续操作</button><button type="button" data-action="export">↓ 导出选中</button><button type="button" data-action="restore" class="stlm-primary">恢复选中</button><button type="button" data-action="delete" class="stlm-danger">删除选中</button><button type="button" data-action="discard" class="stlm-danger">清理选中副本</button></div></footer>
            </main></div>`;
        document.body.append(this.dialog);
        this.$ = selector => this.dialog.querySelector(selector);
        this.$('.stlm-close').addEventListener('click', () => this.close());
        this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
        this.dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.busy) event.preventDefault();
            event.stopPropagation();
        });
        this.$('input[type=search]').addEventListener('input', () => { this.selected.clear(); this.page = 0; this.render(); });
        this.$('select').addEventListener('change', () => { this.page = 0; this.render(); });
        this.$('.stlm-selectbar input').addEventListener('change', event => {
            this.selected.clear();
            if (event.target.checked) for (const row of this.filtered()) this.selected.add(this.rowKey(row));
            this.render();
        });
        const actions = {
            refresh: () => this.task(() => this.load()),
            scan: () => this.scan(), import: () => this.importFile(),
            invert: () => { for (const row of this.filtered()) { const key = this.rowKey(row); this.selected.has(key) ? this.selected.delete(key) : this.selected.add(key); } this.render(); },
            prev: () => { this.page--; this.render(); }, next: () => { this.page++; this.render(); },
            export: () => this.exportSelected(), delete: () => this.change('delete'), restore: () => this.change('restore'),
            discard: () => this.discard(), stop: () => { this.stopped = true; this.status('将在当前资料处理结束后停止。'); },
        };
        for (const [name, handler] of Object.entries(actions)) this.$(`[data-action=${name}]`).addEventListener('click', handler);
        this.fileInput = el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.json,application/json';
        this.fileInput.hidden = true;
        this.dialog.append(this.fileInput);
        this.fileInput.addEventListener('change', () => this.readImport());
        this.beforeUnload = event => { if (this.busy) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', this.beforeUnload);
    }
    async open() {
        if (this.dialog.open) return;
        this.previousFocus = document.activeElement;
        this.dialog.showModal();
        await this.task(() => this.load());
    }
    close() {
        if (this.busy) { this.status('操作进行中；可先停止后续操作。'); return; }
        if (this.dirty) { this.reload(); return; }
        this.dialog.close();
        this.previousFocus?.focus();
    }
    async task(work) {
        if (this.busy) return;
        this.busy = true;
        this.stopped = false;
        this.render();
        try { await work(); }
        catch (error) { this.status(error.message, true); this.log(error.message); }
        finally { this.busy = false; this.render(); }
    }
    async load() {
        this.status('正在读取资料…');
        this.selected.clear();
        this.scanDone = false;
        this.page = 0;
        if (!this.storageError) {
            this.records = await this.store.list();
            this.api.pins = await this.store.pins();
        }
        this.items = await this.api.list();
        this.status(`已读取 ${this.items.length} 项资料。正则页可另行扫描卡片和预设里的内置正则。`);
    }
    rowKey(row) { return this.category === 'trash' ? row.id : row.key; }
    filtered() {
        const query = this.$('input[type=search]').value.trim().toLocaleLowerCase();
        const rows = this.category === 'trash' ? this.records : this.items.filter(i => i.type === this.category);
        const direction = this.$('select').value === 'desc' ? -1 : 1;
        return rows.filter(row => {
            const item = row.item || row;
            return [item.label, item.name, item.detail, CATEGORIES[item.type]].join(' ').toLocaleLowerCase().includes(query);
        }).sort((a, b) => direction * (a.item || a).label.localeCompare((b.item || b).label, 'zh-CN', { numeric: true }));
    }
    chosen() { return this.filtered().filter(row => this.selected.has(this.rowKey(row))); }
    render() {
        const nav = this.$('.stlm-nav');
        nav.replaceChildren();
        for (const [type, name] of Object.entries({ ...CATEGORIES, trash: '本地回收副本' })) {
            const count = type === 'trash' ? this.records.length : this.items.filter(i => i.type === type).length;
            const btn = button('', () => {
                this.category = type;
                this.selected.clear(); this.page = 0; this.$('input[type=search]').value = ''; this.render();
            }, type === this.category ? 'active' : '');
            btn.append(el('span', 'stlm-nav-icon', icon[type]), el('span', '', name), el('span', 'stlm-count', count));
            btn.setAttribute('aria-current', type === this.category ? 'page' : 'false');
            nav.append(btn);
        }
        const trash = this.category === 'trash';
        this.$('h3').textContent = trash ? '本地回收副本' : CATEGORIES[this.category];
        const subtitles = {
            character: '批量整理角色卡。聊天文件始终保留；当前角色和群聊成员受到保护。',
            world: '管理世界书文件。已识别的绑定受到保护，其他绑定请在删除前检查。',
            preset: '这里是酒馆“对话补全预设”下拉框对应的预设。',
            theme: '管理已保存的主题和主题内的 CSS。当前使用的主题受到保护。',
            regex: this.scanDone ? '已扫描全局、角色卡与预设内置正则。每项均显示所属资料。' : '先显示全局正则；点击“扫描内置正则”读取卡片和预设中的正则。',
            trash: '这些副本仅在当前浏览器、当前站点和当前账号下显示；清除浏览器数据会丢失。',
        };
        this.$('.stlm-subtitle').textContent = subtitles[this.category];
        this.$('.stlm-storage-note').textContent = this.storageError || (trash ? '建议导出重要副本。恢复时遇到同名资料会跳过，不覆盖现有内容。' : '先备份，再删除。建议提前“导出选中”到设备；操作后关闭面板会刷新酒馆。');
        const filtered = this.filtered();
        const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
        this.page = Math.max(0, Math.min(this.page, maxPage));
        const list = this.$('.stlm-list');
        list.replaceChildren();
        if (!filtered.length) {
            const empty = el('div', 'stlm-empty');
            empty.append(el('span', '', trash ? '↺' : '▧'), el('strong', '', '这里暂时没有资料'), el('p', '', '试试其他分类、清空搜索，或刷新列表。'));
            list.append(empty);
        }
        for (const row of filtered.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
            const item = row.item || row;
            const node = el('div', 'stlm-row');
            node.setAttribute('role', 'listitem');
            const check = el('input');
            check.type = 'checkbox'; check.checked = this.selected.has(this.rowKey(row));
            check.setAttribute('aria-label', `选择 ${item.label}`);
            check.addEventListener('change', () => { check.checked ? this.selected.add(this.rowKey(row)) : this.selected.delete(this.rowKey(row)); this.render(); });
            const symbol = el('div', 'stlm-symbol', icon[item.type]);
            const info = el('div', 'stlm-info');
            info.append(el('strong', '', item.label), el('small', '', trash ? `${CATEGORIES[item.type]} · ${new Date(row.createdAt).toLocaleString()} · ${STATUS[row.status] || '备份'}` : item.detail || item.name));
            node.append(check, symbol, info);
            if (!trash && item.locked) node.append(el('span', 'stlm-badge', item.locked));
            if (!trash) {
                const pinned = this.api.pins.has(item.key);
                const pin = button(pinned ? '★' : '☆', () => this.task(async () => {
                    await this.store.pin(item.key, !pinned);
                    this.api.pins = await this.store.pins();
                    if (!pinned) item.locked = item.locked || '手动保护';
                    else if (item.locked === '手动保护') item.locked = '';
                }), 'stlm-icon-button');
                pin.title = pinned ? '取消手动保护' : '保护这项资料';
                pin.setAttribute('aria-label', pin.title);
                pin.disabled = Boolean(this.storageError);
                node.append(pin);
            }
            node.append(button('预览', () => this.preview(row), 'stlm-preview'));
            list.append(node);
        }
        const chosen = this.chosen();
        this.$('.stlm-selection').textContent = `筛选出 ${filtered.length} 项 · 已选 ${chosen.length} 项`;
        const all = this.$('.stlm-selectbar input');
        all.checked = filtered.length > 0 && chosen.length === filtered.length;
        all.indeterminate = chosen.length > 0 && chosen.length < filtered.length;
        this.$('.stlm-pagination span').textContent = `${this.page + 1} / ${maxPage + 1} 页`;
        this.$('[data-action=scan]').hidden = this.category !== 'regex';
        this.$('[data-action=import]').hidden = !trash;
        this.$('[data-action=restore]').hidden = !trash;
        this.$('[data-action=discard]').hidden = !trash;
        this.$('[data-action=delete]').hidden = trash;
        this.$('[data-action=stop]').hidden = !this.busy;
        this.$('.stlm-footer-note').textContent = this.dirty ? '已产生更改 · 关闭此面板将刷新酒馆' : '删除前自动保存本地副本';
        for (const input of this.dialog.querySelectorAll('button, input, select')) {
            if (input === this.fileInput) continue;
            input.disabled = this.busy;
        }
        this.$('[data-action=stop]').disabled = false;
        this.$('[data-action=prev]').disabled = this.busy || this.page === 0;
        this.$('[data-action=next]').disabled = this.busy || this.page === maxPage;
        for (const action of ['export', 'delete', 'restore', 'discard']) this.$(`[data-action=${action}]`).disabled = this.busy || chosen.length === 0;
        if (this.storageError) {
            for (const action of ['delete', 'restore', 'discard', 'import']) this.$(`[data-action=${action}]`).disabled = true;
            for (const pin of this.dialog.querySelectorAll('.stlm-icon-button')) pin.disabled = true;
        }
    }
    status(message, error = false) { this.$('.stlm-status').textContent = message; this.$('.stlm-status').classList.toggle('stlm-error', error); }
    log(message) { this.$('.stlm-log pre').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`; }
    async scan() {
        await this.task(async () => {
            const result = await this.api.scanRegex((i, total) => this.status(`读取内置正则：${i} / ${total} 张卡片`), () => this.stopped);
            this.items = [...this.items.filter(i => i.type !== 'regex'), ...result.items];
            for (const item of this.items) if (this.api.pins.has(item.key)) item.locked ||= '手动保护';
            this.scanDone = !this.stopped;
            this.selected.clear(); this.page = 0;
            this.status(`找到 ${result.items.length} 条正则，${result.failures.length} 张卡片读取失败${this.stopped ? '；扫描已停止' : ''}。`);
            result.failures.forEach(message => this.log(message));
        });
    }
    async preview(row) {
        await this.task(async () => {
            const item = row.item || row;
            const data = row.item ? row.payload : await this.api.fresh(item);
            const content = el('div', 'stlm-preview-content');
            content.append(el('h3', '', item.label));
            if (typeof data === 'string' && data.startsWith('data:image/png;base64,')) {
                const img = el('img'); img.src = data; img.alt = item.label; content.append(img);
            } else content.append(el('pre', '', JSON.stringify(data, null, 2)));
            await this.confirm(content, { label: '关闭预览', single: true });
        });
    }
    async exportSelected() {
        const rows = this.chosen();
        await this.task(async () => {
            const records = [];
            let failed = 0;
            for (const row of rows) {
                if (this.stopped) break;
                try { records.push(this.category === 'trash' ? row : await this.api.backup(row)); }
                catch (error) { failed++; this.log(`${(row.item || row).label}：${error.message}`); }
                this.status(`准备导出：${records.length + failed} / ${rows.length}`);
            }
            if (records.length) download(records);
            this.status(`已生成 ${records.length} 项备份的下载文件，失败 ${failed} 项。请确认浏览器下载已保存。`);
        });
    }
    async change(action) {
        const chosen = this.chosen();
        const rows = action === 'delete' ? chosen.filter(item => !item.locked && !this.api.pins.has(item.key)) : restoreOrder(chosen.filter(record => record.status !== 'restored'));
        if (!rows.length) { this.status('所选资料全部受保护，或已经恢复。'); return; }
        await this.task(async () => {
            const content = el('div');
            content.append(el('h3', '', action === 'delete' ? `删除 ${rows.length} 项资料？` : `恢复 ${rows.length} 项资料？`));
            content.append(el('p', '', action === 'delete'
                ? `先保存浏览器本地副本，再逐项删除。角色聊天文件保留。${chosen.length - rows.length} 项受保护资料已排除。`
                : '恢复到当前酒馆账号。遇到同名资料或同标识正则会跳过。'));
            const preview = el('ul', 'stlm-confirm-list');
            rows.forEach(row => { const item = row.item || row; preview.append(el('li', '', `${CATEGORIES[item.type]} · ${item.label} · ${item.detail || item.name}`)); });
            content.append(preview);
            const confirmText = action === 'delete' ? `删除 ${rows.length}` : '';
            if (!await this.confirm(content, { label: action === 'delete' ? '备份并删除' : '恢复资料', phrase: confirmText })) return;
            this.dirty = true;
            const work = () => runBatch(rows, {
                action, api: this.api, store: this.store, stopped: () => this.stopped,
                onProgress: result => this.status(`处理中：${result.succeeded.length + result.failed.length} / ${rows.length} · 成功 ${result.succeeded.length} · 失败 ${result.failed.length}`),
            });
            const locks = globalThis.navigator?.locks;
            const result = locks ? await locks.request(`stlm:${this.api.account}`, { ifAvailable: true }, lock => {
                if (!lock) throw new Error('另一个酒馆标签页正在操作资料，请稍后再试');
                return work();
            }) : await work();
            for (const row of result.succeeded) this.log(`${action === 'delete' ? '已删除' : '已恢复'}：${(row.item || row).label}`);
            for (const failure of result.failed) this.log(`${(failure.item.item || failure.item).label}：${failure.message}${failure.uncertain ? '（如请求中断，请核对服务器状态；副本保留）' : ''}`);
            await this.load();
            this.status(`${action === 'delete' ? '删除' : '恢复'}完成：成功 ${result.succeeded.length} 项，失败 ${result.failed.length} 项${result.stopped ? '；已停止后续操作' : ''}。关闭面板将刷新酒馆。`, result.failed.length > 0);
            if (result.failed.length) this.$('.stlm-log').open = true;
        });
    }
    importFile() { this.fileInput.value = ''; this.fileInput.click(); }
    async readImport() {
        const file = this.fileInput.files[0];
        if (!file) return;
        await this.task(async () => {
            if (file.size > 250 * 1024 * 1024) throw new Error('备份超过 250 MB，请拆分后导入');
            const records = parseBundle(await file.text());
            for (const record of records) await this.store.put({ ...clone(record), id: randomId(), createdAt: new Date().toISOString(), status: 'imported' });
            this.records = await this.store.list(); this.selected.clear();
            this.status(`已导入 ${records.length} 项本地副本。勾选后点击“恢复选中”才会写入酒馆。`);
        });
    }
    async discard() {
        const rows = this.chosen();
        await this.task(async () => {
            const content = el('div');
            content.append(el('h3', '', `永久清理 ${rows.length} 项本地副本？`), el('p', '', '只删除浏览器中的备份，不操作服务器。这些副本将无法再从这里恢复，建议先导出。'));
            if (!await this.confirm(content, { label: '永久清理副本', phrase: `清理 ${rows.length}` })) return;
            for (const row of rows) await this.store.discard(row.id);
            this.records = await this.store.list(); this.selected.clear();
            this.status(`已清理 ${rows.length} 项本地副本。`);
        });
    }
    async confirm(content, { label, phrase = '', single = false }) {
        const dialog = el('dialog', 'stlm-confirm');
        dialog.setAttribute('aria-label', label);
        dialog.append(content);
        const footer = el('div', 'stlm-confirm-actions');
        let input;
        if (phrase) {
            const text = el('label', 'stlm-confirm-phrase', `输入“${phrase}”以继续`);
            input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.placeholder = phrase;
            text.append(input); dialog.append(text);
        }
        const result = new Promise(resolve => {
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            if (!single) footer.append(button('取消', () => finish(false)));
            const ok = button(label, () => finish(true), single ? '' : 'stlm-primary');
            if (input) { ok.disabled = true; input.addEventListener('input', () => { ok.disabled = input.value.trim() !== phrase; }); }
            footer.append(ok);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
            dialog.addEventListener('keydown', event => event.stopPropagation());
        });
        dialog.append(footer); document.body.append(dialog); dialog.showModal();
        if (input) input.focus();
        return result;
    }
}
