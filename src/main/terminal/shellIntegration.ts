import { app } from 'electron'
import path from 'node:path'

/** Directory holding the shipped zsh ZDOTDIR shim. */
export function zshShimDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'shell-integration', 'zsh')
    : path.join(app.getAppPath(), 'resources', 'shell-integration', 'zsh')
}

/**
 * Env additions that make a spawned zsh source our OSC 133/633/7 hooks while
 * still loading the user's own dotfiles (VS Code-style ZDOTDIR shim).
 */
export function shellIntegrationEnv(sessionId: string, baseEnv: Record<string, string>): Record<string, string> {
  return {
    ORB_USER_ZDOTDIR: baseEnv.ZDOTDIR || baseEnv.HOME || process.env.HOME || '~',
    ZDOTDIR: zshShimDir(),
    ORB_SESSION_ID: sessionId,
    ORB_SHELL_INTEGRATION: '1'
  }
}
