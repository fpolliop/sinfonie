/**
 * Is this shell command safe for a read-only review? Every pipeline segment must be a
 * read-only git subcommand or a harmless text tool; no redirections, no writes.
 */
const RO_GIT = new Set(['diff', 'log', 'show', 'blame', 'status', 'fetch', 'merge-base', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'grep', 'cat-file', 'branch', 'tag', 'describe', 'shortlog', 'name-rev', 'remote', 'config', 'worktree', 'stash'])
const RO_TOOLS = new Set(['echo', 'head', 'tail', 'cat', 'wc', 'grep', 'rg', 'ls', 'find', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'file', 'stat', 'pwd', 'true', 'printf', 'xargs', 'basename', 'dirname', 'realpath', 'tree', 'test', '[', 'cd'])
export function isReadOnlyCommand(cmd: string): boolean {
  if (/[>]|\btee\b/.test(cmd.replace(/2>&1/g, ''))) return false
  // split on pipes, ;, &&, ||, newlines; keep $( ) contents as their own segments
  const segments = cmd
    .replace(/\$\(([^()]*)\)/g, ' ; $1 ; ')
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return false
  for (const seg of segments) {
    const words = seg.replace(/^\s*(env\s+)?([A-Z_]+=\S+\s+)*/, '').split(/\s+/)
    const bin = (words[0] ?? '').replace(/^.*\//, '')
    if (bin === 'git') {
      const sub = words.find((w, i) => i > 0 && !w.startsWith('-'))
      if (!sub || !RO_GIT.has(sub)) return false
      if ((sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'worktree' || sub === 'stash' || sub === 'config') && words.some((w) => /^(-d|-D|-m|-M|add|remove|prune|set-url|drop|pop|apply|push|--unset|--add)$/.test(w) || /^--(delete|move|force|edit)/.test(w))) return false
      if (sub === 'config' && !words.includes('--get') && !words.includes('--list') && !words.includes('-l')) return false
      // stash and worktree only read with an explicit list/show; bare `git stash` writes.
      if ((sub === 'stash' || sub === 'worktree') && !words.slice(words.indexOf(sub) + 1).some((w) => w === 'list' || w === 'show')) return false
      continue
    }
    if (bin === 'sed' && !words.includes('-n') && !words.some((w) => /^-n/.test(w))) return false
    if (bin === 'find' && words.some((w) => w === '-delete' || w === '-exec' || w === '-execdir')) return false
    if (bin === 'xargs' && !words.slice(1).some((w) => RO_TOOLS.has(w) || w === 'git')) return false
    if (!RO_TOOLS.has(bin)) return false
  }
  return true
}
