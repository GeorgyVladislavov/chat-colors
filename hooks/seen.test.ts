import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { settle, startSession } from './testkit'
import type { On, Record_ } from './testkit'

// How long a finished chat keeps its mark: until the person opens it, then
// ten minutes. The app attaches its window to the chat on screen.


// A session whose record says `held` and which `screens` show.
const session = ($: Engine, on: On, held: Record_, screens: string[]) => startSession($, on, { held, screens })

const end = ($: Engine) =>
  $.turn.complete({ reason: 'answer', answer: 'Отчёт готов.', durationMs: 1, isAborted: false, turnId: 't1' })

test('a chat that ends while nobody looks stays green until opened, then ten minutes', async ($, on) => {
  const { records, timers, titles } = await session($, on, { status: 'working', at: 1 }, [])

  await end($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done', unseen: true })
  expect(records.at(-1)?.seenAt).toBeUndefined()
  expect(titles).toEqual(['🟢 Отчёт'])
  expect(timers).toEqual([])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop-2' })
  await settle($)

  expect(records.at(-1)?.unseen).toBeUndefined()
  expect(records.at(-1)?.seenAt).toEqual(expect.any(Number))
  expect(timers).toEqual([10 * 60000])
  expect(titles.at(-1)).toBe('Отчёт')
})

test('a chat that ends on screen counts as seen at once', async ($, on) => {
  const { records, timers } = await session($, on, { status: 'working', at: 1 }, ['desktop'])

  await end($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done', seenAt: expect.any(Number) })
  expect(records.at(-1)?.unseen).toBeUndefined()
  expect(timers).toEqual([10 * 60000])
})

test('after a restart a finished chat nobody opened keeps its mark', async ($, on) => {
  const { timers, titles } = await session($, on, { status: 'done', at: 1, unseen: true }, [])

  await settle($)

  expect(timers).toEqual([])
  expect(titles).toEqual([])
})

test('after a restart a seen chat takes off its mark when its minutes are up', async ($, on) => {
  const seenAt = Date.now() - 4 * 60000
  const { timers } = await session($, on, { status: 'done', at: 1, seenAt }, [])

  await settle($)

  expect(timers).toHaveLength(1)
  expect(timers[0]).toBeGreaterThan(5 * 60000)
  expect(timers[0]).toBeLessThanOrEqual(6 * 60000)
})
