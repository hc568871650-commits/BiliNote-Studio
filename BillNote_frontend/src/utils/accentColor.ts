export type HSV = { h: number; s: number; v: number }
export const normalizeHex = (value: string) => /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
export function hexToHsv(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const h = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: h * 60, s: max ? delta / max : 0, v: max }
}
export function hsvToHex({ h, s, v }: HSV) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0')
  }
  return '#' + f(5) + f(3) + f(1)
}
const luminance = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
  .reduce((total, x, i) => total + x * [.2126, .7152, .0722][i], 0)
export const accentForeground = (hex: string) => luminance(hex) > .179 ? '#181818' : '#ffffff'
export function accentVariants(hex: string) {
  const adjust = (dark: boolean) => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    const background = dark ? luminance('#181818') : 1
    for (let step = 0; step <= 100; step++) {
      const color = '#' + channels.map(c => Math.round(c + ((dark ? 255 : 0) - c) * step / 100).toString(16).padStart(2, '0')).join('')
      const l = luminance(color)
      if ((Math.max(l, background) + .05) / (Math.min(l, background) + .05) >= 4.5) return color
    }
    return dark ? '#ffffff' : '#000000'
  }
  return { light: adjust(false), dark: adjust(true) }
}
