import { expect, test } from 'claude-code/testing'

import { TASKS } from './rows'
import { PANE, paneRow as row } from './testkit'

const stateWith = (rows: object[], sent?: object) => (_: unknown, e: { key: string }, next: (e: never) => unknown) =>
  e.key === 'rows'
    ? { value: { value: { shape: 'rows-4', value: rows }, version: 1 } }
    : e.key === 'sent' && sent
      ? { value: { value: sent, version: 1 } }
      : next(e as never)

// A scheduled task's run that asked: the row's id stands for the task, not for
// the chat the answer must reach.
test('a reply pressed on a scheduled task reaches the chat of its run', async ($, on) => {
  const task = row({
    id: 'task:mail',
    chatId: 'local_run',
    title: 'Почта',
    folder: TASKS,
    status: 'waiting',
    isRecent: true,
    detail: 'Отвечать?',
    answers: ['Да'],
  })
  on('state.get', stateWith([task]) as never)
  const asked: Record<string, unknown>[] = []
  on('mcp.call', (_, e) => {
    asked.push({ tool: e.tool, ...e.args })

    return { value: { content: [{ type: 'text' as const, text: 'delivered' }], isError: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'task:mail:Да' })
  await pane.unmount()

  expect(String(asked[0]?.session_id)).toMatch(/^local_/)
})

// The same words asked again later are a new question.
test('a chat asking the same words again gets its buttons again', async ($, on) => {
  const again = row({
    id: 'b',
    title: 'Посты',
    folder: 'Дача',
    status: 'waiting',
    isRecent: true,
    detail: 'Продолжаем?',
    answers: ['Да', 'Нет'],
  })
  on('state.get', stateWith([again], { b: { question: 'Продолжаем?', answer: 'Да' } }) as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await pane.find({ key: 'b:Да' })).toBeDefined()
  await pane.unmount()
})
