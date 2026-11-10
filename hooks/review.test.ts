import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildRows, staleMarks } from './rows'
import type { Listed, StatusFile } from './rows'
import { settle, startSession } from './testkit'
import type { Record_ } from './testkit'

// Review of 09.11.2026. Each test states what should be true; a failing one is a
// bug shown on the mod's own code. Records marked LIVE are copied from the real
// chat-colors folder.

const WRAP = 'mcp__ccd_turn__wrap_up'
const PLAN = 'mcp__ccd_turn__update_plan'

const start = ($: Engine) => $.turn.start({ text: 'x', turnId: 't1' })
const complete = ($: Engine, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
  $.turn.complete({ reason, answer: 'Готово.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' })
const message = ($: Engine, kind: string, text = 'Сообщение') =>
  $.prompt.submit({ text, wait: false, origin: { kind } as never })
const stop = ($: Engine, tasks: unknown[]) => $.classic.Stop({ stop_hook_active: false, background_tasks: tasks } as never)

const chat = (more: Partial<Listed> = {}): Listed => ({
  sessionId: 'local_a',
  title: '🔵 Чат',
  cwd: 'C:\\Users\\user\\Desktop\\Папка',
  isRunning: false,
  lastActivityAt: '2026-11-09T11:27:45.378Z',
  ...more,
})
const rowOf = (file: Partial<StatusFile>, now: number, more: Partial<Listed> = {}) =>
  buildRows({
    all: [chat(more)],
    meta: {},
    files: new Map([['local_a', { cliId: 'c', ...file } as StatusFile]]),
    order: {},
    now,
  })[0]!

// 1. A helper's tools are the helper's: the chat itself waits for nobody.
test('LIVE: a chat waiting on its helpers is blue, not "waits for your answer"', () => {
  // The record of the very chat that ran this review, 09.11 11:27 UTC.
  const live = {
    status: 'working',
    at: 1794223204089,
    activityAt: 1794223658219,
    step: '1 из 5: Найти ошибку',
    doing: 'выполняет команду',
    doingAt: 1794223658219,
    background: 'ждёт фоновые задачи: 3',
  } as const
  const row = rowOf(live, live.activityAt + 5000)

  expect(row.status).toBe('working')
  expect(row.detail).toBe('')
})

test("a helper's tool call does not write what the chat itself does", async ($, on) => {
  let open = () => {}
  const { records } = await startSession($, on, {
    held: { status: 'working', at: 1, background: 'ждёт фоновую задачу' },
    runTool: () => new Promise<void>(go => (open = go)),
  })

  const call = $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'helper-1' } as never)
  await settle($)
  const whileRunning = records.at(-1)
  open()
  await call
  await settle($)

  expect(whileRunning?.doing).toBeUndefined()
})

test("a helper's update_plan leaves the chat's own plan alone", async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'working', at: 1 } })

  await $.tool.call({ tool: PLAN, items: [{ content: 'План помощника', status: 'in_progress' }], agentId: 'helper-1' } as never)
  await settle($)

  expect(records.some(one => String(one.step ?? '').includes('План помощника'))).toBe(false)
})

test("a helper's closing box does not become the chat's question", async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'done', at: 1, seenAt: 1 } })

  await start($)
  await $.tool.call({ tool: WRAP, recap: 'Я помощник.', ask: 'Вопрос помощника?', actions: [{ label: 'Да' }], agentId: 'helper-1' } as never)
  await complete($)
  await settle($)

  expect(records.at(-1)?.status).toBe('done')
  expect(records.at(-1)?.question).toBeUndefined()
})

test("a helper's closing box does not close a question the person has not answered", async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'waiting', at: 1, question: 'Публикуем?', answers: ['Да'] } })

  await message($, 'task-notification', 'Итог проверки')
  await start($)
  await $.tool.call({ tool: WRAP, recap: 'Я помощник, отчёт готов.', agentId: 'helper-1' } as never)
  await complete($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'waiting', question: 'Публикуем?' })
})

// 2. Two tools at once, one of them asks.
test('a dialog still up stays orange when another tool ends meanwhile', async ($, on) => {
  const gates: Array<() => void> = []
  const { records } = await startSession($, on, {
    held: { status: 'working', at: 1 },
    runTool: () => new Promise<void>(open => gates.push(open)),
  })

  const read = $.tool.call({ tool: 'Read', file_path: 'a.txt' })
  const bash = $.tool.call({ tool: 'Bash', command: 'rm x' })
  await settle($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
  await settle($)
  expect(records.at(-1)).toMatchObject({ status: 'waiting' })

  // The Read ends; the Bash's dialog is still in front of the person.
  gates[0]!()
  await read
  await settle($)
  const whileDialogIsUp = records.at(-1)

  gates[1]!()
  await bash
  await settle($)

  expect(whileDialogIsUp).toMatchObject({ status: 'waiting' })
})

// 3. AskUserQuestion goes through the permission path in the engine as well.
test('the question of a dialog is not replaced by the permission that shows it', async ($, on) => {
  const records: Record_[] = []
  let shown: Record_ | undefined
  await startSession($, on, {
    held: { status: 'working', at: 1 },
    written: records,
    runTool: async () => {
      await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })
      await settle($)
      shown = records.at(-1)
    },
  })

  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Какой формат?', header: 'Ф', options: [], multiSelect: false }] })
  await settle($)

  expect(shown).toMatchObject({ status: 'waiting', question: 'Какой формат?' })
})

// 4. The chat is gone in the middle of a turn: power, freeze, app update.
test('a chat that died in the middle of a tool is not "waits for your answer" days later', () => {
  const now = 1794223658219
  const days = 3 * 24 * 3600 * 1000
  const row = rowOf({ status: 'working', at: now - days, activityAt: now - days, doing: 'выполняет команду', doingAt: now - days }, now)

  expect(row.status).not.toBe('waiting')
})

test('after a restart a chat that was at work no longer says so: no turn runs now', async ($, on) => {
  const { records, titles } = await startSession($, on, {
    held: { status: 'working', at: 1, activityAt: 1, doing: 'выполняет команду', doingAt: 1 },
    title: '🔵 Сборка сайта',
  })
  await settle($)

  expect(records.at(-1)?.status).not.toBe('working')
  expect(titles.at(-1)).not.toBe('🔵 Сборка сайта')
  expect(records.at(-1)).not.toBeUndefined()
})

// 5. What a permission asked is over when the permission is: other chats
// writing later do not make it a question again.
test('LIVE: a permission does not outlive its dialog as an unanswered question', async ($, on) => {
  const { records } = await startSession($, on, {
    held: { status: 'waiting', at: 1, question: 'просит разрешения: выполняет команду', answers: [] },
  })

  await message($, 'peer', 'Находки подтвердились.')
  await start($)
  await stop($, [])
  await complete($)
  await settle($)

  expect(records.at(-1)?.status).toBe('done')
})

// 6. The person answers while the turn is still going.
test('a message from the person after the closing box drops the box', async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'done', at: 1, seenAt: 1 } })

  await start($)
  await $.tool.call({ tool: WRAP, recap: 'Готово.', ask: 'Публикуем?', actions: [{ label: 'Да' }] })
  // Enter while the turn still runs: delivered into it, no new turn.start.
  await message($, 'composer', 'Да, публикуй, и ещё поправь заголовок')
  await complete($)
  await settle($)

  expect(records.at(-1)?.status).not.toBe('waiting')
})

// 7. The app's "last activity" moves without any turn.
test('LIVE: a green chat opened while asleep loses its mark though the app touched it later', () => {
  const ended = Date.parse('2026-11-09T07:32:59.801Z')
  const openedAt = ended + 3600_000
  const touched = '2026-11-09T11:20:16.795Z' // from list_sessions; the chat's last turn was 07:32:59
  const held = { cliId: 'c', status: 'done', at: ended, activityAt: ended, unseen: true } as StatusFile
  const stale = staleMarks({
    all: [chat({ title: '🟢 Посты', lastActivityAt: touched })],
    meta: {},
    files: new Map([['local_a', held]]),
    focused: new Map([['local_a', openedAt]]),
    selfId: 'me',
    now: openedAt + 3 * 3600_000,
  })

  expect(stale.map(one => one.sessionId)).toEqual(['local_a'])
})

// 8. The closing box finishes the plan (its description says so), the copy here
// does not hear it.
test("a plan the closing box finished does not show on the chat's next turn", async ($, on) => {
  const { records } = await startSession($, on, { held: { status: 'done', at: 1, seenAt: 1 } })

  await start($)
  await $.tool.call({ tool: PLAN, items: [{ content: 'Старый шаг', status: 'in_progress' }] })
  await $.tool.call({ tool: WRAP, recap: 'Готово.' })
  await complete($)
  await settle($)

  await message($, 'composer', 'Новый вопрос, без плана')
  await start($)
  await settle($)

  expect(records.at(-1)).toMatchObject({ status: 'working' })
  expect(records.at(-1)?.step).toBeUndefined()
})

// 9. A row with no title, as a session the app has not named yet could be.
test('one chat with no title does not break the list for every chat', () => {
  expect(() =>
    buildRows({ all: [chat({ title: undefined as never })], meta: {}, files: new Map(), order: {}, now: 1 }),
  ).not.toThrow()
})
