import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { fixedNow } from './evidence.js'

export async function makeDemoSnapshot() {
  return createDemoProvider({ clock: () => fixedNow }).getSnapshot()
}
