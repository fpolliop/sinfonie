import { authorize, json } from '../../_auth.js'

const RELEASES = 'fpolliop/sinfonie-releases'
let gh = { at: 0, data: null }

/** GET /api/admin/stats — usage, quality, support and acquisition numbers for the dashboard. */
export async function onRequestGet({ request, env }) {
  const who = await authorize(request, env)
  if (!who) return json({ error: 'unauthorized' }, 401)
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results)
  const [active, series, versions, engines, os, feedbackSeries, feedbackTotals, retention] = await Promise.all([
    q(`SELECT
        (SELECT COUNT(DISTINCT install_id) FROM usage) AS installs,
        (SELECT COUNT(DISTINCT install_id) FROM usage WHERE day = date('now')) AS dau,
        (SELECT COUNT(DISTINCT install_id) FROM usage WHERE day > date('now','-7 day')) AS wau,
        (SELECT COUNT(DISTINCT install_id) FROM usage WHERE day > date('now','-30 day')) AS mau,
        (SELECT COALESCE(SUM(messages),0) FROM usage WHERE day > date('now','-7 day')) AS messages7,
        (SELECT COUNT(DISTINCT install_id) FROM usage WHERE first_seen > datetime('now','-7 day')) AS newInstalls7`),
    q(`SELECT day, COUNT(DISTINCT install_id) AS active, SUM(messages) AS messages, SUM(workspaces) AS workspaces FROM usage WHERE day > date('now','-30 day') GROUP BY day ORDER BY day`),
    // One row per install (its newest day in the window), so an install that upgraded counts once, on its current version.
    q(`SELECT u.app_version AS v, COUNT(*) AS n FROM usage u
        JOIN (SELECT install_id, MAX(day) AS day FROM usage WHERE day > date('now','-7 day') GROUP BY install_id) l ON l.install_id = u.install_id AND l.day = u.day
        GROUP BY u.app_version ORDER BY n DESC`),
    // Engines: every engine an install used on any day of the window, counted once per install.
    q(`SELECT engines, COUNT(DISTINCT install_id) AS n FROM usage WHERE day > date('now','-7 day') AND engines IS NOT NULL AND engines <> '' GROUP BY engines ORDER BY n DESC`),
    q(`SELECT os, COUNT(DISTINCT install_id) AS n FROM usage WHERE day > date('now','-30 day') GROUP BY os ORDER BY n DESC LIMIT 8`),
    // wontfix rows are test submissions and dev artefacts; they would dominate the crash numbers.
    q(`SELECT date(created_at) AS day, kind, COUNT(*) AS n, SUM(count) AS hits FROM feedback WHERE created_at > datetime('now','-30 day') AND status <> 'wontfix' GROUP BY day, kind ORDER BY day`),
    q(`SELECT kind, status, COUNT(*) AS n FROM feedback GROUP BY kind, status`),
    // installs first seen 8-14 days ago that were active in the last 7 days: a rough week-1 retention
    q(`SELECT
        (SELECT COUNT(DISTINCT install_id) FROM usage WHERE first_seen BETWEEN datetime('now','-14 day') AND datetime('now','-7 day')) AS cohort,
        (SELECT COUNT(DISTINCT u.install_id) FROM usage u WHERE u.first_seen BETWEEN datetime('now','-14 day') AND datetime('now','-7 day') AND u.day > date('now','-7 day')) AS retained`)
  ])
  // GitHub: downloads per release asset and issue counts, cached 10 minutes.
  if (Date.now() - gh.at > 10 * 60 * 1000) {
    try {
      // Unauthenticated calls share Cloudflare's egress IPs and their 60/hour GitHub quota; a read-only token (GITHUB_TOKEN secret) avoids the 403s.
      const h = { 'User-Agent': 'sinfonie-admin', Accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) }
      const [rel, open, closed] = await Promise.all([
        fetch(`https://api.github.com/repos/${RELEASES}/releases?per_page=50`, { headers: h }).then((r) => r.json()),
        fetch(`https://api.github.com/search/issues?q=repo:${RELEASES}+type:issue+state:open`, { headers: h }).then((r) => r.json()),
        fetch(`https://api.github.com/search/issues?q=repo:${RELEASES}+type:issue+state:closed`, { headers: h }).then((r) => r.json())
      ])
      if (!Array.isArray(rel)) throw new Error(`GitHub releases: ${rel && rel.message ? rel.message : 'unexpected response'}`)
      const releases = rel.map((r) => ({ tag: r.tag_name, published: r.published_at, downloads: (r.assets || []).filter((a) => /\.dmg$|\.zip$/.test(a.name)).reduce((n, a) => n + (a.download_count || 0), 0) }))
      gh = { at: Date.now(), data: { releases, downloads: releases.reduce((n, r) => n + r.downloads, 0), issuesOpen: open.total_count ?? null, issuesClosed: closed.total_count ?? null } }
    } catch (e) {
      gh = { at: Date.now(), data: { releases: [], downloads: null, issuesOpen: null, issuesClosed: null, error: String(e) } }
    }
  }
  return json({ active: active[0], series, versions, engines, os, feedbackSeries, feedbackTotals, retention: retention[0], github: gh.data, generatedAt: new Date().toISOString() })
}
