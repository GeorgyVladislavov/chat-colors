import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { settle, startSession } from './testkit'
import type { On } from './testkit'

// What the app answers to set_session_title, word for word from its code
// (app.asar, handler of ccd_session_mgmt): `Renamed this session to "<new>"
// (was "<old>").`, or an error for a chat that is momentarily not found.

const start = ($: Engine) => $.turn.start({ text: 'x', turnId: 't1' })
const complete = ($: Engine) =>
  $.turn.complete({ reason: 'answer', answer: 'Готово.', durationMs: 1, isAborted: false, turnId: 't1' })

type Answer = (title: string) => { text: string; isError: boolean }

// startSession with the rename answered as the app does.
const session = async ($: Engine, on: On, title: string, answer: Answer) => {
  const stored: { key: string; value: unknown }[] = []
  let current = title
  const seen: string[] = []
  const wrapped = ((name: string, ...rest: unknown[]) => {
    if (name === 'mcp.call') {
      return (on as unknown as (n: string, h: unknown) => unknown)(name, (_: unknown, e: { tool: string; args: Record<string, unknown> }) => {
        const reply = (text: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text }], isError } })
        if (e.tool === 'get_session') {
          return reply(JSON.stringify({ sessionId: 'local_test', title: current, cwd: '/', isRunning: false, lastActivityAt: '' }))
        }
        if (e.tool === 'list_sessions') return reply('[]')
        if (e.tool === 'list_scheduled_tasks') return reply('[]')
        if (e.tool === 'set_session_title') {
          const wanted = String(e.args.title)
          const made = answer(wanted)
          if (!made.isError) {
            seen.push(wanted)
            current = wanted
          }

          return reply(made.text, made.isError)
        }

        return reply('{}')
      })
    }
    if (name === 'store.set') {
      return (on as unknown as (n: string, h: unknown) => unknown)(name, (_: unknown, e: { key: string; value: unknown }) => {
        stored.push({ key: e.key, value: e.value })

        return { value: undefined }
      })
    }

    return (on as unknown as (n: string, ...r: unknown[]) => unknown)(name, ...rest)
  }) as unknown as On
  await startSession($, wrapped, { held: { status: 'done', at: 1, seenAt: 1 } })

  return { stored, seen }
}

test('a title that happens to hold the word "rejected" keeps taking its marks', async ($, on) => {
  const { stored, seen } = await session($, on, 'App Store rejected the build', title => ({
    text: `Renamed this session to "${title}" (was "App Store rejected the build").`,
    isError: false,
  }))

  await start($)
  await settle($)
  await complete($)
  await settle($)

  expect(stored.filter(one => one.key === 'unmarked')).toEqual([])
  expect(seen.at(-1)).toBe('🟢 App Store rejected the build')
})

test('a rename that failed for a moment does not stop the marks for good', async ($, on) => {
  let failures = 1
  const { stored, seen } = await session($, on, 'Отчёт', title => {
    if (failures-- > 0) return { text: 'Session self not found.', isError: true }

    return { text: `Renamed this session to "${title}".`, isError: false }
  })

  await start($)
  await settle($)
  await complete($)
  await settle($)

  expect(stored.filter(one => one.key === 'unmarked')).toEqual([])
  expect(seen.at(-1)).toBe('🟢 Отчёт')
})

// The app's answer when the person named the chat, word for word (10.11.2026):
// once the title is the app's or Claude's again, the marks must come back.
test('the marks come back once the title is no longer the person’s', async ($, on) => {
  let refusals = 1
  const { stored, seen } = await session($, on, 'Дизайн', title => {
    if (refusals-- > 0) {
      return {
        text: 'Could not rename this session: its title was set by the user and is not the one this call was approved to replace (it may have been renamed since). Nothing was changed; call again if the rename is still wanted.',
        isError: true,
      }
    }

    return { text: `Renamed this session to "${title}".`, isError: false }
  })

  await start($)
  await settle($)
  await complete($)
  await settle($)

  expect(stored.filter(one => one.key === 'unmarked')).toEqual([])
  expect(seen.at(-1)).toBe('🟢 Дизайн')
})
