import type { AgentAvailability, AgentKind } from '../../shared/domain'
import type { AgentAdapter } from './AgentAdapter'
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter'

const claudeCode = new ClaudeCodeAdapter()

const adapters = new Map<AgentKind, AgentAdapter>([['claude-code', claudeCode]])

export function getAdapter(kind: AgentKind): AgentAdapter | undefined {
  return adapters.get(kind)
}

export async function listAvailability(): Promise<AgentAvailability[]> {
  return [
    await claudeCode.checkAvailability(),
    {
      kind: 'gemini-cli',
      displayName: 'Gemini CLI',
      available: false,
      problem: 'not yet supported'
    },
    { kind: 'codex', displayName: 'Codex', available: false, problem: 'not yet supported' }
  ]
}
