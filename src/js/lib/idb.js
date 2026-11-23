// Minimal promise wrapper around one IndexedDB object store used as a key/value map.
// Works in windows and workers.

const reqToPromise = (req) =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
	});

export class KV {
	constructor(dbName = "webblox", storeName = "kv") {
		this.dbName = dbName;
		this.storeName = storeName;
		this.dbPromise = null;
	}

	db() {
		if (!this.dbPromise) {
			this.dbPromise = new Promise((resolve, reject) => {
				const req = indexedDB.open(this.dbName, 1);
				req.onupgradeneeded = () => {
					if (!req.result.objectStoreNames.contains(this.storeName)) req.result.createObjectStore(this.storeName);
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error || new Error(`Could not open IndexedDB ${this.dbName}`));
			});
			this.dbPromise.catch(() => (this.dbPromise = null));
		}
		return this.dbPromise;
	}

	async get(key) {
		const db = await this.db();
		return reqToPromise(db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(key));
	}

	async set(key, value) {
		const db = await this.db();
		const tx = db.transaction(this.storeName, "readwrite");
		tx.objectStore(this.storeName).put(value, key);
		await new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB write failed"));
		});
	}

	async delete(key) {
		const db = await this.db();
		const tx = db.transaction(this.storeName, "readwrite");
		tx.objectStore(this.storeName).delete(key);
		await new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB delete failed"));
		});
	}
}

// Opens an existing database without ever creating it. Resolves null if it does not exist,
// so reading another library's database cannot leave behind an empty one that breaks it.
export function openExisting(dbName) {
	return new Promise((resolve) => {
		const req = indexedDB.open(dbName);
		// Only fires when the database did not exist yet: abort so it is not created.
		req.onupgradeneeded = () => req.transaction.abort();
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => resolve(null);
		req.onblocked = () => resolve(null);
	});
}

export { reqToPromise };
