import { createApp } from './createApp.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp({ config })

app.listen(config.port, '127.0.0.1', () => {
  process.stdout.write(`AEGIS IDEA3 Security Center listening on http://127.0.0.1:${config.port}\n`)
})
