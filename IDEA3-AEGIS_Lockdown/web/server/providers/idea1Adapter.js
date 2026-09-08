import { fetchIntegrationFeed } from './integrationFeed.js'

/** Read the reviewed IDEA1 service feed. Never a human Admin session. */
export function fetchIdea1Events({ config, fetchImpl, clock }) {
  return fetchIntegrationFeed({
    source: 'IDEA1',
    url: config.adapters.idea1Url,
    token: config.adapters.idea1Token,
    config,
    fetchImpl,
    clock,
  })
}
