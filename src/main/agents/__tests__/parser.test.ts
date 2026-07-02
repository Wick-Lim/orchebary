import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter'

const adapter = new ClaudeCodeAdapter()

const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-123',
  cwd: '/tmp/wt',
  tools: ['Bash', 'Edit']
})

const assistantLine = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Working on it' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }
    ]
  }
})

const resultLine = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done',
  session_id: 'sess-123',
  total_cost_usd: 0.42,
  num_turns: 7
})

describe('ClaudeCodeAdapter parser', () => {
  it('parses NDJSON split across chunk boundaries mid-line', () => {
    const parser = adapter.createParser()
    const stream = `${initLine}\n${assistantLine}\n${resultLine}\n`
    const cut = initLine.length + 12 // inside the assistant line

    const first = parser.push(stream.slice(0, cut))
    expect(first.map((e) => e.kind)).toEqual(['system'])
    expect(parser.sessionId).toBe('sess-123')

    const rest = [...parser.push(stream.slice(cut)), ...parser.flush()]
    expect(rest.map((e) => e.kind)).toEqual(['assistant-text', 'tool-use', 'result'])
    expect(rest[0].text).toBe('Working on it')
    expect(rest[1].toolName).toBe('Bash')
    expect(rest[2].result).toEqual({
      ok: true,
      summary: 'All done',
      sessionId: 'sess-123',
      costUsd: 0.42,
      numTurns: 7
    })
    expect(parser.lastResult?.ok).toBe(true)
  })

  it('flush parses a trailing line without a newline', () => {
    const parser = adapter.createParser()
    expect(parser.push(resultLine)).toEqual([]) // still buffered
    const events = parser.flush()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('result')
    expect(parser.sessionId).toBe('sess-123')
  })

  it('emits raw for unparseable lines and skips empty ones', () => {
    const parser = adapter.createParser()
    const events = parser.push('not-json\n\n   \n{"type":"mystery"}\n')
    expect(events.map((e) => e.kind)).toEqual(['raw', 'raw'])
    expect(events[0].text).toBe('not-json')
    expect(events[1].text).toBe('{"type":"mystery"}')
  })

  it('marks failed results and captures the session id from the result line', () => {
    const parser = adapter.createParser()
    const failed = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'something broke',
      session_id: 'sess-9',
      num_turns: 2
    })
    const [event] = parser.push(`${failed}\n`)
    expect(event.result).toMatchObject({ ok: false, summary: 'something broke', numTurns: 2 })
    expect(parser.sessionId).toBe('sess-9')
    expect(adapter.interpretExit(1, parser.lastResult)).toEqual({
      status: 'failed',
      summary: 'something broke'
    })
  })

  it('interpretExit falls back to the exit code without a result event', () => {
    expect(adapter.interpretExit(0, undefined).status).toBe('completed')
    expect(adapter.interpretExit(3, undefined)).toEqual({
      status: 'failed',
      summary: 'agent exited with code 3'
    })
    expect(adapter.interpretExit(null, undefined).status).toBe('failed')
  })

  it('buildFollowUpSpawn puts --resume before the positional prompt', () => {
    const spec = adapter.buildFollowUpSpawn({
      prompt: 'fix the tests',
      worktreePath: '/wt',
      sessionId: 'sess-123'
    })
    expect(spec.command).toBe('claude')
    expect(spec.cwd).toBe('/wt')
    expect(spec.args.slice(0, 4)).toEqual(['-p', '--resume', 'sess-123', 'fix the tests'])
    expect(spec.args).toContain('stream-json')
  })

  it('buildSpawn passes the prompt right after -p', () => {
    const spec = adapter.buildSpawn({ prompt: 'do the thing', worktreePath: '/wt' })
    expect(spec.args.slice(0, 2)).toEqual(['-p', 'do the thing'])
    expect(spec.args).toEqual([
      '-p',
      'do the thing',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose'
    ])
  })
})
