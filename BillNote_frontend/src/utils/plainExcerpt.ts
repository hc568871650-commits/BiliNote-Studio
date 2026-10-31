// Search excerpts are raw Markdown slices that may start or end mid-syntax.
export function plainExcerpt(text: string) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*(\]\([^)]*)?$/, ' ')
    .replace(/^[^\s()[\]]*\.(?:png|jpe?g|gif|webp|svg|bmp)\)/i, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*?Content-\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/g, '$1')
    .replace(/(?:^|\s)#{1,6}\s+/g, ' ')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(（])[*_](?=\S)|(?<=\S)[*_](?=[\s)）.,，。；;:：!?！？]|$)/g, '$1')
    .replace(/(^|[\s|]):?-{3,}:?(?=[\s|]|$)/g, '$1')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/(^|\s)[-*+](?=\s)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
