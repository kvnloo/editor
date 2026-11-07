import type { McpServer } from '@modelcontextprotocol/server'
import {
  executeGigapixelExport,
  type GigapixelExportHost,
} from '@pascal-app/core/agent-operations'
import {
  exportGigapixelTool,
  isAgentRefusal,
  refusalPayload,
} from '@pascal-app/core/agent-tools'
import { z } from 'zod'

/** The MCP is headless: the same trusted editor host must render and authorize as in chat. */
export function registerExportGigapixel(
  server: McpServer,
  host?: GigapixelExportHost,
): void {
  server.registerTool(
    exportGigapixelTool.name,
    {
      title: exportGigapixelTool.title,
      description: exportGigapixelTool.description,
      inputSchema: z.object(exportGigapixelTool.input).strict(),
      annotations: exportGigapixelTool.annotations,
    },
    async (input, ctx) => {
      try {
        const payload = await executeGigapixelExport(input, host, ctx.mcpReq.signal)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        }
      } catch (error) {
        if (!isAgentRefusal(error)) throw error
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(refusalPayload(error)) }],
        }
      }
    },
  )
}
