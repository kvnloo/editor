import { z } from 'zod'

/** One tool contract for hosted chat and the MCP server; permissions belong to the host. */
export const exportGigapixelTool = {
  name: 'export_gigapixel',
  title: 'Export DeepZoom ZIP',
  description:
    'Export the active project as a tiled DeepZoom ZIP through its open editor. The trusted host must grant export permission and a project-bound writable destination before any rendering or file staging. Omit projectId for the active project; another project is refused. The result names the saved ZIP and its SHA-256. Refusals: no_project, permission_denied, export_unavailable. This is not a regular image snapshot.',
  input: {
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('Hosted project ID; omit to use the host-verified active project.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const
