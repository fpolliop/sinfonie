/**
 * Images the user attaches to messages. Stored as files under the app data folder and served to
 * the renderer through a private scheme, so transcripts stay small and thumbnails survive restarts.
 */
import { app, net, protocol } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { nanoid } from 'nanoid'
import type { ChatImageInput, ChatImageRef } from '@shared/types'

export const SCHEME = 'sinfonie-image'
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

function dir(workspaceId: string): string {
  const d = join(app.getPath('userData'), 'images', workspaceId)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

/** Must run before app.whenReady(): makes the scheme behave like https for URL parsing and fetch. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}
/** After ready: sinfonie-image://images/<workspaceId>/<file> serves the stored file. */
export function registerProtocol(): void {
  protocol.handle(SCHEME, (req) => {
    const u = new URL(req.url)
    const [, workspaceId, file] = u.pathname.split('/')
    if (!workspaceId || !file || file !== basename(file)) return new Response('not found', { status: 404 })
    const path = join(app.getPath('userData'), 'images', workspaceId, file)
    if (!existsSync(path)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })
}

export function saveImages(workspaceId: string, inputs: ChatImageInput[]): ChatImageRef[] {
  return inputs.slice(0, 20).map((img) => {
    const mimeType = EXT[img.mimeType] ? img.mimeType : 'image/png'
    const id = nanoid(10)
    const file = `${id}${EXT[mimeType]}`
    const path = join(dir(workspaceId), file)
    writeFileSync(path, Buffer.from(img.data, 'base64'))
    return { id, name: img.name || `image${extname(file)}`, mimeType, path, url: `${SCHEME}://images/${workspaceId}/${file}` }
  })
}

export function toBase64(ref: ChatImageRef): string {
  return readFileSync(ref.path).toString('base64')
}
