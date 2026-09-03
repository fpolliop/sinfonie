import React from 'react'

/**
 * Small, safe markdown renderer for chat text: fenced code, inline code,
 * bold, italics, links, headings, lists, paragraphs. No raw HTML.
 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++
      blocks.push(
        <pre key={key++} data-lang={lang}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const Tag = `h${h[1].length}` as 'h1' | 'h2' | 'h3'
      blocks.push(<Tag key={key++}>{inline(h[2])}</Tag>)
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      blocks.push(<ul key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''))
      blocks.push(<ol key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>)
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') && !/^(#{1,3})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++])
    blocks.push(<p key={key++}>{inline(para.join(' '))}</p>)
  }
  return <div className="prose-chat">{blocks}</div>
}

function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('*')) out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!
      out.push(<a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>)
    }
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
