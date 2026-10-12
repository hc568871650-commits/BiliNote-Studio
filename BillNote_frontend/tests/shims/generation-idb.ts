export const writes: string[] = []
const items = new Map<string, string>()
export const get = async (name: string) => items.get(name)
export const set = async (name: string, value: string) => { writes.push(value); items.set(name, value) }
export const del = async (name: string) => { items.delete(name) }
