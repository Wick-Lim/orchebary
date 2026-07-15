import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'
import type {
  EventChannel,
  InvokeChannel,
  Invokables,
  MainEvents,
  SendChannel,
  Sendables
} from '../../shared/ipc'

/**
 * Every IPC entry point validates its payload and rejects calls that do not
 * originate from our own top-level frame. The preload bridge is the only
 * legitimate caller, so anything else is treated as hostile.
 */
function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error('IPC call from untrusted frame rejected')
  }
}

export function handle<K extends InvokeChannel>(
  channel: K,
  schema: ZodType<Invokables[K]['req']> | null,
  handler: (
    req: Invokables[K]['req'],
    event: IpcMainInvokeEvent
  ) => Promise<Invokables[K]['res']> | Invokables[K]['res']
): void {
  ipcMain.handle(channel, (event, payload) => {
    assertTrustedSender(event)
    const req = schema ? schema.parse(payload) : (payload as Invokables[K]['req'])
    return handler(req, event)
  })
}

export function on<K extends SendChannel>(
  channel: K,
  schema: ZodType<Sendables[K]> | null,
  handler: (payload: Sendables[K], event: IpcMainEvent) => void
): void {
  ipcMain.on(channel, (event, payload) => {
    assertTrustedSender(event)
    const req = schema ? schema.parse(payload) : (payload as Sendables[K])
    handler(req, event)
  })
}

/** Broadcast a push event to every renderer window. */
export function broadcast<K extends EventChannel>(channel: K, payload: MainEvents[K]): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
}
