/** Host authorization is required before a DeepZoom export allocates render or file resources. */
export type GigapixelExportDenialCode =
  | 'no_project'
  | 'permission_denied'
  | 'export_unavailable'

export class GigapixelExportDenied extends Error {
  readonly code: GigapixelExportDenialCode

  constructor(code: GigapixelExportDenialCode, message: string) {
    super(code + ': ' + message)
    this.name = 'GigapixelExportDenied'
    this.code = code
  }
}

export interface GigapixelExportGrant {
  projectId: string
  directory: FileSystemDirectoryHandle
}

export type GigapixelExportDecision =
  | ({ status: 'authorized' } & GigapixelExportGrant)
  | { status: 'denied'; code: 'permission_denied' | 'export_unavailable' }

/**
 * The trusted host checks the current user's export permission and supplies a
 * project-bound writable directory. Neither a capture event's projectId nor
 * origin-private browser storage is evidence of export permission.
 */
export type AuthorizeGigapixelExport = (
  projectId: string,
) => GigapixelExportDecision | Promise<GigapixelExportDecision>

export function assertGigapixelExportStillActive(
  grant: Pick<GigapixelExportGrant, 'projectId'>,
  currentProjectId: () => string | null | undefined,
): void {
  const current = currentProjectId()
  if (!current) {
    throw new GigapixelExportDenied('no_project', 'No active project for DeepZoom export')
  }
  if (current !== grant.projectId) {
    throw new GigapixelExportDenied(
      'permission_denied',
      'The active project changed during DeepZoom export',
    )
  }
}

/** Fail closed before staging or reading a single tile, including across async host checks. */
export async function requireGigapixelExportAuthority(
  currentProjectId: () => string | null | undefined,
  requestedProjectId: string | null | undefined,
  authorize: AuthorizeGigapixelExport | undefined,
): Promise<GigapixelExportGrant> {
  const projectId = currentProjectId()
  if (!projectId) {
    throw new GigapixelExportDenied('no_project', 'No active project for DeepZoom export')
  }
  if (requestedProjectId != null && requestedProjectId !== projectId) {
    throw new GigapixelExportDenied('permission_denied', 'The requested project is not active')
  }
  if (!authorize) {
    throw new GigapixelExportDenied(
      'export_unavailable',
      'This host has not enabled project-authorized DeepZoom export',
    )
  }

  let decision: GigapixelExportDecision
  try {
    decision = await authorize(projectId)
  } catch {
    throw new GigapixelExportDenied(
      'export_unavailable',
      'The host could not verify DeepZoom export authority',
    )
  }
  assertGigapixelExportStillActive({ projectId }, currentProjectId)

  if (decision?.status !== 'authorized') {
    if (decision?.status === 'denied' && decision.code === 'permission_denied') {
      throw new GigapixelExportDenied('permission_denied', 'DeepZoom export was denied by the host')
    }
    throw new GigapixelExportDenied('export_unavailable', 'DeepZoom export is unavailable')
  }
  if (decision.projectId !== projectId) {
    throw new GigapixelExportDenied('permission_denied', 'The grant is for a different project')
  }
  const directory = decision.directory
  if (
    !directory ||
    directory.kind !== 'directory' ||
    typeof directory.getDirectoryHandle !== 'function' ||
    typeof directory.getFileHandle !== 'function' ||
    typeof directory.removeEntry !== 'function'
  ) {
    throw new GigapixelExportDenied(
      'export_unavailable',
      'The host did not grant a writable DeepZoom destination',
    )
  }
  return { projectId, directory }
}
