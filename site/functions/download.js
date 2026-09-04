/**
 * GET /download[?arch=arm64|x64] → 302 to the latest DMG in the public releases repo.
 * Server-side so the button never depends on the visitor's browser reaching GitHub's API.
 * Uses GitHub's own /releases/latest redirect to learn the tag (no API, no rate limit) and the
 * release's known asset naming (Sinfonie-<version>-<arch>.dmg, from electron-builder).
 */
const REPO = 'fpolliop/sinfonie-releases'
export async function onRequestGet({ request }) {
  const url = new URL(request.url)
  const arch = url.searchParams.get('arch') === 'x64' ? 'x64' : 'arm64'
  let target = `https://github.com/${REPO}/releases/latest`
  try {
    const res = await fetch(target, { redirect: 'manual', headers: { 'User-Agent': 'sinfonie.dev download redirect' }, cf: { cacheTtl: 600, cacheEverything: true } })
    const loc = res.headers.get('location') || ''
    const tag = /\/releases\/tag\/(v[\d.]+)/.exec(loc)?.[1]
    if (tag) target = `https://github.com/${REPO}/releases/download/${tag}/Sinfonie-${tag.slice(1)}-${arch}.dmg`
  } catch {
    /* fall through to the release page */
  }
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } })
}
