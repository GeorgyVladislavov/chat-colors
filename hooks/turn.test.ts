import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { settle, startSession } from './testkit'
import type { On, Record_ } from './testkit'

// The hooks that write this chat's record, run as a session runs them: the
// engine's side stood in for by the hooks here, the record read back from the
// writes. The engine spells paths its own way: the record is told by its name.


// A session whose record says `held`, its tool calls run by `runTool`, standing
// for the tool and its dialogs.
const session = async ($: Engine, on: On, held: Record_, runTool: () => unknown, written: Record_[] = []) => {
  const { records } = await startSession($, on, { held, runTool, written })

  return { records, settle: () => settle($) }
}

test('the closing box ending after the turn leaves its question orange', async ($, on) => {
  // The turn has ended on the closing box's question; its call ends only now.
  const { records, settle } = await session($, on, { status: 'waiting', at: 1, question: 'Публикуем?' }, () => undefined)

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ask: 'Публикуем?', actions: [{ label: 'Да' }] })
  await settle()

  expect(records.filter(record => record.status === 'working')).toEqual([])
})

test('a question in a dialog mid-turn is orange until answered, then blue again', async ($, on) => {
  const records: Record_[] = []
  let whileAsked: Record_ | undefined
  // The dialog stays up until the person answers: what is written meanwhile.
  await session(
    $,
    on,
    { status: 'working', at: 1 },
    async () => {
      await settle($)
      whileAsked = records.at(-1)
    },
    records,
  )

  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Какой формат?', header: 'Формат', options: [], multiSelect: false }] })
  await settle($)

  expect(whileAsked).toMatchObject({ status: 'waiting', question: 'Какой формат?' })
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})

test('a permission asked for a tool is orange until given, then blue again', async ($, on) => {
  const { records, settle } = await session($, on, { status: 'working', at: 1 }, () =>
    $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
  )

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()

  expect(records.map(record => record.status)).toContain('waiting')
  expect(records.at(-1)).toMatchObject({ status: 'working' })
})
