import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { settle, startSession } from './testkit'
import type { On, Record_ } from './testkit'

// A question put to the person stays asked until the person answers it. Other
// chats write to a chat too, and work it left running wakes it: such a turn may
// end with no question of its own, and the old one is still unanswered
// (a chat went green so).


const ASKED = { status: 'waiting', at: 1, question: 'Текст годится?', answers: ['Годится', 'Есть правки'] }
// As the pane's button words it.
const PRESSED =
  'Another Claude session sent a message:\n<cross-session-message from="local_x" from-name="Другой чат">\n' +
  'Ответ пользователя на твой вопрос «Текст годится?» (нажата кнопка в панели «Чаты» в другом чате): Годится\n' +
  '</cross-session-message>'
const NEIGHBOUR =
  'Another Claude session sent a message:\n<cross-session-message from="local_x" from-name="Другой чат">\n' +
  'Правила утверждены.\n</cross-session-message>'

const session = ($: Engine, on: On, held: Record_) => startSession($, on, { held, title: 'Текст', answer: 'Принял.' })

const message = ($: Engine, kind: string, text = 'Сообщение') =>
  $.prompt.submit({ text, wait: false, origin: { kind } as never })
const start = ($: Engine) => $.turn.start({ text: 'Сообщение', turnId: 't1' })
const complete = ($: Engine, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
  $.turn.complete({ reason, answer: 'Принял.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' })

const turn = async ($: Engine, kind: string, text?: string) => {
  await message($, kind, text)
  await start($)
  await complete($)
  await settle($)
}

const stillAsks = { status: 'waiting', question: 'Текст годится?', answers: ['Годится', 'Есть правки'] }

test("another chat's message leaves the question asked: orange again at the end", async ($, on) => {
  const { records, titles } = await session($, on, ASKED)

  await turn($, 'peer', NEIGHBOUR)

  expect(records.some(one => one.status === 'working')).toBe(true)
  expect(records.at(-1)).toMatchObject(stillAsks)
  expect(records.at(-1)?.unanswered).toBeUndefined()
  expect(titles.at(-1)).toBe('🟠 Текст')
})

test('work left running that ends leaves the question asked too', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'task-notification', 'Итог проверки')

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test("the app's own note about a chat this one started leaves it asked", async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'sdk', '<system-reminder>\nThe session "Стиль" you started (local_x) finished a turn.\n</system-reminder>')

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test('a message from no one known leaves it asked', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'unclassified', 'Служебная заметка')

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test("the person's message beside another chat's closes it, whichever came first", async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'composer', 'Годится')
  await message($, 'peer', NEIGHBOUR)
  await start($)
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test('several such messages in a row leave it asked', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'peer', NEIGHBOUR)
  await turn($, 'task-notification', 'Итог проверки')
  await turn($, 'peer', NEIGHBOUR)

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test("the person's answer closes the question", async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'composer')

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test("the person's answer from the phone closes it", async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'bridge')

  expect(records.at(-1)).toMatchObject({ status: 'done' })
})

test("a reply pressed in the pane closes it, though it comes as another chat's message", async ($, on) => {
  const { records } = await session($, on, ASKED)

  await turn($, 'peer', PRESSED)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test('the person writing while such a turn runs closes it', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'peer', NEIGHBOUR)
  await start($)
  await message($, 'composer', 'Годится')
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
  expect(records.at(-1)?.unanswered).toBeUndefined()
})

test('a new question of the chat takes the place of the old', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'peer', NEIGHBOUR)
  await start($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Учёл.', ask: 'Отправляем?', actions: [{ label: 'Да' }] })
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'Отправляем?', answers: ['Да'] })
})

test('a closing box with nothing to ask says the question is over', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'peer', 'Человек сказал: годится.')
  await start($)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Текст отправлен.' })
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done', summary: 'Текст отправлен.' })
  expect(records.at(-1)?.question).toBeUndefined()
})

test('an error in such a turn is red', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'peer', NEIGHBOUR)
  await start($)
  await complete($, 'error')
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'error' })
  expect(records.at(-1)?.unanswered).toBeUndefined()
})

test('a question outranks the work left running', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await message($, 'peer', NEIGHBOUR)
  await start($)
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Вычитка' }],
  } as never)
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test('a reload in the middle of such a turn keeps the question', async ($, on) => {
  const { records } = await session($, on, {
    status: 'working',
    at: 1,
    activityAt: Date.now(),
    unanswered: { question: 'Текст годится?', answers: ['Годится', 'Есть правки'] },
  })

  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject(stillAsks)
})

test('a chat that had asked nothing ends green after such a message', async ($, on) => {
  const { records } = await session($, on, { status: 'done', at: 1, seenAt: 1 })

  await turn($, 'peer', NEIGHBOUR)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
})

test('a turn nobody announced ends as before', async ($, on) => {
  const { records } = await session($, on, ASKED)

  await start($)
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'done' })
})
