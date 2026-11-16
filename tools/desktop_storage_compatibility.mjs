// Runs in a quiescent same-origin maintenance page, never in the live application.
export async function compatibilityStorage({ apply = false, expected = null } = {}) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('keyval-store')
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('keyval')) request.result.createObjectStore('keyval') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('keyval', apply ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('keyval')
      let result
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Storage compatibility transaction failed'))
      const allKeys = store.getAllKeys(), allValues = store.getAll()
      let keyList, values
      const finish = () => {
        if (!keyList || !values) return
        try {
          const entries = new Map(keyList.map((key, index) => [key, values[index]]))
          const states = {}, changed = [], formats = {}
          for (const name of ['task-storage', 'bilinote-reading-assistant-v1']) {
            const manifestKey = `${name}:records-v2`
            const manifest = entries.get(manifestKey)
            const fields = {}
            const fieldKeys = []
            if (!manifest) {
              const legacy = entries.get(name)
              states[name] = legacy == null ? null : JSON.parse(legacy)
              formats[name] = 'legacy'
              continue
            }
            if (!Array.isArray(manifest.fields)) throw new Error('Invalid storage manifest')
            for (const field of manifest.fields) {
              const key = JSON.stringify(['bilinote-record-v2', name, field])
              if (!entries.has(key)) throw new Error('Missing storage record; refusing downgrade')
              fields[field] = entries.get(key); fieldKeys.push(key)
            }
            let state
            if (name === 'task-storage') {
              if (!manifest.deleted && !Array.isArray(fields.tasks)) throw new Error('Missing task collection')
              state = { tasks: fields.tasks || [], currentTaskId: fields.currentTaskId ?? null }
            } else {
              const sessions = {}, counts = {}
              for (const [record, value] of Object.entries(fields)) {
                const [key, field, index] = JSON.parse(record)
                if (!key.startsWith('note:')) throw new Error('Unexpected persisted temporary session')
                const session = sessions[key] ??= { messages: [], input: '', attachments: [] }
                if (field === 'message') session.messages[index] = value
                else if (field === 'message-count') counts[key] = value
                else Object.assign(session, { [field]: value })
              }
              for (const [key, session] of Object.entries(sessions)) {
                if (session.messages.length !== counts[key] || Object.keys(session.messages).length !== counts[key]) throw new Error('Incomplete message sequence')
              }
              state = { sessions }
            }
            states[name] = manifest.deleted ? null : { state, version: manifest.version }
            formats[name] = 'records-v2'
            changed.push({ name, manifestKey, fieldKeys })
          }
          if (apply) {
            if (!expected || JSON.stringify(states) !== JSON.stringify(expected)) throw new Error('Storage changed after backup; refusing downgrade')
            for (const { name, manifestKey, fieldKeys } of changed) {
              store.put(JSON.stringify(states[name]), name)
              store.delete(manifestKey)
              for (const key of fieldKeys) store.delete(key)
            }
          }
          result = { states, formats, converted: apply ? changed.length : 0,
            tasks: states['task-storage']?.state.tasks.length || 0,
            sessions: Object.keys(states['bilinote-reading-assistant-v1']?.state.sessions || {}).length }
        } catch (error) { transaction.abort(); reject(error) }
      }
      allKeys.onsuccess = () => { keyList = allKeys.result; finish() }
      allValues.onsuccess = () => { values = allValues.result; finish() }
    })
  } finally { database.close() }
}
