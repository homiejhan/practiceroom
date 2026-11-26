/**
 * Getting a picture ready for the board, in the browser.
 *
 * Whatever the tutor picks, pastes or drops (a screenshot, a phone photo of a
 * homework page) is decoded, scaled down to a sensible size and re-encoded
 * before it is uploaded. That keeps uploads small, strips metadata such as a
 * photo's location, and means only plain PNG or JPEG bytes ever reach storage.
 */

/** Longest side kept, in pixels: sharp when zoomed in, still a small file. */
const MAX_SIDE = 1800
/** The upload action's limit on the encoded image (base64 characters). */
export const MAX_IMAGE_CHARS = 2_800_000
/** PNG stays sharp for screenshots; past this size the picture is a photo and JPEG is far smaller. */
const PNG_CHARS = 1_200_000

export interface PreparedImage {
  dataUrl: string
  width: number
  height: number
}

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * @throws when the file is not an image this browser can open, or cannot be
 *         made small enough to upload.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const image = await decode(file)
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (!naturalWidth || !naturalHeight) throw new Error('empty image')

  let scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight))
  for (let attempt = 0; attempt < 4; attempt++) {
    const width = Math.max(1, Math.round(naturalWidth * scale))
    const height = Math.max(1, Math.round(naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    // White behind transparent screenshots, so ink drawn over them stays readable.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image, 0, 0, width, height)

    const png = canvas.toDataURL('image/png')
    if (png.length <= PNG_CHARS) return { dataUrl: png, width, height }
    const jpeg = canvas.toDataURL('image/jpeg', 0.86)
    if (jpeg.length <= MAX_IMAGE_CHARS) return { dataUrl: jpeg, width, height }
    scale *= 0.7
  }
  throw new Error('image too large')
}

/** The image files in a paste or a drop, if there are any. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length) return files
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'))
}
