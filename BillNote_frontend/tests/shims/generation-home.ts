export const navigation: unknown[] = []
export const viewChanges: unknown[] = []
const task = { id: 'accepted', status: 'SUMMARIZING', audioMeta: { title: 'video' }, formData: {}, markdown: '' }
const state = { tasks: [task], currentTaskId: 'accepted', setCurrentTask: () => undefined, loadTask: async () => undefined, syncNotes: async () => undefined }
export const useTaskStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state, persist: { hasHydrated: () => true, onFinishHydration: () => () => undefined } })
export const useInterfaceStore = { getState: () => ({ startPage: 'create' }) }
export const useLocation = () => ({ pathname: '/', search: '?view=create&source=video', key: 'initial' })
export const useNavigate = () => (...args: unknown[]) => navigation.push(args)
export const useState = (initial: unknown) => [typeof initial === 'function' ? initial() : initial, (next: unknown) => viewChanges.push(next)]
export const useRef = (current: unknown) => ({ current })
export const useCallback = (callback: unknown) => callback
export const useEffect = () => undefined
export const useLayoutEffect = () => undefined
export const jsx = (type: unknown, props: unknown) => ({ type, props })
export const jsxs = jsx
export const Fragment = 'fragment'
export default function Component() { return null }
