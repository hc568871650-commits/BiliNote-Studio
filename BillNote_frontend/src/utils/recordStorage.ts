import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { recordStorageDriver } from '@/utils/recordStorageDriver'

/** Split large stores without delaying durability; each update is one atomic transaction. */
export function createRecordStorage<S>(split: (state: S) => Record<string, unknown>, join: (fields: Record<string, unknown>) => S): PersistStorage<S> & { flush: () => Promise<void> } {
  let pending: Promise<void> = Promise.resolve()
  const previous = new Map<string, { fields: Record<string, unknown>; version?: number }>()
  const enqueue = (operation: () => Promise<void>) => {
    pending = pending.catch(() => undefined).then(operation)
    return pending
  }
  return {
    flush: () => pending,
    async getItem(name) {
      await pending
      const snapshot = await recordStorageDriver.read(name)
      if (snapshot.legacy !== undefined) return JSON.parse(snapshot.legacy) as StorageValue<S>
      if (!snapshot.exists) return null
      previous.set(name, { fields: snapshot.fields, version: snapshot.version })
      return { state: join(snapshot.fields), version: snapshot.version }
    },
    setItem(name, value) {
      const fields = split(value.state)
      return enqueue(async () => {
        const old = previous.get(name)
        const changes = Object.entries(fields).filter(([key, field]) => !old || !Object.prototype.hasOwnProperty.call(old.fields, key) || old.fields[key] !== field)
        const removed = Object.keys(old?.fields || {}).filter(key => !Object.prototype.hasOwnProperty.call(fields, key))
        if (old && !changes.length && !removed.length && old.version === value.version) return
        // Include on-disk fields on first write, so removal works before hydration too.
        const disk = old ? undefined : await recordStorageDriver.read(name)
        const obsolete = disk ? Object.keys(disk.fields).filter(key => !Object.prototype.hasOwnProperty.call(fields, key)) : removed
        const structuralChange = !old || old.version !== value.version || obsolete.length > 0 || changes.some(([key]) => !Object.prototype.hasOwnProperty.call(old.fields, key))
        await recordStorageDriver.commit(name, structuralChange ? Object.keys(fields) : null, changes, obsolete, value.version)
        previous.set(name, { fields, version: value.version })
      })
    },
    removeItem(name) {
      return enqueue(async () => {
        const disk = await recordStorageDriver.read(name)
        // The tombstone prevents a preserved legacy backup from resurrecting cleared state.
        await recordStorageDriver.commit(name, [], [], Object.keys(disk.fields), undefined, true)
        previous.delete(name)
      })
    },
  }
}
