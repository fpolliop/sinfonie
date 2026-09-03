import React from 'react'
import { UserCircle2 } from 'lucide-react'
import { useApp } from '@/stores/app'
import clsx from 'clsx'

/** Select among Claude logins. Renders nothing when there is only the default account. */
export function AccountPicker({ value, onChange, className, always }: { value: string; onChange: (id: string) => void; className?: string; always?: boolean }): React.JSX.Element | null {
  const accounts = useApp((s) => s.settings.claudeAccounts)
  if (accounts.length <= 1 && !always) return null
  return (
    <label className={clsx('inline-flex items-center gap-1.5 text-[12px]', className)} title="Claude account">
      <UserCircle2 size={14} className="text-muted" />
      <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={value} onChange={(e) => onChange(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.loggedIn === false ? ' (not logged in)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
