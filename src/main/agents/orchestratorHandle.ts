import type { RunOrchestrator } from './RunOrchestrator'

// Set by agent.ipc at registration; lets tasks.ipc auto-start agent runs on
// board moves without a circular import between the two IPC modules.
let instance: RunOrchestrator | null = null

export function setOrchestrator(o: RunOrchestrator): void {
  instance = o
}

export function getOrchestrator(): RunOrchestrator | null {
  return instance
}
