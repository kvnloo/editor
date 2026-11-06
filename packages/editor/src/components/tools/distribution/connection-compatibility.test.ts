import { expect, test } from 'bun:test'
import { type NodePort, portConnection } from '@pascal-app/core'
import { connectionCompatibility } from './connection-compatibility'

const supply = { system: 'supply', diameter: 6 }
test('matching profiles report a match', () => {
  expect(connectionCompatibility(supply, { ...supply }).status).toBe('match')
})
test('system mismatch takes precedence over size', () => {
  expect(connectionCompatibility(supply, { system: 'return', diameter: 8 }).status).toBe(
    'incompatible',
  )
  expect(
    connectionCompatibility({ system: 'waste', diameter: 4 }, { system: 'vent', diameter: 4 })
      .status,
  ).toBe('incompatible')
})
test('size and shape mismatches describe the required adapter', () => {
  expect(connectionCompatibility(supply, { ...supply, diameter: 8 }).label).toContain('Reducer')
  expect(
    connectionCompatibility(supply, { ...supply, shape: 'rect', width: 8, height: 6 }).label,
  ).toContain('Transition')
  expect(
    connectionCompatibility(
      { ...supply, shape: 'rect', width: 8, height: 6 },
      { ...supply, shape: 'rect', width: 8, height: 8 },
    ).status,
  ).toBe('adapter')
})
test('missing system or section data cannot claim compatibility', () => {
  expect(connectionCompatibility(supply, { diameter: 6 }).status).toBe('unknown')
  expect(
    connectionCompatibility({ ...supply, shape: 'rect' }, { ...supply, shape: 'rect' }).status,
  ).toBe('unknown')
})

const outlet: NodePort = {
  id: 'out',
  position: [0, 0, 0],
  direction: [1, 0, 0],
  diameter: 8,
  system: 'supply',
}
const inlet: NodePort = { ...outlet, id: 'in', direction: [-1, 0, 0] }

test('physical port proximity includes 5 cm but excludes greater distances', () => {
  expect(portConnection(outlet, { ...inlet, position: [0.05, 0, 0] }).status).toBe('match')
  expect(portConnection(outlet, { ...inlet, position: [0.0501, 0, 0] }).status).toBe(
    'incompatible',
  )
})

test('a size adapter is valid only for opposed ports', () => {
  expect(portConnection(outlet, { ...inlet, diameter: 10 }).status).toBe('adapter')
  expect(
    portConnection(outlet, { ...inlet, diameter: 10, direction: [1, 0, 0] }).status,
  ).toBe('incompatible')
})

test('unknown direction is not a valid adapter recommendation', () => {
  expect(
    portConnection(outlet, { ...inlet, diameter: 10, direction: [0, 0, 0] }).status,
  ).toBe('unknown')
})
