import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { appAsks } from './applog'
import { isRecord } from './testkit'
import type { On, Record_ } from './testkit'

// LIVE 21.11.2026: a chat called preview_start, the app put up its own
// «Разрешить Claude запустить сервер …?» and the chat stayed blue for half an
// hour. Such a dialog is the app's, inside a call of one of its own tools: the
// engine is not asked, no PermissionRequest comes. Only the app's log says so:
// «Emitted tool permission request <id> for <tool> in session local_<chat>»,
// and on the answer «respondToToolPermission: requestId=<id>».

const LOG = 'C:/Users/test/Claude/Logs/main.log'
const isLog = (path: string) => path.replace(/\\/g, '/') === LOG
const asked = (id: string, tool: string, chat = 'local_test') =>
  `2026-11-21 00:54:02 [info] Emitted tool permission request ${id} for ${tool} in session ${chat}\n`
const answered = (id: string) =>
  `2026-11-21 00:55:10 [info] LocalSessions.respondToToolPermission: requestId=${id}, decision=once, hasUpdatedInput=false\n`
const other = '2026-11-21 00:54:01 [info] [EventLogging] Flushing 50 events\n'

// A chat at work, the app's log, and tool calls held open until the test lets
// them end.
// `wholeOnly`: an engine from before ranged reads, which gives the whole file.
const startChat = async ($: Engine, on: On, logAtStart = other, wholeOnly = false) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const records: Record_[] = []
  const gates: Array<() => void> = []
  const app = { log: logAtStart }
  on('fs.write', (_, e) => {
    if (isRecord(e.path)) records.push(JSON.parse(e.text) as Record_)

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (isLog(e.path)) {
      const from = wholeOnly ? 0 : (e.offset ?? 0)

      return { value: app.log.slice(from, e.length === undefined || wholeOnly ? undefined : from + e.length) }
    }

    return { value: isRecord(e.path) ? JSON.stringify({ cliId: 'cli-test', status: 'done', at: 1, seenAt: 1 }) : '' }
  })
  on('fs.stat', (_, e) => {
    if (!isLog(e.path)) throw new Error('ENOENT')

    return { value: { kind: 'file' as const, size: app.log.length, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', (_, e) => ({ value: isLog(e.path) }))
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
    const text =
      e.tool === 'get_session'
        ? JSON.stringify({ sessionId: 'local_test', title: '🔵 Чат', cwd: '/', isRunning: true, lastActivityAt: '' })
        : e.tool === 'list_sessions' || e.tool === 'list_scheduled_tasks'
          ? '[]'
          : '{}'

    return { value: { content: [{ type: 'text' as const, text }], isError: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => {
    await new Promise<void>(open => gates.push(open))

    return { result: {} }
  })
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.settle()

  return { clock, records, gates, app }
}

test('a dialog the app puts up inside its own tool is orange, its answer blue again', async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on)
  const call = $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'site-preview' } as never)
  await clock.settle()

  app.log += asked('req-1', 'mcp__Claude_Browser__preview_start')
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: запустить сервер' })

  // Allowed, and the server still starts: at work again.
  app.log += answered('req-1')
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'working' })
  expect(records.at(-1)?.question).toBeUndefined()

  gates[0]!()
  await call
  await clock.settle()
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test('the call that ends with no answer in the log ends the dialog too', async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on)
  const call = $.tool.call({ tool: 'mcp__computer-use__request_access', apps: ['Notes'] } as never)
  await clock.settle()
  app.log += asked('req-2', 'computer:request_access')
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: доступ к программам' })

  gates[0]!()
  await call
  await clock.settle()
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test("another chat's dialog, or one from before the call, leaves this chat blue", async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on, asked('old-1', 'mcp__Claude_Browser__navigate'))
  const call = $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)
  await clock.settle()
  app.log += asked('req-3', 'browser:open_site', 'local_other')
  await clock.advance(2000)
  await clock.advance(2000)

  expect(records.at(-1)).toMatchObject({ status: 'working' })
  expect(records.some(record => record.status === 'waiting')).toBe(false)
  gates[0]!()
  await call
})

test('an engine that reads only whole files leaves the log alone: no old dialog turns orange', async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on, asked('old-2', 'mcp__Claude_Browser__preview_start'), true)
  const call = $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'site-preview' } as never)
  await clock.settle()
  app.log += other
  await clock.advance(2000)
  await clock.advance(2000)

  expect(records.some(record => record.status === 'waiting')).toBe(false)
  gates[0]!()
  await call
})

test('a line the app has only half written is read when whole', async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on)
  const call = $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'site-preview' } as never)
  await clock.settle()
  const line = asked('req-4', 'mcp__Claude_Browser__preview_start')
  app.log += line.slice(0, 60)
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'working' })

  app.log += line.slice(60)
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: запустить сервер' })
  gates[0]!()
  await call
})

test("the engine's own permission, also in the log, is not pinned on another call", async ($, on) => {
  const { clock, records, gates, app } = await startChat($, on)
  const bash = $.tool.call({ tool: 'Bash', command: 'rm x' })
  const browse = $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
  app.log += asked('req-5', 'Bash')
  await clock.advance(2000)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: выполняет команду' })

  gates[0]!()
  await bash
  await clock.settle()
  expect(records.at(-1)).toMatchObject({ status: 'working' })

  gates[1]!()
  await browse
  await clock.settle()
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test('the log lines read: dialogs of this chat, answers of any', () => {
  const text = [
    asked('a', 'mcp__Claude_Browser__preview_start'),
    asked('b', 'Bash', 'local_other'),
    answered('a'),
    '2026-11-21 00:56:00 [info] Received permission response for c: always (tool: computer:request_access)\n',
    other,
  ].join('')

  expect(appAsks(text, 'local_test')).toEqual([
    { kind: 'asked', id: 'a', tool: 'mcp__Claude_Browser__preview_start' },
    { kind: 'answered', id: 'a' },
    { kind: 'answered', id: 'c' },
  ])
})
