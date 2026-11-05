import type { McpServer } from '@modelcontextprotocol/server'
import {
  executeHostedServiceTool,
  type HostedServiceExecutor,
} from '@pascal-app/core/agent-operations'
import {
  type AgentToolContract,
  HOSTED_SERVICE_TOOL_CONTRACTS,
  isAgentRefusal,
  refusalPayload,
} from '@pascal-app/core/agent-tools'
import { z } from 'zod'

export function registerHostedServiceTools(
  server: McpServer,
  execute: HostedServiceExecutor,
): void {
  for (const contract of HOSTED_SERVICE_TOOL_CONTRACTS) {
    const output = (contract as AgentToolContract).output
    server.registerTool(
      contract.name,
      {
        title: contract.title,
        description: contract.description,
        inputSchema: z.object(contract.input).strict(),
        ...(output ? { outputSchema: output } : {}),
        annotations: contract.annotations,
      },
      async (input: Record<string, unknown>, ctx) => {
        try {
          const result = await executeHostedServiceTool(
            contract.name,
            input,
            execute,
            ctx.mcpReq.signal,
          )
          // A render's preview, inline in the result, is the picture the client shows the model.
          const { preview, ...rest } = (result ?? {}) as { preview?: unknown }
          const picture =
            typeof preview === 'string' ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(preview) : null
          if (!picture)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              ...(output ? { structuredContent: result as Record<string, unknown> } : {}),
            }
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(rest) },
              { type: 'image' as const, data: picture[2]!, mimeType: picture[1]! },
            ],
            ...(output ? { structuredContent: rest } : {}),
          }
        } catch (error) {
          const result = isAgentRefusal(error)
            ? refusalPayload(error)
            : {
                error:
                  'Pascal could not complete this service request. Check its retained result before repeating paid work.',
                code: 'service_error',
              }
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          }
        }
      },
    )
  }
}
