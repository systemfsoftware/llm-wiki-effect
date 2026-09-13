export const AZURE_OPENAI_API_VERSION = '2024-10-21'

export function isAzureOpenAiEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim()
  if (!trimmed) return false
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return url.hostname.toLowerCase().endsWith('.openai.azure.com')
  } catch {
    return /(^|\/\/)[^/?#]+\.openai\.azure\.com(?::\d+)?(?:[/?#]|$)/i.test(trimmed)
  }
}

export interface AzureParsedEndpoint {
  resourceBase: string
  deployment: string
  apiVersion: string
}

/**
 * Parse an Azure resource URL the user may have pasted in any of the
 * common shapes (bare host, host + deployment path, full chat URL).
 * The deployment embedded in the path wins over `fallbackDeployment`.
 */
export function parseAzureOpenAiEndpoint(
  endpoint: string,
  fallbackDeployment: string,
  fallbackApiVersion: string,
): AzureParsedEndpoint | null {
  const trimmed = endpoint.trim()
  if (!isAzureOpenAiEndpoint(trimmed)) return null

  let apiVersion = fallbackApiVersion.trim() || AZURE_OPENAI_API_VERSION
  const queryVersion = trimmed.match(/[?&]api-version=([^&]+)/i)?.[1]
  if (queryVersion !== undefined) apiVersion = decodeURIComponent(queryVersion)

  const withoutQuery = (trimmed.split('?')[0] ?? '').replace(/\/+$/, '')

  const withDeployment = withoutQuery.match(
    /^(https?:\/\/[^/]+\.openai\.azure\.com)\/openai\/deployments\/([^/]+)(?:\/chat\/completions)?$/i,
  )
  const deploymentBase = withDeployment?.[1]
  const deploymentSlug = withDeployment?.[2]
  if (deploymentBase !== undefined && deploymentSlug !== undefined) {
    return {
      resourceBase: deploymentBase,
      deployment: decodeURIComponent(deploymentSlug),
      apiVersion,
    }
  }

  const resourceOnly = withoutQuery.match(/^(https?:\/\/[^/]+\.openai\.azure\.com)(?:\/openai)?$/i)
  if (resourceOnly) {
    const resourceBase = resourceOnly[1]
    const deployment = fallbackDeployment.trim()
    if (resourceBase === undefined || !deployment) return null
    return {
      resourceBase,
      deployment,
      apiVersion,
    }
  }

  return null
}

export function buildAzureOpenAiUrl(
  endpoint: string,
  deployment: string,
  apiVersion: string,
): string {
  const parsed = parseAzureOpenAiEndpoint(endpoint, deployment, apiVersion)
  if (!parsed) {
    const trimmed = endpoint.replace(/\/+$/, '')
    const version = encodeURIComponent(apiVersion.trim() || AZURE_OPENAI_API_VERSION)
    const deploymentPath = `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`
    return `${trimmed}${deploymentPath}?api-version=${version}`
  }
  const version = encodeURIComponent(parsed.apiVersion)
  const dep = encodeURIComponent(parsed.deployment)
  return `${parsed.resourceBase}/openai/deployments/${dep}/chat/completions?api-version=${version}`
}
