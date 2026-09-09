import React, { useEffect, useState } from 'react'
import { Coffee } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { Button } from './ui'

/**
 * Keep the Mac awake while an agent works, like the `caffeinate` command. App-wide: every button reflects
 * the one blocker and stays in sync through the power:changed event. The display may still sleep.
 */
export function CaffeineButton({ compact }: { compact?: boolean }): React.JSX.Element {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void api.invoke('power:get').then(setOn)
    return api.on('power:changed', setOn)
  }, [])
  const toggle = (): void => void api.invoke('power:set').then(setOn)
  const title = on ? 'Keeping your Mac awake. Click to let it sleep normally.' : 'Keep your Mac awake while the agent works (like caffeinate).'
  if (compact) {
    return (
      <button onClick={toggle} title={title} aria-pressed={on} className={clsx('rounded-md p-1', on ? 'text-accent' : 'text-muted hover:bg-panel-2 hover:text-text')}>
        <Coffee size={13} />
      </button>
    )
  }
  return (
    <Button size="sm" variant={on ? 'subtle' : 'ghost'} onClick={toggle} title={title} aria-pressed={on} className={on ? 'text-accent' : undefined}>
      <Coffee size={13} /> {on ? 'Awake' : 'Keep awake'}
    </Button>
  )
}
