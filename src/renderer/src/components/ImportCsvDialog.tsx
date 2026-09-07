import React, { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Dialog, inputCls } from './ui'
import type { DbConnection, DbTable } from '@shared/types'

type Preview = { path: string; delimiter: string; headers: string[]; sample: string[][]; rowCount: number }

/** Pick a CSV, map its columns onto a table, confirm, insert in one transaction. */
export function ImportCsvDialog({ spaceId, connection, table, onClose, onDone }: { spaceId: string; connection: DbConnection; table: DbTable; onClose: () => void; onDone: (inserted: number) => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [coerce, setCoerce] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const cols = table.columns ?? []
  const pick = async (): Promise<void> => {
    try {
      const p = await api.invoke('db:csvPreview')
      if (!p) return
      setPreview(p)
      const m: Record<string, string> = {}
      for (const h of p.headers) {
        const hit = cols.find((c) => c.name.toLowerCase() === h.trim().toLowerCase()) ?? cols.find((c) => c.name.replace(/_/g, '').toLowerCase() === h.replace(/[_\s-]/g, '').toLowerCase())
        if (hit) m[h] = hit.name
      }
      setMapping(m)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    void pick()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const mapped = Object.values(mapping).filter(Boolean)
  const run = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setStatus(`Inserting ${preview.rowCount} rows…`)
    try {
      const r = await api.invoke('db:import', spaceId, connection.id, { path: preview.path, delimiter: preview.delimiter, table: { schema: table.schema, name: table.name }, mapping, coerceTypes: coerce })
      onDone(r.inserted)
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={`Import CSV into ${table.schema}.${table.name}`} onClose={onClose} width={680}>
      {!preview ? (
        <div className="flex items-center gap-2 text-[13px]">
          <Button onClick={() => void pick()}>
            <Upload size={13} /> Choose a CSV file
          </Button>
          <span className="text-muted">Comma, semicolon or tab separated, first row as headers.</span>
        </div>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="text-[12px] text-muted">
            {preview.path.split('/').pop()} · {preview.rowCount} data rows · delimiter “{preview.delimiter === '\t' ? 'tab' : preview.delimiter}” ·{' '}
            <button className="text-accent hover:underline" onClick={() => void pick()}>
              choose another file
            </button>
          </div>
          <div className="max-h-[40vh] overflow-auto rounded-md border border-border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">CSV column</th>
                  <th className="px-2 py-1 text-left font-medium">Sample</th>
                  <th className="px-2 py-1 text-left font-medium">Table column</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((h, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1 font-mono">{h}</td>
                    <td className="max-w-[220px] truncate px-2 py-1 text-muted">{preview.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ')}</td>
                    <td className="px-2 py-1">
                      <select className={inputCls} value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                        <option value="">— skip —</option>
                        {cols.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name} ({c.type})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={coerce} onChange={(e) => setCoerce(e.target.checked)} /> Convert numbers, booleans and empty cells (to NULL); untick to insert every value as text
          </label>
          <div className="flex items-center gap-2">
            <Button variant="danger" disabled={busy || !mapped.length} onClick={() => void run()}>
              <Upload size={13} /> {busy ? 'Importing…' : `Insert ${preview.rowCount} rows into ${table.name}`}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {status && <span className={status.startsWith('Failed') ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>{status}</span>}
          </div>
          <p className="text-[11px] text-muted">One transaction where the engine supports it: on an error nothing is inserted. Existing rows are not touched; duplicate keys fail the import.</p>
        </div>
      )}
    </Dialog>
  )
}
