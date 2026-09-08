import React, { useEffect, useRef } from 'react'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { ghostText } from '@/lib/ghost'
import { changeGutter, setChangeBase } from '@/lib/changeGutter'
import { HighlightStyle, LanguageDescription, type LanguageSupport, type TagStyle, bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

type Tag = Exclude<TagStyle['tag'], readonly unknown[]>

/**
 * `@lezer/highlight` is not a direct dependency (it only lives inside pnpm's
 * virtual store), so the tag objects are collected from the default style
 * (and their parents) and remapped by name to the app's palette.
 */
const appHighlightStyle = ((): HighlightStyle => {
  const byName = new Map<string, Tag>()
  for (const spec of defaultHighlightStyle.specs) {
    const list: readonly Tag[] = 'set' in spec.tag ? [spec.tag] : spec.tag
    for (const t of list) for (const p of t.set) byName.set(String(p), p)
  }
  const palette: Array<[string[], Omit<TagStyle, 'tag'>]> = [
    [['keyword'], { color: '#a78bfa' }],
    [['string', 'special(string)', 'inserted'], { color: '#4ade80' }],
    [['literal', 'atom', 'bool', 'labelName'], { color: '#fbbf24' }],
    [['regexp', 'escape', 'url'], { color: '#f472b6' }],
    [['comment'], { color: '#8f97a8', fontStyle: 'italic' }],
    [['meta'], { color: '#8f97a8' }],
    [['typeName', 'namespace', 'className'], { color: '#7c9cff' }],
    [['definition(variableName)', 'macroName'], { color: '#f472b6' }],
    [['special(variableName)'], { color: '#7c9cff' }],
    [['propertyName', 'definition(propertyName)'], { color: '#c7cede' }],
    [['deleted', 'invalid'], { color: '#ff6b6b' }],
    [['link'], { color: '#7c9cff', textDecoration: 'underline' }],
    [['heading'], { color: '#e6e8ec', fontWeight: 'bold' }],
    [['emphasis'], { fontStyle: 'italic' }],
    [['strong'], { fontWeight: 'bold' }],
    [['strikethrough'], { textDecoration: 'line-through' }]
  ]
  const specs: TagStyle[] = []
  for (const [names, style] of palette) {
    const tag = names.map((n) => byName.get(n)).filter((t): t is Tag => Boolean(t))
    if (tag.length) specs.push({ tag, ...style })
  }
  return specs.length ? HighlightStyle.define(specs, { themeType: 'dark' }) : defaultHighlightStyle
})()

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e6e8ec', fontSize: '11.5px', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.5', overflow: 'auto' },
    '.cm-content': { padding: '6px 0' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5f6776', borderRight: '1px solid var(--color-border, #262b35)', minWidth: '44px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px' },
    '.cm-foldGutter .cm-gutterElement': { color: '#5f6776' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8f97a8' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(124,156,255,0.25)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(124,156,255,0.18)', outline: '1px solid rgba(124,156,255,0.4)' }
  },
  { dark: true }
)

const langCache = new Map<string, Promise<LanguageSupport>>()
const loadLanguage = (desc: LanguageDescription): Promise<LanguageSupport> => {
  let p = langCache.get(desc.name)
  if (!p) {
    p = desc.load()
    langCache.set(desc.name, p)
  }
  return p
}

export interface CodeViewProps {
  text: string
  filename: string
  /** Typing edits the document; `onChange` receives the full text after each change. */
  editable?: boolean
  onChange?: (text: string) => void
  /** ⌘S. */
  onSave?: () => void
  /** Inline suggestions: asked with the text before and after the cursor, when `suggestionsOn`. */
  suggest?: (prefix: string, suffix: string) => Promise<string>
  suggestionsOn?: boolean
  /** The committed text; when given, the gutter shows added, modified and deleted lines against it. */
  baseText?: string | null
}

/** CodeMirror view: line numbers, folding, syntax colours from the file name; optionally editable with ghost-text suggestions and IntelliJ-style change markers. */
export function CodeView({ text, filename, editable = false, onChange, onSave, suggest, suggestionsOn = false, baseText = null }: CodeViewProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langConf = useRef(new Compartment())
  const editConf = useRef(new Compartment())
  const langExt = useRef<Extension>([])
  const latest = useRef({ onChange, onSave, suggest, suggestionsOn, baseText })
  latest.current = { onChange, onSave, suggest, suggestionsOn, baseText }
  const baseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshMarkers = (view: EditorView): void => {
    if (baseTimer.current) clearTimeout(baseTimer.current)
    baseTimer.current = setTimeout(() => setChangeBase(view, latest.current.baseText), 150)
  }

  useEffect(() => {
    if (!host.current || viewRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          editConf.current.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
          lineNumbers(),
          changeGutter(),
          foldGutter(),
          history(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          ghostText({ fetch: (p, sfx) => latest.current.suggest?.(p, sfx) ?? Promise.resolve(''), enabled: () => Boolean(latest.current.suggestionsOn && latest.current.suggest) }),
          keymap.of([
            { key: 'Mod-s', run: () => (latest.current.onSave?.(), true) },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            latest.current.onChange?.(u.state.doc.toString())
            refreshMarkers(u.view)
          }),
          langConf.current.of(langExt.current),
          syntaxHighlighting(appHighlightStyle),
          theme
        ]
      }),
      parent: host.current
    })
    viewRef.current = view
    setChangeBase(view, baseText)
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = viewRef.current
    if (!v || v.state.doc.toString() === text) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 } })
    v.scrollDOM.scrollTop = 0
    setChangeBase(v, baseText)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editConf.current.reconfigure([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]) })
  }, [editable])

  useEffect(() => {
    if (viewRef.current) setChangeBase(viewRef.current, baseText)
  }, [baseText])

  useEffect(() => {
    const desc = LanguageDescription.matchFilename(languages, filename)
    if (!desc) {
      langExt.current = []
      viewRef.current?.dispatch({ effects: langConf.current.reconfigure([]) })
      return
    }
    let cancelled = false
    loadLanguage(desc)
      .then((support) => {
        if (cancelled) return
        langExt.current = support
        viewRef.current?.dispatch({ effects: langConf.current.reconfigure(support) })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [filename])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
