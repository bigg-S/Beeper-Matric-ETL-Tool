
'use_client'
export function getIDBFactory(): IDBFactory | undefined {
    try {
        return self?.indexedDB ? self.indexedDB : window.indexedDB;
    } catch {}
}

let idb: IDBDatabase | null = null;

async function idbInit(): Promise<void> {
    if (!getIDBFactory()) {
        throw new Error("IndexedDB not available");
    }
    idb = await new Promise((resolve, reject) => {
        const request = getIDBFactory()!.open("matrix-react-sdk", 1);
        request.onerror = reject;
        request.onsuccess = (): void => {
            resolve(request.result);
        };
        request.onupgradeneeded = (): void => {
            const db = request.result;
            db.createObjectStore("pickleKey");
            db.createObjectStore("account");
        };
    });
}

async function idbTransaction(
    table: string,
    mode: IDBTransactionMode,
    fn: (objectStore: IDBObjectStore) => IDBRequest<any>,
): Promise<any> {
    if (!idb) {
        await idbInit();
    }
    return new Promise((resolve, reject) => {
        const txn = idb!.transaction([table], mode);
        txn.onerror = reject;

        const objectStore = txn.objectStore(table);
        const request = fn(objectStore);
        request.onerror = reject;
        request.onsuccess = (): void => {
            resolve(request.result);
        };
    });
}

export async function idbLoad(table: string, key: string | string[]): Promise<any> {
    if (!idb) {
        await idbInit();
    }
    return idbTransaction(table, "readonly", (objectStore) => objectStore.get(key));
}

export async function idbSave(table: string, key: string | string[], data: any): Promise<void> {
    if (!idb) {
        await idbInit();
    }
    return idbTransaction(table, "readwrite", (objectStore) => objectStore.put(data, key));
}


export async function idbDelete(table: string, key: string | string[]): Promise<void> {
    if (!idb) {
        await idbInit();
    }
    return idbTransaction(table, "readwrite", (objectStore) => objectStore.delete(key));
}

export async function idbClear(table: string): Promise<void> {
    if (!idb) {
        await idbInit();
    }
    return idbTransaction(table, "readwrite", (objectStore) => objectStore.clear());
}
