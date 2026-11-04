import { describe, expect, test } from 'bun:test'
import { dockerImageTag } from './docker-image-tags'

describe('Docker images publish in their repository namespace', () => {
  test('main publishes latest for the current repository, including a fork', () => {
    expect(dockerImageTag('pascalorg/editor', 'refs/heads/main')).toBe(
      'ghcr.io/pascalorg/editor:latest',
    )
    expect(dockerImageTag('kvnloo/Editor-Fork', 'refs/heads/main')).toBe(
      'ghcr.io/kvnloo/editor-fork:latest',
    )
  })

  test('CLI release tags publish their version, including beta versions', () => {
    expect(dockerImageTag('kvnloo/editor', 'refs/tags/@pascal-app/cli@2.10.3')).toBe(
      'ghcr.io/kvnloo/editor:2.10.3',
    )
    expect(dockerImageTag('kvnloo/editor', 'refs/tags/@pascal-app/cli@2.10.3-beta.12')).toBe(
      'ghcr.io/kvnloo/editor:2.10.3-beta.12',
    )
  })

  test('pull requests, unrelated branches and non-release tags cannot publish', () => {
    for (const ref of [
      'refs/pull/7/merge',
      'refs/heads/feature',
      'refs/tags/v2.10.3',
    ]) {
      expect(() => dockerImageTag('kvnloo/editor', ref)).toThrow('Unsupported Docker publish ref')
    }
  })

  test('malformed release versions and repository names fail closed', () => {
    expect(() => dockerImageTag('kvnloo/editor', 'refs/tags/@pascal-app/cli@2.10.3;evil')).toThrow(
      'Invalid editor release ref',
    )
    expect(() => dockerImageTag('kvnloo', 'refs/heads/main')).toThrow('Invalid GitHub repository')
    expect(() => dockerImageTag('kvnloo/editor other', 'refs/heads/main')).toThrow(
      'Invalid GitHub repository',
    )
  })
})
