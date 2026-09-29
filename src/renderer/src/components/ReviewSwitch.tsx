/**
 * The top of Review: pull request reviews and on-call incidents are one place in the rail, two lists here.
 * On call only shows once the space (or the app) watches Slack, or has incidents.
 */
import React, { useEffect } from 'react'
import { useApp } from '@/stores/app'
import { useOnCall, subscribeOnCall } from '@/stores/oncall'
import { Segmented } from './ui'

export function ReviewSwitch(): React.JSX.Element | null {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const state = useOnCall((s) => s.state)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const space = useApp((s) => s.spaces.find((x) => x.id === activeSpaceId))
  const appConfigured = useApp((s) => Boolean(s.settings.oncall?.channels?.length))
  useEffect(() => subscribeOnCall(), [])
  const mine = state?.incidents.filter((i) => i.spaceId === activeSpaceId) ?? []
  const configured = activeSpaceId ? Boolean(space?.oncall?.channels?.length) || state?.activeSpaces.includes(activeSpaceId) === true : appConfigured || state?.activeSpaces.includes('') === true
  if (!configured && mine.length === 0 && view !== 'oncall') return null
  const open = mine.filter((i) => i.status === 'new' || i.status === 'open').length
  return (
    <div className="drag flex h-11 shrink-0 items-center border-b border-border px-4">
      <Segmented
        size="sm"
        className="no-drag"
        value={view === 'oncall' ? 'oncall' : 'reviews'}
        onChange={(v) => setView(v === 'oncall' ? 'oncall' : 'reviews')}
        options={[
          { id: 'reviews', label: 'Pull requests' },
          { id: 'oncall', label: <span data-tour="oncall">On call{open > 0 ? ` · ${open} open` : ''}</span> }
        ]}
      />
    </div>
  )
}
