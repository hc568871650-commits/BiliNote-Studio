import { get } from 'idb-keyval'
import type { RecordSnapshot } from '../../src/utils/recordStorageDriver'

const snapshots = new Map<string, RecordSnapshot>()
export const recordWrites: { name: string; changed: string[] }[] = []
export const recordStorageDriver = {
  async read(name: string): Promise<RecordSnapshot> {
    return structuredClone(snapshots.get(name) || { fields: {}, exists: false, legacy: await get(name) })
  },
  async commit(name: string, _fields: string[] | null, changes: [string, unknown][], removed: string[], version?: number, deleted = false) {
    const next = structuredClone(snapshots.get(name)?.fields || {})
    for (const [key, value] of changes) next[key] = structuredClone(value)
    for (const key of removed) delete next[key]
    snapshots.set(name, { fields: next, exists: !deleted, version })
    recordWrites.push({ name, changed: changes.map(([key]) => key) })
  },
}
