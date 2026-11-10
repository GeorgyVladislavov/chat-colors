import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { settle, startSession } from './testkit'
import type { On, Record_ } from './testkit'

// A turn can end while work it started runs on: a helper, a command in the
// background. The engine wakes the chat as each ends, so the chat is not done:
// it stays blue, saying what it waits for, until nothing is left. classic.Stop
// comes just before turn.complete and says what is left (checked on a real
// session 06.11.2026); it only tells, it sets no status.

type Task = { id: string; type: string; status: string; description: string; command?: string }

const HELPER: Task = { id: 'a1', type: 'subagent', status: 'running', description: 'Вычитка текста' }
const SHELL: Task = { id: 'b1', type: 'shell', status: 'running', description: 'Сборка сайта', command: 'build.ps1' }
// The app arms this by itself on each publish: it runs till the session goes,
// and a chat that published a page is not waiting for it.
const WATCH: Task = {
  id: 's1',
  type: 'monitor',
  status: 'running',
  description: 'live updates for artifact https://claude.ai/artifact/x (auto-armed on publish)',
}
const DREAM: Task = { id: 'd1', type: 'dream', status: 'running', description: 'dreaming' }

// A session whose record says `held`; `agents` is what $.agent.list() answers.
const session = ($: Engine, on: On, held: Record_, agents: Array<{ status: string }> = []) =>
  startSession($, on, { held, agents, title: 'Тексты', answer: 'Жду результат вычитки.' })

const start = ($: Engine) => $.turn.start({ text: 'Вычитай текст', turnId: 't1' })
const stop = ($: Engine, tasks: Task[]) => $.classic.Stop({ stop_hook_active: false, background_tasks: tasks } as never)
const complete = ($: Engine, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
  $.turn.complete({ reason, answer: 'Жду результат вычитки.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' })

const turn = async ($: Engine, tasks: Task[]) => {
  await start($)
  await stop($, tasks)
  await complete($)
  await settle($)
}

test('a reload of the mod leaves a chat waiting on a command blue: the command runs on', async ($, on) => {
  const held: Record_ = { status: 'done', at: 1, seenAt: 1 }
  const { records } = await session($, on, held)
  await settle($)

  // $.agent.list() knows helpers, not commands: it says nothing runs.
  Object.assign(held, { status: 'working', seenAt: undefined, background: 'ждёт фоновую задачу: Сборка сайта' })
  const before = records.length
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle($)

  expect(records.slice(before).some(one => one.status === 'done')).toBe(false)
})

test('a turn that ends with a helper still at work stays blue and says what it waits for', async ($, on) => {
  const { records, titles } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [HELPER])

  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновую задачу: Вычитка текста' })
  expect(records.at(-1)?.unseen).toBeUndefined()
  expect(titles).toEqual(['🔵 Тексты'])
})

test('a command in the background holds a chat as a helper does', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [SHELL])

  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновую задачу: Сборка сайта' })
})

test('a watch on a published page holds nobody: the chat that ends with one is done', async ($, on) => {
  const { records, titles } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [WATCH])

  expect(records.at(-1)).toMatchObject({ status: 'done', unseen: true })
  expect(records.at(-1)?.background).toBeUndefined()
  expect(titles).toEqual(['🔵 Тексты', '🟢 Тексты'])
})

test('nor does the engine\'s own housekeeping, which wakes nobody', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [DREAM])

  expect(records.at(-1)).toMatchObject({ status: 'done' })
})

test('beside a watch, a helper still holds the chat, and only it is told', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [WATCH, HELPER])

  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновую задачу: Вычитка текста' })
})

test('it turns green only at the end of the turn that leaves nothing running', async ($, on) => {
  const { records, titles } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [HELPER, SHELL])
  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновые задачи: 2' })

  // the helper ended and woke the chat; the command goes on
  await turn($, [SHELL])
  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновую задачу: Сборка сайта' })

  await turn($, [])
  expect(records.at(-1)).toMatchObject({ status: 'done', unseen: true })
  expect(records.at(-1)?.background).toBeUndefined()
  expect(titles).toEqual(['🔵 Тексты', '🟢 Тексты'])
})

test('a closing question stays orange with work in the background', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await start($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ask: 'Публикуем?', actions: [{ label: 'Да' }] })
  await stop($, [HELPER])
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'Публикуем?' })
  expect(records.at(-1)?.background).toBeUndefined()
})

test('an error stays red and a stopped chat is done, whatever runs in the background', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await start($)
  await stop($, [HELPER])
  await complete($, 'error')
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'error' })
  expect(records.at(-1)?.background).toBeUndefined()

  await start($)
  await stop($, [HELPER])
  await complete($, 'aborted')
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'done', summary: 'Остановлен' })
  expect(records.at(-1)?.background).toBeUndefined()
})

test('what an earlier turn left is not taken for this turn: a turn with no Stop just ends', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, [HELPER])
  await start($)
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.background).toBeUndefined()
})

test('a phone turn held by background work is still seen at its real end', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await $.prompt.submit({ text: 'Вычитай', wait: false, origin: { kind: 'bridge' } as never })
  await turn($, [HELPER])
  await $.prompt.submit({ text: 'итог помощника', wait: false, origin: { kind: 'task-notification' } as never })
  await turn($, [])

  expect(records.at(-1)).toMatchObject({ status: 'done', seenAt: expect.any(Number) })
  expect(records.at(-1)?.unseen).toBeUndefined()
})

test('while it waits the chat gives a sign of life, so that others do not take it for ended', async ($, on) => {
  const old = Date.now() - 2 * 60000
  const { records } = await session(
    $,
    on,
    { status: 'working', at: 1, activityAt: old, background: 'ждёт фоновую задачу: Вычитка текста' },
    [{ status: 'running' }],
  )

  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'working', background: 'ждёт фоновую задачу: Вычитка текста' })
  expect(records.at(-1)?.activityAt as number).toBeGreaterThan(old)
})

test('a working chat with no background work gives no such sign', async ($, on) => {
  const { records } = await session($, on, { status: 'working', at: 1, activityAt: 1 }, [{ status: 'running' }])

  await settle($)

  expect(records).toEqual([])
})

test('after a restart the background work is gone with the old process: the chat ends', async ($, on) => {
  const { records, titles } = await session($, on, {
    status: 'working',
    at: 1,
    activityAt: 1,
    summary: 'Жду результат вычитки.',
    background: 'ждёт фоновую задачу: Вычитка текста',
  })

  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done', summary: 'Жду результат вычитки.', unseen: true })
  expect(records.at(-1)?.background).toBeUndefined()
  expect(titles).toEqual(['🟢 Тексты'])
})
