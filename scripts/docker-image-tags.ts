const releaseTagPrefix = 'refs/tags/@pascal-app/cli@'
const packageVersion = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/

export function dockerImageTag(repository: string, ref: string): string {
  const name = repository.toLowerCase()
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) {
    throw new Error('Invalid GitHub repository')
  }

  if (ref === 'refs/heads/main') return `ghcr.io/${name}:latest`

  if (ref.startsWith(releaseTagPrefix)) {
    const version = ref.slice(releaseTagPrefix.length)
    if (!packageVersion.test(version)) throw new Error('Invalid editor release ref')
    return `ghcr.io/${name}:${version}`
  }

  throw new Error('Unsupported Docker publish ref')
}

if (import.meta.main) {
  console.log(`tags=${dockerImageTag(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_REF ?? '')}`)
}
