/** Turn a pasted or dropped file into something the models accept: PNG/JPEG/GIF/WebP, at most ~2000 px on the long side. */
export interface PendingImage {
  id: string
  name: string
  mimeType: string
  /** base64, no data: prefix */
  data: string
  preview: string
}

const OK = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_SIDE = 2000
const MAX_BYTES = 4 * 1024 * 1024

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export interface PrepareOptions {
  /** Long-side cap in pixels (default 2000). */
  maxSide?: number
  /** Re-encode above this many bytes (default 4 MB). */
  maxBytes?: number
}

export async function prepareImage(file: File | Blob, name = 'image', opts: PrepareOptions = {}): Promise<PendingImage> {
  const maxSide = opts.maxSide ?? MAX_SIDE
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let blob: Blob = file
  let mimeType = file.type
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error(`${name} is not an image the app can read.`)
  const tooBig = bitmap.width > maxSide || bitmap.height > maxSide || file.size > maxBytes || !OK.has(mimeType)
  if (tooBig) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // PNG keeps screenshots crisp; anything big or exotic goes to JPEG.
    const keepPng = mimeType === 'image/png' && file.size <= maxBytes
    const encode = (type: string, q: number): Promise<Blob> => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q))
    blob = await encode(keepPng ? 'image/png' : 'image/jpeg', 0.86)
    // Tight budgets (feedback screenshots) get one more squeeze.
    if (blob.size > maxBytes) blob = await encode('image/jpeg', 0.7)
    mimeType = blob.type
  }
  bitmap.close()
  const data = toBase64(await blob.arrayBuffer())
  return { id: Math.random().toString(36).slice(2, 10), name: name.replace(/\.[^.]+$/, '') + (mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : ''), mimeType, data, preview: URL.createObjectURL(blob) }
}

/** Image files from a paste or drop event, in order. */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) out.push(f)
  return out
}
