// Do not mount browser notification UI in node regression tests.
const toast = Object.assign(() => undefined, { error: () => undefined, success: () => undefined })
export { toast }
export default toast
