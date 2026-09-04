/**
 * GET /download[?arch=arm64|x64] → 302 to the latest DMG in the public releases repo.
 * Server-side so the button never depends on the visitor's browser reaching the GitHub API
 * (rate limits, blockers, a click before the script ran). The API answer is cached for 10 minutes.
 */
const REPO = 'fpolliop/sinfonie-releases'
export async function onRequestGet({ request }) {
  const url = new URL(request.url)
  const arch = url.searchParams.get('arch') === 'x64' ? 'x64' : 'arm64'
  let target = `https://github.com/${REPO}/releases/latest`
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'sinfonie.dev download redirect', Accept: 'application/vnd.github+json' },
      cf: { cacheTtl: 600, cacheEverything: true }
    })
    if (res.ok) {
      const rel = await res.json()
      const assets = rel.assets || []
      const dmg = assets.find((a) => a.name.endsWith('.dmg') && a.name.includes(arch)) || assets.find((a) => a.name.endsWith('.dmg'))
      if (dmg) target = dmg.browser_download_url
    }
  } catch {
    /* fall through to the release page */
  }
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } })
}
