import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'

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
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) void api.invoke('shell:openExternal', href)
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
