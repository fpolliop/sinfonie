import React from 'react'
import { UserCircle2 } from 'lucide-react'
import { useApp } from '@/stores/app'
import clsx from 'clsx'
import { VENDORS, type Engine } from '@shared/types'

/** Select among the accounts of the vendor behind an engine. Renders nothing when that vendor has one account, unless `always`. */
export function AccountPicker({ value, onChange, className, always, engine }: { value: string; onChange: (id: string) => void; className?: string; always?: boolean; engine?: Engine }): React.JSX.Element | null {
  const all = useApp((s) => s.settings.claudeAccounts)
  const defaultEngine = useApp((s) => s.settings.engine ?? 'claude-code')
  const vendor = VENDORS.find((v) => v.engine === (engine ?? defaultEngine))?.id
  if (!vendor) return null
  const accounts = all.filter((a) => (a.vendor ?? 'anthropic') === vendor)
  if (accounts.length <= 1 && !always) return null
  return (
    <label className={clsx('inline-flex items-center gap-1.5 text-[12px]', className)} title={`${VENDORS.find((v) => v.id === vendor)?.label} account`}>
      <UserCircle2 size={14} className="text-muted" />
      <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={accounts.some((a) => a.id === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {!accounts.some((a) => a.id === value) && <option value="">Vendor default</option>}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.loggedIn === false ? ' (not signed in)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
