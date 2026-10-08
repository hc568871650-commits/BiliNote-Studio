// In-memory IndexedDB adapter used only by regression tests.
const values = new Map<IDBValidKey, unknown>()
export async function get<T = unknown>(key: IDBValidKey): Promise<T | undefined> { return values.get(key) as T | undefined }
export async function set(key: IDBValidKey, value: unknown): Promise<void> { values.set(key, structuredClone(value)) }
export async function del(key: IDBValidKey): Promise<void> { values.delete(key) }
export function readPersisted(key: string): unknown { return values.get(key) }
