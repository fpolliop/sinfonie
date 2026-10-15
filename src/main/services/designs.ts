/**
 * Claude Design, phase 1 (design → build): designs linked to a workspace.
 *
 * A design is a Claude Design canvas link and/or its exported artboards (PNG, JPG, PDF). Sinfonie's agents
 * cannot open a canvas themselves (no `Artifact` tool outside the Claude app, see docs/plans/claude-design.md),
 * so "Build this design" sends the exported artboards as images with a brief. Images are copied next to the
 * chat images (served by the sinfonie-image scheme); PDFs go to userData/designs/<workspace>/ and the agent
 * reads them by path.
 */
import { app, dialog, nativeImage, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { nanoid } from 'nanoid'
import type { ChatImageInput, DesignFile, DesignLink } from '@shared/types'
import { getWorkspace, patchWorkspace } from './workspaces'
import { SCHEME } from './images'

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
/** Long edge the model sees; larger exports are scaled down (the API downsizes past this anyway). */
const BRIEF_EDGE = 1568
const BRIEF_MAX_IMAGES = 10

function dirFor(kind: 'images' | 'designs', workspaceId: string): string {
  const d = join(app.getPath('userData'), kind, workspaceId)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function list(workspaceId: string): DesignLink[] {
  return getWorkspace(workspaceId).designs ?? []
}

function save(workspaceId: string, designs: DesignLink[]): DesignLink[] {
  patchWorkspace(workspaceId, { designs })
  return designs
}

/** A readable title for a link: the canvas name is not in the URL, so "Claude Design canvas" plus its id's start. */
function titleFor(url: string): string {
  try {
    const u = new URL(url)
    const id = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return /claude\.ai$/.test(u.hostname) ? `Claude Design canvas ${id.slice(0, 6)}` : u.hostname
  } catch {
    return 'Design'
  }
}

export function isDesignUrl(text: string): boolean {
  return /^https:\/\/claude\.ai\/(artifact|design|code\/artifact)\//.test(text)
}

export function link(workspaceId: string, url: string, title?: string): DesignLink[] {
  const clean = url.trim()
  let u: URL
  try {
    u = new URL(clean)
  } catch {
    throw new Error('That is not a link. Copy the canvas link from Claude Design (Share, Copy link).')
  }
  if (u.protocol !== 'https:') throw new Error('Use the https link of the design.')
  const designs = list(workspaceId)
  if (designs.some((d) => d.url === clean)) return designs
  return save(workspaceId, [...designs, { id: nanoid(8), title: title?.trim() || titleFor(clean), url: clean, linkedAt: new Date().toISOString(), files: [] }])
}

/** Pick exported artboards (PNG, JPG, WebP, PDF) and attach them to a design, or to a new one. */
export async function addFiles(workspaceId: string, designId?: string): Promise<DesignLink[]> {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Add exported artboards', buttonLabel: 'Add', filters: [{ name: 'Artboards', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf'] }] })
  if (r.canceled || !r.filePaths.length) return list(workspaceId)
  return attach(workspaceId, r.filePaths, designId)
}

/** Artboards dropped or pasted on the Design pane arrive as bytes: write them to a temporary folder and attach them. */
export function addData(workspaceId: string, files: { name: string; data: string }[], designId?: string): DesignLink[] {
  const tmp = join(app.getPath('temp'), 'sinfonie-design-drop', nanoid(6))
  mkdirSync(tmp, { recursive: true })
  const paths = files.slice(0, 20).map((f) => {
    const p = join(tmp, basename(f.name) || 'artboard.png')
    writeFileSync(p, Buffer.from(f.data, 'base64'))
    return p
  })
  try {
    return attach(workspaceId, paths, designId)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Copy files into the app's data folder and attach them. */
export function attach(workspaceId: string, paths: string[], designId?: string): DesignLink[] {
  const files: DesignFile[] = []
  for (const p of paths) {
    const ext = extname(p).toLowerCase()
    const id = nanoid(10)
    if (IMAGE_TYPES[ext]) {
      const file = `design-${id}${ext === '.jpeg' ? '.jpg' : ext}`
      const dest = join(dirFor('images', workspaceId), file)
      copyFileSync(p, dest)
      files.push({ id, name: basename(p), kind: 'image', mimeType: IMAGE_TYPES[ext], path: dest, url: `${SCHEME}://images/${workspaceId}/${file}` })
    } else if (ext === '.pdf') {
      const dest = join(dirFor('designs', workspaceId), `${id}.pdf`)
      copyFileSync(p, dest)
      files.push({ id, name: basename(p), kind: 'pdf', mimeType: 'application/pdf', path: dest })
    }
  }
  if (!files.length) throw new Error('Add PNG, JPG, WebP or PDF exports of the artboards.')
  const designs = list(workspaceId)
  const target = designs.find((d) => d.id === designId)
  if (target) return save(workspaceId, designs.map((d) => (d.id === target.id ? { ...d, files: [...d.files, ...files] } : d)))
  const title = files[0].name.replace(/\.[^.]+$/, '')
  return save(workspaceId, [...designs, { id: nanoid(8), title, linkedAt: new Date().toISOString(), files }])
}

export function update(workspaceId: string, designId: string, patch: { title?: string; notes?: string; url?: string }): DesignLink[] {
  return save(
    workspaceId,
    list(workspaceId).map((d) => (d.id === designId ? { ...d, ...(patch.title !== undefined ? { title: patch.title.trim() || d.title } : {}), ...(patch.notes !== undefined ? { notes: patch.notes } : {}), ...(patch.url !== undefined ? { url: patch.url.trim() || undefined } : {}) } : d))
  )
}

function dropFile(f: DesignFile): void {
  try {
    rmSync(f.path, { force: true })
  } catch {
    /* already gone */
  }
}

export function removeFile(workspaceId: string, designId: string, fileId: string): DesignLink[] {
  return save(
    workspaceId,
    list(workspaceId).map((d) => {
      if (d.id !== designId) return d
      const f = d.files.find((x) => x.id === fileId)
      if (f) dropFile(f)
      return { ...d, files: d.files.filter((x) => x.id !== fileId) }
    })
  )
}

/** Unlinks the design; the copies Sinfonie made of its artboards go with it (the originals are untouched). */
export function remove(workspaceId: string, designId: string): DesignLink[] {
  const d = list(workspaceId).find((x) => x.id === designId)
  for (const f of d?.files ?? []) dropFile(f)
  return save(
    workspaceId,
    list(workspaceId).filter((x) => x.id !== designId)
  )
}

export async function openFile(workspaceId: string, designId: string, fileId: string): Promise<void> {
  const f = list(workspaceId)
    .find((d) => d.id === designId)
    ?.files.find((x) => x.id === fileId)
  if (!f) throw new Error('That file is no longer attached.')
  const err = await shell.openPath(f.path)
  if (err) throw new Error(err)
}

/** Appends where an artboard maps (from the agent's tool, or the person) to the design's notes. */
export function remember(workspaceId: string, note: string, designTitle?: string): string {
  const designs = list(workspaceId)
  if (!designs.length) return 'No design is linked to this workspace.'
  const want = designTitle?.trim().toLowerCase()
  const d = (want && designs.find((x) => x.title.toLowerCase() === want)) || (want && designs.find((x) => x.title.toLowerCase().includes(want))) || designs[designs.length - 1]
  const line = note.trim()
  if (!line) return 'Nothing to remember.'
  update(workspaceId, d.id, { notes: [d.notes?.trim(), line].filter(Boolean).join('\n') })
  return `Saved on the design "${d.title}".`
}

/** The message "Build this design" sends: what to build, the artboards as images, and how to map them. */
export function brief(workspaceId: string, designId: string, extra?: string): { text: string; images: ChatImageInput[] } {
  const d = list(workspaceId).find((x) => x.id === designId)
  if (!d) throw new Error('That design is no longer linked.')
  const imgs = d.files.filter((f) => f.kind === 'image' && existsSync(f.path)).slice(0, BRIEF_MAX_IMAGES)
  const pdfs = d.files.filter((f) => f.kind === 'pdf' && existsSync(f.path))
  if (!imgs.length && !pdfs.length && !d.url) throw new Error('Add the exported artboards (or the canvas link) first.')
  const images: ChatImageInput[] = imgs.map((f) => {
    let img = nativeImage.createFromPath(f.path)
    const { width, height } = img.getSize()
    const edge = Math.max(width, height)
    if (edge > BRIEF_EDGE) img = img.resize(width >= height ? { width: BRIEF_EDGE, quality: 'best' } : { height: BRIEF_EDGE, quality: 'best' })
    return { name: f.name, mimeType: 'image/png', data: img.toPNG().toString('base64') }
  })
  const lines = [
    `Build this design: "${d.title}".`,
    d.url ? `Canvas: ${d.url} (a Claude Design canvas; you cannot open it, so work from the attached artboards).` : '',
    imgs.length ? `Attached: ${imgs.length} exported artboard${imgs.length === 1 ? '' : 's'} (${imgs.map((f) => f.name).join(', ')}).` : '',
    pdfs.length ? `Exported PDF${pdfs.length === 1 ? '' : 's'} to read with the Read tool: ${pdfs.map((f) => f.path).join(', ')}.` : '',
    d.notes?.trim() ? `What we know about where these screens go:\n${d.notes.trim()}` : '',
    extra?.trim() ? `From me: ${extra.trim()}` : '',
    '',
    "Implement what these screens show in this workspace, reusing the app's existing components and styles. Match the layout, text, spacing and colours as drawn.",
    'Before writing code, if it is not clear which repository and route or component each artboard maps to, ask me once (with your best guess). When you know, record it with mcp__workspace__remember_design_mapping so the next round starts from it.',
    'When you finish, say which artboard maps to which screen, and anything you could not match.'
  ]
  save(
    workspaceId,
    list(workspaceId).map((x) => (x.id === d.id ? { ...x, sentAt: new Date().toISOString() } : x))
  )
  return { text: lines.filter((l, i) => l || lines[i - 1]).join('\n'), images }
}

/** One line for the agent's system prompt when designs are linked. */
export function promptFor(workspaceId: string): string {
  const designs = list(workspaceId)
  if (!designs.length) return ''
  return `Designs linked to this workspace (Design tab): ${designs.map((d) => `"${d.title}"${d.files.length ? ` (${d.files.length} artboard${d.files.length === 1 ? '' : 's'})` : ''}`).join(', ')}. The person sends them with "Build this design". When you learn which repository, route or component an artboard maps to, record it with mcp__workspace__remember_design_mapping.`
}
