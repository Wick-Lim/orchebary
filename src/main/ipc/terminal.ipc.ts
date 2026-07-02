import { z } from 'zod'
import { sessionManager } from '../terminal/SessionManager'
import { broadcast, handle, on } from './router'

const createSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  env: z.record(z.string(), z.string()).optional()
})

const resizeSchema = z.object({
  sessionId: z.string(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

const sessionIdSchema = z.object({ sessionId: z.string() })

export function registerTerminalIpc(): void {
  handle('terminal:create', createSchema, (req) => sessionManager.createShell(req))
  handle('terminal:resize', resizeSchema, ({ sessionId, cols, rows }) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  handle('terminal:kill', sessionIdSchema, ({ sessionId }) => sessionManager.kill(sessionId))
  handle('terminal:list', null, () => sessionManager.list())

  // Hot path: skip zod (payloads are trivial and validated structurally).
  on('terminal:input', null, ({ sessionId, data }) => {
    if (typeof sessionId === 'string' && typeof data === 'string') {
      sessionManager.write(sessionId, data)
    }
  })
  on('terminal:ack', null, ({ sessionId, bytes }) => {
    if (typeof sessionId === 'string' && typeof bytes === 'number') {
      sessionManager.ack(sessionId, bytes)
    }
  })

  sessionManager.onData((sessionId, data) => broadcast('terminal:data', { sessionId, data }))
  sessionManager.onExit((sessionId, exitCode, signal) =>
    broadcast('terminal:exit', { sessionId, exitCode, signal })
  )
  sessionManager.onLifecycle((session, event) =>
    broadcast(
      'app:event',
      event === 'registered'
        ? { type: 'terminal.registered', session }
        : { type: 'terminal.closed', sessionId: session.sessionId }
    )
  )
}
