/** Browser-local storage, explicitly partitioned by authenticated Tavern account. */
export class BackupStore {
    constructor(account, factory = globalThis.indexedDB) {
        this.account = account;
        this.factory = factory;
    }
    async open() {
        if (!this.factory) throw new Error('当前浏览器无法使用本地备份库；已禁止删除');
        this.db = await new Promise((resolve, reject) => {
            const request = this.factory.open('st-library-manager-v1', 1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore('backups', { keyPath: 'storageKey' });
                store.createIndex('account', 'account');
                request.result.createObjectStore('pins', { keyPath: 'storageKey' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('无法打开备份库：' + request.error?.message));
            request.onblocked = () => reject(new Error('备份库被其他标签页占用，请关闭其他酒馆页面'));
        });
        this.db.onversionchange = () => this.db.close();
        return this;
    }
    async transaction(name, mode, callback) {
        if (!this.db) throw new Error('备份库尚未打开');
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(name, mode);
            const request = callback(tx.objectStore(name));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = tx.onabort = () => reject(new Error('本地备份读写失败（空间不足或存储被禁用）：' + (tx.error?.message || '事务失败')));
        });
    }
    key(id) { return JSON.stringify([this.account, id]); }
    async put(record) {
        return this.transaction('backups', 'readwrite', store => store.put({ ...record, account: this.account, storageKey: this.key(record.id) }));
    }
    async list() {
        const rows = await this.transaction('backups', 'readonly', store => store.index('account').getAll(this.account));
        return rows.map(({ account, storageKey, ...record }) => record).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    async discard(id) { return this.transaction('backups', 'readwrite', store => store.delete(this.key(id))); }
    async pins() {
        const rows = await this.transaction('pins', 'readonly', store => store.getAll());
        return new Set(rows.filter(row => row.account === this.account).map(row => row.key));
    }
    async pin(key, enabled) {
        return this.transaction('pins', 'readwrite', store => enabled
            ? store.put({ storageKey: this.key(key), account: this.account, key })
            : store.delete(this.key(key)));
    }
}
