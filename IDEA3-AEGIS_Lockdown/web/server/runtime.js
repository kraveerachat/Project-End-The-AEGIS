import { createApp } from './createApp.js'


export function startServer({ config, repository, appFactory = createApp }) {
  const app = appFactory({ config, repository })
  let closePromise = null

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.bindHost)

    function close() {
      if (closePromise) return closePromise
      closePromise = new Promise((closeResolve, closeReject) => {
        const closeRepository = () => {
          try {
            app.locals.close?.()
            closeResolve()
          } catch (error) {
            closeReject(error)
          }
        }
        if (!server.listening) {
          closeRepository()
          return
        }
        server.close((error) => {
          if (error) {
            closeReject(error)
            return
          }
          closeRepository()
        })
      })
      return closePromise
    }

    server.once('error', (error) => {
      close().catch(() => {})
      reject(error)
    })
    server.once('listening', () => resolve({ app, server, close }))
  })
}
