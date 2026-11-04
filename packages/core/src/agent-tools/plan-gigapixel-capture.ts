import { z } from 'zod'

export const planGigapixelCaptureSchema = z.object({
  width: z
    .int()
    .positive()
    .optional()
    .describe('Image width in pixels. Provide with height, or with megapixels to derive height.'),
  height: z
    .int()
    .positive()
    .optional()
    .describe('Image height in pixels. Provide with width, or with megapixels to derive width.'),
  megapixels: z
    .number()
    .positive()
    .optional()
    .describe(
      'Target area in millions of pixels. Alone, derive a square image. With one dimension, round the other up. Do not also specify both width and height.',
    ),
  tileSize: z.int().positive().default(512).describe('DeepZoom tile edge in pixels. Default 512.'),
  overlap: z
    .int()
    .nonnegative()
    .default(1)
    .describe('Overlap in pixels on each interior edge, at most tileSize. Default 1.'),
  format: z
    .enum(['webp', 'png', 'jpeg'])
    .default('webp')
    .describe('Tile format named in the DZI descriptor. Default webp.'),
})

export type PlanGigapixelCaptureInput = z.infer<typeof planGigapixelCaptureSchema>

export const planGigapixelCaptureTool = {
  name: 'plan_gigapixel_capture',
  title: 'Plan gigapixel capture',
  description:
    'Plan a Microsoft DeepZoom (DZI) onepixel-depth pyramid without rendering or changing the scene. Supply width and height in pixels, megapixels for a square image, or megapixels plus one dimension to derive the other. Returns sizes and tile counts at every level, total tiles, DZI XML, and the total raw 8-bit RGBA tile bytes including overlap (not compressed WebP/PNG/JPEG file size). Defaults: tileSize 512, overlap 1, format webp. Refusals: dimensions_required, dimensions_conflict, invalid_tile_overlap, capture_plan_too_large.',
  input: planGigapixelCaptureSchema.shape,
}
