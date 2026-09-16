import { useApp, type AppPage, type SpacePage } from '@/stores/app'

/** Settings page ids the window knows (SettingsWindow's APP_PAGES/SPACE_PAGES plus the old ids it still routes). */
const APP_PAGE_IDS: readonly string[] = ['preferences', 'general', 'spaces', 'repos', 'accounts', 'logins', 'providers', 'crew', 'resources', 'usage', 'integrations', 'oncall', 'mcp', 'jira', 'linear', 'slack', 'gcp', 'phone', 'plan', 'feedback', 'about']
const SPACE_PAGE_IDS: readonly string[] = ['general', 'repos', 'crew', 'oncall', 'jira', 'linear', 'slack', 'github', 'gcp', 'databases', 'mcp']

const appPage = (id: string | undefined): AppPage => (id && APP_PAGE_IDS.includes(id) ? (id as AppPage) : 'general')
const spacePage = (id: string | undefined): SpacePage => (id && SPACE_PAGE_IDS.includes(id) ? (id as SpacePage) : 'general')

/**
 * In-app links Maestro and agents write into their answers: sinfonie://workspace/<id>,
 * sinfonie://agent/<id>, sinfonie://space/<id>, sinfonie://notes, sinfonie://agents,
 * sinfonie://settings/app/<page>, sinfonie://settings/space/<spaceId>/<page>.
 * An unknown settings page opens General rather than a blank window.
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
      if (rest[0] === 'space' && rest[1]) app.openSettings({ scope: 'space', spaceId: rest[1], page: spacePage(rest[2]) })
      else app.openSettings({ scope: 'app', page: appPage(rest[0] === 'app' ? rest[1] : rest[0]) })
      return
    default:
      return
  }
}
