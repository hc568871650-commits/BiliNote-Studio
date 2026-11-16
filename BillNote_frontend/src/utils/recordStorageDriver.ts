import { createStore, type UseStore } from 'idb-keyval'

export interface RecordSnapshot { fields: Record<string, unknown>; version?: number; legacy?: string; exists: boolean }
interface Manifest { fields: string[]; version?: number; deleted?: boolean }
let database: UseStore | undefined
const store = () => database ??= createStore('keyval-store', 'keyval')
const manifestKey = (name: string) => `${name}:records-v2`
const fieldKey = (name: string, field: string) => JSON.stringify(['bilinote-record-v2', name, field])

export const recordStorageDriver = {
  read(name: string): Promise<RecordSnapshot> {
    return store()('readonly', objectStore => new Promise((resolve, reject) => {
      const snapshot: RecordSnapshot = { fields: {}, exists: false }
      const transaction = objectStore.transaction
      transaction.oncomplete = () => resolve(snapshot)
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('读取本机记录失败'))
      const request = objectStore.get(manifestKey(name))
      request.onsuccess = () => {
        const manifest = request.result as Manifest | undefined
        if (!manifest) {
          const legacy = objectStore.get(name)
          legacy.onsuccess = () => { if (typeof legacy.result === 'string') snapshot.legacy = legacy.result }
          return
        }
        snapshot.exists = !manifest.deleted
        snapshot.version = manifest.version
        // Read manifest and fields in one transaction; a concurrent save cannot mix revisions.
        for (const field of manifest.fields) {
          const item = objectStore.get(fieldKey(name, field))
          item.onsuccess = () => { snapshot.fields[field] = item.result }
        }
      }
    }))
  },
  commit(name: string, fields: string[] | null, changes: [string, unknown][], removed: string[], version?: number, deleted = false): Promise<void> {
    return store()('readwrite', objectStore => new Promise((resolve, reject) => {
      const transaction = objectStore.transaction
      transaction.oncomplete = () => resolve()
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('保存本机记录失败'))
      try {
        for (const [field, value] of changes) objectStore.put(value, fieldKey(name, field))
        for (const field of removed) objectStore.delete(fieldKey(name, field))
        if (fields) objectStore.put({ fields, version, deleted } satisfies Manifest, manifestKey(name))
      } catch (error) {
        // A synchronous clone failure must also roll back earlier puts in this batch.
        transaction.abort()
        reject(error)
      }
    }))
  },
}
