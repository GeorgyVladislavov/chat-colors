import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SEEN_MS, buildRows, seenByFocus, staleMarks } from './rows'
import type { Listed, StatusFile } from './rows'
import { settle, startSession } from './testkit'
import type { On, Record_ } from './testkit'

// Two ways a finished chat counts as seen beyond the app's window on screen:
// the person wrote to it from the phone, or the app showed it while its
// process slept (the app notes when, in its own file on the chat).
// The test engine hands the paths on whole, under its own folder: matched by
// what follows the home folder.
const APP = '~/Claude-Data/claude_x/claude-code-sessions'
const tail = (path: string) => path.replace(/\\/g, '/').replace(/^.*\/Users\/test\//, '~/')

type Setup = {
  held: Record_
  screens?: string[]
  // When the app's file says its window last showed this chat; absent, the app
  // has no file on it.
  focusAt?: number
  // The other chats the app lists, and their records, listed in this order,
  // each written at its `writtenAt` (5 when not said).
  others?: Listed[]
  records?: (StatusFile & { writtenAt?: number })[]
}

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const file = (name: string, mtimeMs = 5) => ({ name, kind: 'file' as const, size: 100, mtimeMs, isLink: false })

const session = async ($: Engine, on: On, setup: Setup) => {
  const recordsDir = (path: string) => /[\\/]\.claude[\\/]chat-colors$/.test(path)
  const { records, timers, renames } = await startSession($, on, {
    held: setup.held,
    screens: setup.screens,
    others: setup.others,
    isRunning: true,
    readFile: path => {
      if (tail(path).startsWith(`${APP}/acc/org/`)) return `{"sessionId":"x","lastFocusedAt":${setup.focusAt},"title":"x"}`
      const other = setup.records?.find(one => tail(path).endsWith(`/${one.cliId}.json`))

      return other ? JSON.stringify(other) : undefined
    },
    listDir: raw => {
      const path = tail(raw)
      if (path === '~/Claude-Data') return [dir('claude_x')]
      if (path === APP) return [dir('acc')]
      if (path === `${APP}/acc`) return [dir('org')]
      if (path === `${APP}/acc/org`) return setup.focusAt === undefined ? [] : [file('local_test.json'), file('local_other.json')]
      if (recordsDir(path)) return (setup.records ?? []).map(one => file(`${one.cliId}.json`, one.writtenAt))

      return undefined
    },
  })

  return { writes: records, timers, renames }
}

const turn = async ($: Engine, kind: 'bridge' | 'sdk') => {
  await $.prompt.submit({ text: 'Сделай отчёт', wait: false, origin: { kind } as never })
  await $.turn.start({ text: 'Сделай отчёт', turnId: 't1' })
  await $.turn.complete({ reason: 'answer', answer: 'Отчёт готов.', durationMs: 1, isAborted: false, turnId: 't1' })
}

test('a turn written to from the phone counts as seen when it ends', async ($, on) => {
  const { writes, timers } = await session($, on, { held: { status: 'done', at: 1, seenAt: 1 } })

  await turn($, 'bridge')
  await settle($)

  expect(writes.at(-1)).toMatchObject({ status: 'done', seenAt: expect.any(Number) })
  expect(writes.at(-1)?.unseen).toBeUndefined()
  expect(timers.at(-1)).toBe(SEEN_MS)
})

test('a turn written to from the app waits to be seen, as before', async ($, on) => {
  const { writes } = await session($, on, { held: { status: 'done', at: 1, seenAt: 1 } })

  await turn($, 'sdk')
  await settle($)

  expect(writes.at(-1)).toMatchObject({ status: 'done', unseen: true })
})

test('a chat the app showed after it ended, while it slept, counts as seen then', async ($, on) => {
  const end = Date.now() - 30 * 60000
  const focusAt = Date.now() - 2 * 60000
  const { writes, timers } = await session($, on, { held: { status: 'done', at: end, unseen: true }, focusAt })

  await settle($)

  expect(writes.at(-1)).toMatchObject({ status: 'done', seenAt: focusAt })
  expect(writes.at(-1)?.unseen).toBeUndefined()
  expect(timers.at(-1)).toBeGreaterThan(SEEN_MS - 2 * 60000 - 5000)
  expect(timers.at(-1)).toBeLessThanOrEqual(SEEN_MS - 2 * 60000)
})

test('a chat the app showed only before it ended stays green', async ($, on) => {
  const end = Date.now() - 30 * 60000
  const { writes, timers } = await session($, on, {
    held: { status: 'done', at: end, unseen: true },
    focusAt: end - 1000,
  })

  await settle($)

  expect(writes.filter(one => one.seenAt !== undefined)).toEqual([])
  expect(timers).toEqual([])
})

test('without the app’s files a chat waits for its window, as before', async ($, on) => {
  const { writes, timers } = await session($, on, { held: { status: 'done', at: 1, unseen: true } })

  await settle($)

  expect(writes.filter(one => one.seenAt !== undefined)).toEqual([])
  expect(timers).toEqual([])
})

test('a running chat takes the green mark off a sleeping one seen over ten minutes ago', async ($, on) => {
  const end = Date.now() - 60 * 60000
  const focusAt = Date.now() - 15 * 60000
  const other: Listed = {
    sessionId: 'local_other',
    title: '🟢 Сайт',
    cwd: '/',
    isRunning: false,
    lastActivityAt: new Date(end).toISOString(),
  }
  const { renames } = await session($, on, {
    held: { status: 'working', at: 1 },
    focusAt,
    others: [other],
    records: [{ cliId: 'cli-other', desktopId: 'local_other', status: 'done', at: end, unseen: true }],
  })

  await settle($)

  expect(renames).toContainEqual({ id: 'local_other', title: 'Сайт' })
})

test('of two records for one chat the one written last counts, so a fresh end keeps its mark', async ($, on) => {
  const justNow = Date.now() - 1000
  const other: Listed = {
    sessionId: 'local_other',
    title: '🟢 Отчёт',
    cwd: '/',
    isRunning: false,
    lastActivityAt: new Date(justNow).toISOString(),
  }
  const { renames } = await session($, on, {
    held: { status: 'working', at: 1 },
    focusAt: Date.now() - 30 * 60000,
    others: [other],
    // As the folder lists them: the chat's present record first, the one its
    // old process left after it.
    records: [
      { cliId: 'cli-new', desktopId: 'local_other', status: 'done', at: justNow, activityAt: justNow, unseen: true, writtenAt: 9 },
      { cliId: 'cli-old', desktopId: 'local_other', status: 'done', at: 1, seenAt: 1, writtenAt: 3 },
    ],
  })

  await settle($)

  expect(renames).toEqual([])
})

// The same rules, on the rows the band and the pane draw.
const NOW = Date.parse('2026-11-05T09:00:00Z')
const chat = (id: string, title: string, more: Partial<Listed> = {}): Listed => ({
  sessionId: id,
  title,
  cwd: 'C:\\Users\\user\\Desktop\\Дача',
  isRunning: false,
  lastActivityAt: '2026-11-04T10:00:00Z',
  ...more,
})
const done = (id: string, at: number, more: Partial<StatusFile> = {}): StatusFile => ({
  cliId: `cli-${id}`,
  desktopId: id,
  status: 'done',
  at,
  ...more,
})

test('seenByFocus counts a showing after the end, and only that', () => {
  const end = NOW - 3600000

  expect(seenByFocus(done('a', end, { unseen: true }), end + 1000)).toMatchObject({ seenAt: end + 1000 })
  expect(seenByFocus(done('a', end, { unseen: true }), end + 1000).unseen).toBeUndefined()
  expect(seenByFocus(done('a', end, { unseen: true }), end - 1000)).toMatchObject({ unseen: true })
  expect(seenByFocus(done('a', end, { unseen: true }), undefined)).toMatchObject({ unseen: true })
  expect(seenByFocus(done('a', end, { seenAt: end }), end + 5000)).toMatchObject({ seenAt: end })
})

test('a sleeping chat shown after its end leaves the band ten minutes later', () => {
  const end = NOW - 3600000
  const rowsAt = (now: number, focused?: Map<string, number>) =>
    buildRows({
      all: [chat('a', '🟢 Сайт')],
      meta: {},
      files: new Map([['a', done('a', end, { unseen: true })]]),
      order: { a: 0 },
      focused,
      now,
    })[0]!.isRecent

  expect(rowsAt(NOW)).toBe(true)
  expect(rowsAt(NOW, new Map([['a', NOW - 5 * 60000]]))).toBe(true)
  expect(rowsAt(NOW, new Map([['a', NOW - 11 * 60000]]))).toBe(false)
})

test('staleMarks names the sleeping green chats whose time is over, and only them', () => {
  const end = NOW - 3600000
  const all = [
    chat('seen', '🟢 Увиден'),
    chat('unseen', '🟢 Не открыт'),
    chat('running', '🟢 Работает', { isRunning: true }),
    chat('plain', 'Без кружка'),
    chat('me', '🟢 Этот'),
    chat('run', '🟢 Запуск задачи'),
    chat('late', '🟢 Открыт недавно'),
    // Its record is older than its last turn: a record its old process left.
    chat('behind', '🟢 Отстал', { lastActivityAt: new Date(NOW - 60000).toISOString() }),
  ]
  const files = new Map(all.map(one => [one.sessionId, done(one.sessionId, end, { unseen: true })]))
  const focused = new Map([
    ['behind', NOW - 20 * 60000],
    ['seen', NOW - 20 * 60000],
    ['running', NOW - 20 * 60000],
    ['plain', NOW - 20 * 60000],
    ['me', NOW - 20 * 60000],
    ['run', NOW - 20 * 60000],
    ['late', NOW - 2 * 60000],
  ])

  const stale = staleMarks({ all, meta: { run: { task: 'digest' } }, files, focused, selfId: 'me', now: NOW })

  expect(stale.map(one => one.sessionId)).toEqual(['seen'])
})
