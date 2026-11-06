import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { WallNode } from '@pascal-app/core/schema'
import { createPascalMcpServer, SceneBridge } from '@pascal-app/mcp'

type ItemReadback = {
  node: {
    asset: {
      id: string
      category: string
      attachTo?: string
      dimensions: [number, number, number]
      offset: [number, number, number]
      src: string
      thumbnail: string
      floorPlanUrl?: string
    }
    position: [number, number, number]
    wallId?: string
    wallT?: number
  }
}

test('the public MCP wire places the urinal at both mounting heights', async () => {
  const bridge = new SceneBridge()
  bridge.setScene({}, [])
  bridge.loadDefault()

  const level = Object.values(bridge.getNodes()).find((node) => node.type === 'level')
  expect(level).toBeDefined()
  const wall = WallNode.parse({ start: [0, 0], end: [5, 0] })
  bridge.createNode(wall, level!.id)

  const server = createPascalMcpServer({ bridge })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'urinal-catalog-contract-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const topHeights: number[] = []

    for (const height of [0.45, 1.27]) {
      const placed = await client.callTool({
        name: 'place_item',
        arguments: {
          catalogItemId: 'urinal',
          targetNodeId: wall.id,
          position: [2, height, 0],
        },
      })
      expect(placed.isError).toBeFalsy()
      const receipt = JSON.parse(
        (placed.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { itemId: string; status: string }
      expect(receipt.status).toBe('ok')

      const readback = await client.callTool({
        name: 'get_node',
        arguments: { id: receipt.itemId },
      })
      expect(readback.isError).toBeFalsy()
      const { node } = JSON.parse(
        (readback.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as ItemReadback

      expect(node.asset).toMatchObject({
        id: 'urinal',
        category: 'bathroom',
        attachTo: 'wall-side',
        dimensions: [0.4, 0.65, 0.35],
        offset: [0, 0, 0],
        src: '/items/urinal/model.glb',
        thumbnail: '/items/urinal/thumbnail.png',
        floorPlanUrl: '/items/urinal/floor-plan.png',
      })
      expect(node.wallId).toBe(wall.id)
      expect(node.wallT).toBeCloseTo(0.4, 8)
      expect(node.position).toEqual([2, height, 0])
      topHeights.push(node.position[1] + node.asset.dimensions[1])
    }

    expect(topHeights[0]).toBeCloseTo(1.1, 8)
    expect(topHeights[1]).toBeCloseTo(1.92, 8)
    expect(topHeights[1]! - topHeights[0]!).toBeCloseTo(0.82, 8)
  } finally {
    await client.close()
    await server.close()
  }
})
