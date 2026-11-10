import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { askerOf } from './record'
import { buildRows, placeNew, saneChats, staleMarks } from './rows'
import type { Listed, StatusFile } from './rows'
import { settle, startSession } from './testkit'

// The edges of the fixes of 09.11.2026: what they must not take away.

const start = ($: Engine) => $.turn.start({ text: 'x', turnId: 't1' })
const complete = ($: Engine) =>
  $.turn.complete({ reason: 'answer', answer: 'Готово.', durationMs: 1, isAborted: false, turnId: 't1' })
const permission = ($: Engine, tool: string, input: object) =>
  $.classic.PermissionRequest({ tool_name: tool, tool_input: input })

const chat = (more: Partial<Listed> = {}): Listed => ({
  sessionId: 'local_a',
  title: '🔵 Чат',
  cwd: 'C:\\Users\\user\\Desktop\\Папка',
  isRunning: false,
  lastActivityAt: '2026-11-09T11:27:45.378Z',
  ...more,
})

test('a permission a helper asks is orange until given, then blue again', async ($, on) => {
  const gates: Array<() => void> = []
  const { records } = await startSession($, on, {
    held: { status: 'done', at: 1, seenAt: 1 },
    runTool: () => new Promise<void>(open => gates.push(open)),
  })
  await start($)

  const call = $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'helper-1' } as never)
  await settle($)
  await permission($, 'Bash', { command: 'ls' })
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: выполняет команду' })

  gates[0]!()
  await call
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'working' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test('of two dialogs up, the one answered first leaves the other one orange', async ($, on) => {
  const gates: Array<() => void> = []
  const { records } = await startSession($, on, {
    held: { status: 'done', at: 1, seenAt: 1 },
    runTool: () => new Promise<void>(open => gates.push(open)),
  })
  await start($)

  const bash = $.tool.call({ tool: 'Bash', command: 'rm x' })
  const edit = $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'b', new_string: 'c' })
  await settle($)
  await permission($, 'Bash', { command: 'rm x' })
  await permission($, 'Edit', { file_path: 'a', old_string: 'b', new_string: 'c' })
  await settle($)

  gates[1]!()
  await edit
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'просит разрешения: выполняет команду' })

  gates[0]!()
  await bash
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test('of two calls of one tool, the dialog is the one its input names', () => {
  const runs = [
    { tool: 'Bash', input: { tool: 'Bash', command: 'ls' } },
    { tool: 'Bash', input: { tool: 'Bash', command: 'rm x' } },
  ]

  expect(askerOf(runs, 'Bash', { command: 'rm x' })).toBe(runs[1])
  expect(askerOf(runs, 'Bash', { command: 'other' })).toBe(runs[0])
  expect(askerOf(runs, 'Read', {})).toBe(runs[0])
  expect(askerOf([], 'Read', {})).toBeUndefined()
})

test('a question put in words outlives a restart; a permission does not', async ($, on) => {
  const asked = await startSession($, on, { held: { status: 'waiting', at: 1, question: 'Публикуем?', answers: ['Да'] } })
  await settle($)

  expect(asked.records.filter(one => one.status !== 'waiting')).toEqual([])
})

test('a permission left from before a restart is over', async ($, on) => {
  const { records } = await startSession($, on, {
    held: { status: 'waiting', at: 1, question: 'просит разрешения: выполняет команду', answers: [] },
  })
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test('a reload of the mod leaves a chat at work as it is', async ($, on) => {
  on('state.get', (_, e, next) =>
    e.key === 'rows' ? { value: { value: { shape: 'rows-4', value: [{ id: 'x' }] }, version: 1 } } : next(e),
  )
  const { records } = await startSession($, on, { held: { status: 'working', at: 1, activityAt: 1 } })
  await settle($)

  expect(records).toEqual([])
})

test('a restart with a turn or a helper running leaves the chat at work', async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'working', at: 1, activityAt: 1 }, isRunning: true })
  await settle($)

  expect(records).toEqual([])
})

test('Esc in a dialog leaves no dialog behind for the next turn', async ($, on) => {
  let fail = (_: Error) => {}
  let calls = 0
  const { records } = await startSession($, on, {
    held: { status: 'done', at: 1, seenAt: 1 },
    runTool: () => {
      calls += 1
      if (calls === 1) return new Promise<void>((_, reject) => (fail = reject))

      return permission($, 'Bash', { command: 'ls' })
    },
  })
  await start($)
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Какой?', header: 'К', options: [], multiSelect: false }] })
  await settle($)

  fail(new Error('aborted'))
  await call.catch(() => undefined)
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' })
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'done', summary: 'Остановлен' })

  // The old dialog is gone: this permission, once given, is back to work.
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test('a closing box of the chat itself still asks', async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'done', at: 1, seenAt: 1 } })
  await start($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ask: 'Публикуем?', actions: [{ label: 'Да' }] })
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'Публикуем?', answers: ['Да'] })
})

test('another chat writing after the closing box leaves its question', async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'done', at: 1, seenAt: 1 } })
  await start($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ask: 'Публикуем?', actions: [{ label: 'Да' }] })
  await $.prompt.submit({ text: 'заметка', wait: false, origin: { kind: 'peer' } as never })
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'Публикуем?' })
})

// LIVE 10.11.2026: the person fixed a typo in a chat's title by hand at 12:46,
// the mark in it then stayed blue while the chat waited on them for an hour.
test('a title the person typed is tried again on each new status, and the journal says why once', async ($, on) => {
  const stored: { key: string; value: unknown }[] = []
  const renames: string[] = []
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
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'chats' } }))
  on('ui.panes', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    stored.push({ key: e.key, value: e.value })

    return { value: undefined }
  })
  on('mcp.call', (_, e) => {
    const reply = (text: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text }], isError } })
    if (e.tool === 'get_session') return reply(JSON.stringify({ sessionId: 'local_test', title: 'Мой чат', cwd: '/', isRunning: false, lastActivityAt: '' }))
    if (e.tool === 'list_sessions' || e.tool === 'list_scheduled_tasks') return reply('[]')
    if (e.tool === 'set_session_title') {
      renames.push(String(e.args.title))

      return reply('Could not rename this session: its title was set by the user, and replacing it needs their approval, which isn\'t available in this context.', true)
    }

    return reply('{}')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'Готово.' }))
  on('classic.Stop', () => ({}))
  on('classic.Notification', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await start($)
  await settle($)
  await complete($)
  await settle($)

  expect(stored.filter(one => one.key === 'unmarked')).toEqual([])
  expect(renames).toEqual(['🔵 Мой чат', '🟢 Мой чат'])
  const said = (journals.at(-1) ?? '').split('\n').filter(line => line.includes('задано вручную'))
  expect(said.length).toBe(1)
})

test('one chat with no date or a list that is no list breaks nothing', () => {
  const noDate = chat({ lastActivityAt: undefined as never })
  const rows = buildRows({ all: [noDate, chat({ sessionId: 'local_b' })], meta: {}, files: new Map(), order: {}, now: 1 })

  expect(rows.map(one => one.id).sort()).toEqual(['local_a', 'local_b'])
  expect(rows.find(one => one.id === 'local_a')?.age).toBe('')
  expect(placeNew({}, [noDate, chat({ sessionId: 'local_b', title: undefined as never })])).toBeDefined()
  expect(saneChats(undefined)).toEqual([])
  expect(saneChats([null, { title: 'без id' }])).toEqual([])
  expect(buildRows({ all: [chat({ cwd: undefined as never, title: '' })], meta: {}, files: new Map(), order: {}, now: 1 })[0]).toMatchObject({
    title: 'Без названия',
  })
  expect(staleMarks({ all: [noDate, chat({ title: undefined as never })], meta: {}, files: new Map(), selfId: 'me', now: 1 })).toEqual([])
})

test('a task’s row carries the chat of its latest run', () => {
  const run = chat({ sessionId: 'local_run', title: 'Запуск', lastActivityAt: '2026-11-09T10:00:00Z' })
  const list = buildRows({
    all: [run],
    meta: { local_run: { task: 'mail' } },
    files: new Map([['local_run', { cliId: 'c', status: 'waiting', at: 42, question: 'Отвечать?', answers: ['Да'] } as StatusFile]]),
    order: {},
    tasks: [{ taskId: 'mail', title: 'Почта', enabled: true }],
    now: 1000,
  })

  expect(list[0]).toMatchObject({ id: 'task:mail', chatId: 'local_run', askedAt: 42, answers: ['Да'] })
})

const blue = (now: number, more: Partial<StatusFile> = {}) =>
  ({ cliId: 'c', status: 'working', at: now - 2 * 3600_000, activityAt: now - 2 * 3600_000, ...more }) as StatusFile

test('a blue title on a chat that died is taken off, on a live one it is not', () => {
  const now = 1794223658219
  const stale = (file: StatusFile, more: Partial<Listed> = {}) =>
    staleMarks({
      all: [chat({ lastActivityAt: new Date(now - 2 * 3600_000).toISOString(), ...more })],
      meta: {},
      files: new Map([['local_a', file]]),
      selfId: 'me',
      now,
    }).length

  expect(stale(blue(now))).toBe(1)
  // Waiting on its helpers, its beat still fresh.
  expect(stale(blue(now, { activityAt: now - 60000, background: 'ждёт фоновую задачу' }))).toBe(0)
  // A dialog holds it.
  expect(stale(blue(now, { activityAt: now - 60000, doing: 'выполняет команду' }))).toBe(0)
  expect(stale(blue(now), { isRunning: true })).toBe(0)
  // Orange stays with the person.
  expect(stale({ ...blue(now), status: 'waiting', question: 'Публикуем?' }, { title: '🟠 Чат' })).toBe(0)
})

test('a live chat held by a dialog stays orange past the hour: its beat is fresh', () => {
  const now = 1794223658219
  const file = blue(now, { at: now - 5 * 3600_000, activityAt: now - 30000, doing: 'выполняет команду', doingAt: now - 5 * 3600_000 })
  const row = buildRows({ all: [chat()], meta: {}, files: new Map([['local_a', file]]), order: {}, now })[0]!

  expect(row.status).toBe('waiting')
})

test('a chat with a tool open beats; one with nothing open stays quiet', async ($, on) => {
  const old = Date.now() - 10 * 60000
  const open = await startSession($, on, { held: { status: 'working', at: 1, activityAt: old, doing: 'выполняет команду' }, isRunning: true })
  await settle($)

  expect(open.records.at(-1)?.activityAt as number).toBeGreaterThan(old)
})
