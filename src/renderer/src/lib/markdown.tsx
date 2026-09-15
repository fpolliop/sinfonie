import React from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { openSinfonieLink } from '@/lib/links'

/**
 * GitHub-flavoured markdown rendered to React elements (no raw HTML), so
 * tables, task lists, strikethrough and nested lists from the model display
 * properly. Links open in the system browser.
 */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(u) => (u.startsWith('sinfonie://') ? u : defaultUrlTransform(u))}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href?.startsWith('sinfonie://')) openSinfonieLink(href)
                else if (href) void api.invoke('shell:openExternal', href)
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} readOnly className="mr-1 align-middle" />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
