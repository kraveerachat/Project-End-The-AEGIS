import { fetchIntegrationFeed } from './integrationFeed.js'

/** Read the reviewed IDEA2 service feed. Never a human SOC session. */
export function fetchIdea2Events({ config, fetchImpl, clock }) {
  return fetchIntegrationFeed({
    source: 'IDEA2',
    url: config.adapters.idea2Url,
    token: config.adapters.idea2Token,
    config,
    fetchImpl,
    clock,
  })
}
