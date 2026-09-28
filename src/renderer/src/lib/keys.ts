/**
 * Global shortcuts yield to editors: a key the code editor or the terminal already handles (⌘/ toggles a comment,
 * ⌘K clears the terminal, ⌥⌘↑/↓ add cursors) must not also trigger an app-wide action.
 */
export function yieldsToEditor(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true
  const t = e.target instanceof Element ? e.target : null
  return Boolean(t?.closest('.cm-editor, .xterm'))
}
