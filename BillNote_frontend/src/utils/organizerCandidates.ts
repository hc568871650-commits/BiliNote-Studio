export interface FolderCandidate { id: string; name: string }

// Ranks folders by how well their name matches what the user typed, best first.
// Used when the organizer asks for clarification, e.g. "蒸馏的那几篇" should surface "蒸馏视频".
// Returning [] makes the UI fall back to listing every folder.
export function rankFolderCandidates(instruction: string, folders: FolderCandidate[]): FolderCandidate[] {
  const normalize = (text: string) => text.replace(/[\s_\-—·、，,。]/g, '').toLocaleLowerCase()
  const query = normalize(instruction)
  const score = (name: string) => {
    const core = normalize(name).replace(/(?:视频|笔记|文件夹)$/, '')
    let longest = 0
    for (let start = 0; start < core.length; start++) {
      for (let end = start + 2; end <= core.length; end++) {
        if (query.includes(core.slice(start, end))) longest = Math.max(longest, end - start)
      }
    }
    return longest
  }
  return folders.map(folder => ({ folder, score: score(folder.name) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.folder.name.localeCompare(b.folder.name))
    .map(item => item.folder)
}
