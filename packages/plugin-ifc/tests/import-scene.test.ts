import { describe, expect, it } from 'bun:test'
import { BuildingNode, SiteNode } from '@pascal-app/core'
import type { PascalSceneGraph } from '@pascal-app/ifc-converter'
import { createIfcImportOperations } from '@pascal-app/plugin-ifc'

function twoNodeGraph(siteName: string, buildingName: string): PascalSceneGraph {
  const site = SiteNode.parse({
    id: 'site_1',
    name: siteName,
    children: ['building_1'],
    metadata: {
      sourceId: 'building_1',
      note: 'building_1',
      nested: { nodeIds: ['building_1'], displayName: 'building_1' },
    },
  })
  const building = BuildingNode.parse({
    id: 'building_1',
    name: buildingName,
    parentId: site.id,
  })
  return {
    rootNodeIds: [site.id],
    nodes: { [site.id]: site, [building.id]: building } as PascalSceneGraph['nodes'],
  }
}

describe('createIfcImportOperations', () => {
  it('gives imported nodes fresh ids and keeps the hierarchy and cross references', () => {
    const graph = {
      rootNodeIds: ['site_1'],
      nodes: {
        site_1: { id: 'site_1', type: 'site', children: ['building_1'] },
        building_1: { id: 'building_1', type: 'building', parentId: 'site_1', children: ['level_1'] },
        level_1: { id: 'level_1', type: 'level', parentId: 'building_1', children: [] },
      },
    } as unknown as PascalSceneGraph

    const operations = createIfcImportOperations(graph, 'abc123')
    const [site, building, level] = operations

    expect(site?.node.id).toBe('site_1_imp_abc123')
    expect(site?.parentId).toBeUndefined()
    expect(building?.node.id).toBe('building_1_imp_abc123')
    expect(building?.parentId).toBe('site_1_imp_abc123')
    expect((site?.node as { children: string[] }).children).toEqual(['building_1_imp_abc123'])
    expect(level?.parentId).toBe('building_1_imp_abc123')
  })

  it('keeps orphaned and unlisted nodes instead of silently dropping them', () => {
    const graph = {
      rootNodeIds: ['site_1'],
      nodes: {
        site_1: { id: 'site_1', type: 'site', children: [] },
        imported_1: { id: 'imported_1', type: 'imported-mesh', metadata: { sourceId: 'site_1' } },
      },
    } as unknown as PascalSceneGraph

    const operations = createIfcImportOperations(graph, 'token')
    expect(operations).toHaveLength(2)
    expect(operations[1]?.parentId).toBeUndefined()
    expect((operations[1]?.node.metadata as { sourceId: string }).sourceId).toBe('site_1_imp_token')
  })

  it('preserves display names even when they equal source ids', () => {
    const operations = createIfcImportOperations(twoNodeGraph('site_1', 'building_1'), 't')
    expect(operations.map(({ node }) => node.name)).toEqual(['site_1', 'building_1'])
  })

  it('preserves ordinary human-readable display names', () => {
    const operations = createIfcImportOperations(twoNodeGraph('Campus', 'Block A'), 't')
    expect(operations.map(({ node }) => node.name)).toEqual(['Campus', 'Block A'])
  })

  it('remaps node ids, hierarchy and known nested references without changing text', () => {
    const operations = createIfcImportOperations(twoNodeGraph('site_1', 'building_1'), 't')
    expect(operations).toHaveLength(2)
    const [site, building] = operations
    expect(site?.node.id).toBe('site_1_imp_t')
    expect(building?.node.id).toBe('building_1_imp_t')
    expect(building?.parentId).toBe('site_1_imp_t')
    expect(building?.node.parentId).toBe('site_1_imp_t')
    if (site?.node.type !== 'site') throw new Error('Missing imported site')
    expect(site.node.children).toEqual(['building_1_imp_t'])
    const metadata = site.node.metadata as {
      sourceId: string
      note: string
      nested: { nodeIds: string[]; displayName: string }
    }
    expect(metadata.sourceId).toBe('building_1_imp_t')
    expect(metadata.nested.nodeIds).toEqual(['building_1_imp_t'])
    expect(metadata.note).toBe('building_1')
    expect(metadata.nested.displayName).toBe('building_1')
  })
})
