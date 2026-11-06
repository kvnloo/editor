import {
  executeGigapixelExport,
  type GigapixelExportHost,
} from '@pascal-app/core/agent-operations'

/** Hosted command entry: the editor host supplies its existing export authority and renderer. */
export function runHostedGigapixelExport(
  input: unknown,
  host: GigapixelExportHost | undefined,
  signal?: AbortSignal,
) {
  return executeGigapixelExport(input, host, signal)
}

export type { GigapixelExportArtifact, GigapixelExportHost } from '@pascal-app/core/agent-operations'
