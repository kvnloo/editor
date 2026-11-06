import { z } from 'zod'
import { exportGigapixelTool } from '../agent-tools/gigapixel-export'
import { AgentRefusal, isAgentRefusal } from '../agent-tools/refusal'
import {
  assertGigapixelExportStillActive,
  type AuthorizeGigapixelExport,
  GigapixelExportDenied,
  type GigapixelExportGrant,
  requireGigapixelExportAuthority,
} from './gigapixel-export-authority'

const artifactSchema = z
  .object({
    fileName: z.string().min(1).max(255).endsWith('.zip'),
    mimeType: z.literal('application/zip'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    tileCount: z.number().int().positive(),
  })
  .strict()

export type GigapixelExportArtifact = z.infer<typeof artifactSchema>

export type GigapixelExportHost = {
  /** The trusted host's active project, not the agent's supplied project ID. */
  getActiveProjectId(): string | null | undefined
  /** Same host authorizer used by the editor's regular oversized snapshot path. */
  authorizeGigapixelExport?: AuthorizeGigapixelExport
  /**
   * Captures with the existing editor/ZIP pipeline, using only the granted destination.
   * Check the active project and AbortSignal between readbacks, and roll back on failure.
   */
  exportZip(request: {
    grant: GigapixelExportGrant
    signal?: AbortSignal
  }): Promise<GigapixelExportArtifact>
}

/**
 * Both agent surfaces call this operation. The host grants before a renderer or staging
 * is invoked; no MCP-specific permission path, agent-provided directory, or Blob fallback.
 */
export async function executeGigapixelExport(
  rawInput: unknown,
  host: GigapixelExportHost | undefined,
  signal?: AbortSignal,
): Promise<GigapixelExportArtifact & { status: 'exported'; projectId: string }> {
  const parsed = z.object(exportGigapixelTool.input).strict().safeParse(rawInput)
  if (!parsed.success) {
    throw new AgentRefusal('invalid_input', 'Invalid DeepZoom export input.', {
      issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    })
  }
  if (!host) {
    throw new AgentRefusal(
      'export_unavailable',
      'This server has no trusted editor host for DeepZoom export.',
    )
  }

  try {
    signal?.throwIfAborted()
    const currentProjectId = () => host.getActiveProjectId()
    const grant = await requireGigapixelExportAuthority(
      currentProjectId,
      parsed.data.projectId,
      host.authorizeGigapixelExport,
    )
    signal?.throwIfAborted()
    assertGigapixelExportStillActive(grant, currentProjectId)
    const artifact = await host.exportZip({ grant, signal })
    assertGigapixelExportStillActive(grant, currentProjectId)
    signal?.throwIfAborted()
    const valid = artifactSchema.safeParse(artifact)
    if (!valid.success) {
      throw new AgentRefusal(
        'export_unavailable',
        'The editor host did not confirm a completed DeepZoom ZIP artifact.',
      )
    }
    return { status: 'exported', projectId: grant.projectId, ...valid.data }
  } catch (error) {
    if (error instanceof GigapixelExportDenied) {
      throw new AgentRefusal(error.code, error.message)
    }
    if (isAgentRefusal(error)) throw error
    throw new AgentRefusal(
      'export_unavailable',
      'The editor host could not complete the DeepZoom ZIP export.',
    )
  }
}
