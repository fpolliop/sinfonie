import { useApp } from '@/stores/app'

/**
 * In-app links Maestro and agents write into their answers: sinfonie://workspace/<id>,
 * sinfonie://agent/<id>, sinfonie://space/<id>, sinfonie://notes, sinfonie://agents,
 * sinfonie://settings/app/<page>, sinfonie://settings/space/<spaceId>/<page>.
 */
export function openSinfonieLink(href: string): void {
  const [kind, ...rest] = href.replace(/^sinfonie:\/\//, '').split('/').filter(Boolean)
  const app = useApp.getState()
  switch (kind) {
    case 'workspace':
      if (rest[0]) app.select(rest[0])
      return
    case 'agent':
      if (rest[0]) app.setOpenAgentId(rest[0])
      app.setView('agents')
      return
    case 'agents':
      app.setView('agents')
      return
    case 'space':
      if (rest[0]) app.setActiveSpace(rest[0])
      app.setView('workspace')
      return
    case 'notes':
      app.setView('notes')
      return
    case 'reviews':
      app.setView('reviews')
      return
    case 'oncall':
      app.setView('oncall')
      return
    case 'settings':
      if (rest[0] === 'space' && rest[1]) app.openSettings({ scope: 'space', spaceId: rest[1], page: rest[2] ?? 'general' } as Parameters<typeof app.openSettings>[0])
      else app.openSettings({ scope: 'app', page: rest[1] ?? rest[0] ?? 'general' } as Parameters<typeof app.openSettings>[0])
      return
    default:
      return
  }
}
