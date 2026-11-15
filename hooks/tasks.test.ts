import { expect, mock, test } from 'claude-code/testing'

// LIVE 15.11.2026 (Claude Code 2.1.325): in auto mode the app refuses a mod the
// list of scheduled tasks. The mod asked again on every pass, every few seconds
// from every chat that runs: some 220 refusals a minute in the app's log.
test('a refused task list is asked for again once a minute, and the journal says so once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const asked: number[] = []
  const journals: string[] = []
  on('fs.write', (_, e) => {
    if (/[\\/]log[\\/]/.test(e.path)) journals.push(e.text)

    return { value: undefined }
  })
  on('fs.read', () => ({ value: JSON.stringify({ cliId: 'cli-test', status: 'done', at: 1, seenAt: 1 }) }))
  on('fs.list', () => ({ value: [] }))
  on('env.get', () => ({ value: 'C:\\Users\\test' }))
  on('session.id', () => ({ value: 'cli-test' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.surfaces', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'chats' } }))
  on('ui.panes', () => ({ value: [] }))
  mock.store(on)
  on('mcp.call', (_, e) => {
    const reply = (text: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text }], isError } })
    if (e.tool === 'get_session') return reply(JSON.stringify({ sessionId: 'local_test', title: '🟢 Чат', cwd: '/', isRunning: false, lastActivityAt: '' }))
    if (e.tool === 'list_sessions') return reply('[]')
    if (e.tool === 'list_scheduled_tasks') {
      asked.push(clock.now())

      return reply('The app refused this call: plugins may not call this tool in auto mode.', true)
    }

    return reply('{}')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // Many passes within the minute: one question.
  for (let pass = 0; pass < 12; pass++) await clock.advance(4000)
  expect(asked.length).toBe(1)

  // The minute is up: asked once more.
  for (let pass = 0; pass < 4; pass++) await clock.advance(4000)
  expect(asked.length).toBe(2)

  const said = (journals.at(-1) ?? '').split('\n').filter(line => line.includes('список задач по расписанию'))
  expect(said.length).toBe(1)
})
