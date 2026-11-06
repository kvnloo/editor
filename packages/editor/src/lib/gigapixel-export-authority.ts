// The editor and headless agent surfaces use one host-owned permission gate.
export {
  assertGigapixelExportStillActive,
  type AuthorizeGigapixelExport,
  GigapixelExportDenied,
  type GigapixelExportDecision,
  type GigapixelExportDenialCode,
  type GigapixelExportGrant,
  requireGigapixelExportAuthority,
} from '@pascal-app/core/agent-operations'
