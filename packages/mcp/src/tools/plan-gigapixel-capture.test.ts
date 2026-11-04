import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { createPascalMcpServer } from '@pascal-app/mcp/server'

type ToolResult = {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createPascalMcpServer({ bridge: new SceneBridge() })
  const client = new Client({ name: 'gigapixel-plan-test', version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

async function plan(client: Client, args: Record<string, unknown>) {
  const response = (await client.callTool({
    name: 'plan_gigapixel_capture',
    arguments: args,
  })) as ToolResult
  return {
    response,
    data: (response.structuredContent ??
      JSON.parse(response.content[0]!.text)) as Record<string, unknown>,
  }
}

describe('plan_gigapixel_capture through a real MCP client', () => {
  test('lists a read-only tool and plans default DeepZoom with overlapped RGBA bytes', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools()
      const tool = tools.tools.find((entry) => entry.name === 'plan_gigapixel_capture')
      expect(tool).toBeDefined()
      expect(tool?.annotations?.readOnlyHint).toBe(true)
      const { response, data } = await plan(client, { width: 1024, height: 512 })
      expect(response.isError).toBeFalsy()
      expect(data).toMatchObject({
        width: 1024,
        height: 512,
        tileSize: 512,
        overlap: 1,
        format: 'webp',
        maxLevel: 10,
        levelCount: 11,
        totalTiles: 12,
        estimatedBytes: 2_800_300,
        estimateBasis: 'raw_rgba_tiles_including_overlap',
      })
      const levels = data.levels as Array<Record<string, number>>
      expect(levels).toHaveLength(11)
      expect(levels[0]).toEqual({
        level: 0,
        width: 1,
        height: 1,
        columns: 1,
        rows: 1,
        tileCount: 1,
      })
      expect(levels[9]).toEqual({
        level: 9,
        width: 512,
        height: 256,
        columns: 1,
        rows: 1,
        tileCount: 1,
      })
      expect(levels[10]).toEqual({
        level: 10,
        width: 1024,
        height: 512,
        columns: 2,
        rows: 1,
        tileCount: 2,
      })
      expect(data.dzi).toContain('TileSize="512" Overlap="1" Format="webp"')
      expect(data.dzi).toContain('Width="1024" Height="512"')
    })
  })

  test('derives square or aspect-preserving dimensions from megapixels', async () => {
    await withClient(async (client) => {
      const square = await plan(client, { megapixels: 1, format: 'png' })
      expect(square.response.isError).toBeFalsy()
      expect(square.data).toMatchObject({
        width: 1000,
        height: 1000,
        maxLevel: 10,
        levelCount: 11,
        totalTiles: 14,
        format: 'png',
      })
      const rectangle = await plan(client, {
        width: 800,
        megapixels: 1,
        tileSize: 256,
        overlap: 0,
        format: 'jpeg',
      })
      expect(rectangle.response.isError).toBeFalsy()
      expect(rectangle.data).toMatchObject({
        width: 800,
        height: 1250,
        tileSize: 256,
        overlap: 0,
        format: 'jpeg',
      })
      expect((rectangle.data.levels as Array<{ tileCount: number }>).at(-1)?.tileCount).toBe(20)
      const single = await plan(client, { megapixels: 0.000001 })
      expect(single.data).toMatchObject({
        width: 1,
        height: 1,
        levelCount: 1,
        totalTiles: 1,
        estimatedBytes: 4,
      })
    })
  })

  test('clips a narrow final tile without a canvas or scene', async () => {
    await withClient(async (client) => {
      const { response, data } = await plan(client, { width: 513, height: 1 })
      expect(response.isError).toBeFalsy()
      expect(data).toMatchObject({ levelCount: 11, totalTiles: 12, estimatedBytes: 4_144 })
      expect((data.levels as Array<{ tileCount: number }>).at(-1)?.tileCount).toBe(2)
    })
  })

  test('refuses missing, conflicting, invalid tile, and unsafe dimensions', async () => {
    await withClient(async (client) => {
      for (const [args, code] of [
        [{ width: 512 }, 'dimensions_required'],
        [{ width: 512, height: 512, megapixels: 1 }, 'dimensions_conflict'],
        [{ width: 512, height: 512, tileSize: 1, overlap: 2 }, 'invalid_tile_overlap'],
        [{ width: Number.MAX_SAFE_INTEGER, height: 2 }, 'capture_plan_too_large'],
      ] as const) {
        const { response, data } = await plan(client, args)
        expect(response.isError).toBe(true)
        expect(data.code).toBe(code)
      }
      const invalid = await plan(client, { width: 0, height: 512 })
      expect(invalid.response.isError).toBe(true)
      expect(JSON.stringify(invalid.response)).toContain('invalid_input')
    })
  })
})
