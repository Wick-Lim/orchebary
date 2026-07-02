import { describe, expect, it } from 'vitest'
import { unescapeCommandLine } from './ShellIntegrationAddon'

// Mirrors __orb_escape in resources/shell-integration/zsh/orchebary-integration.zsh:
// backslash -> \\ , ';' -> \x3b , newline -> \x0a
describe('unescapeCommandLine', () => {
  it('passes plain commands through', () => {
    expect(unescapeCommandLine('git status')).toBe('git status')
  })

  it('decodes escaped semicolons', () => {
    expect(unescapeCommandLine('echo a\\x3b echo b')).toBe('echo a; echo b')
  })

  it('decodes escaped newlines', () => {
    expect(unescapeCommandLine('echo "a\\x0ab"')).toBe('echo "a\nb"')
  })

  it('decodes escaped backslashes', () => {
    expect(unescapeCommandLine('printf \\\\n')).toBe('printf \\n')
  })

  it('keeps literal \\x3b typed by the user (shell escapes its backslash)', () => {
    // User typed `echo \x3b`? zsh passes `echo \x3b` -> escaped `echo \\x3b`.
    expect(unescapeCommandLine('echo \\\\x3b')).toBe('echo \\x3b')
  })

  it('leaves unknown escapes untouched', () => {
    expect(unescapeCommandLine('grep \\d')).toBe('grep \\d')
  })

  it('handles empty payload', () => {
    expect(unescapeCommandLine('')).toBe('')
  })
})
