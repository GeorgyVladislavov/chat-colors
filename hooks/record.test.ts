import { expect, test } from 'claude-code/testing'

import { backgroundWords, closingOf, firstSentence, followPlan, planStep, toolWords, turnEnd } from './record'

test('a turn ends red only on an error Claude gave, orange on its closing question, green otherwise', () => {
  const closing = { summary: 'Готово.', question: 'Публикуем?', answers: ['Да', 'Нет'] }

  expect(turnEnd(closing, 'answer', '')).toEqual({
    status: 'waiting',
    summary: 'Готово.',
    question: 'Публикуем?',
    answers: ['Да', 'Нет'],
  })
  expect(turnEnd({}, 'answer', 'Сделал. Всё.')).toEqual({ status: 'done', summary: 'Сделал.' })
  expect(turnEnd(closing, 'error', '')).toEqual({ status: 'error', summary: 'Готово.', error: 'Claude выдал ошибку' })
  expect(turnEnd(closing, 'aborted', '')).toEqual({ status: 'done', summary: 'Остановлен' })
  expect(turnEnd({}, 'refusal', '')).toEqual({ status: 'done', summary: 'Claude отказался отвечать' })
})

test('a turn ends in its first sentence, as plain words', () => {
  expect(firstSentence('**Готово.** Панель обновлена, тесты прошли.')).toBe('Готово.')
  expect(firstSentence('## Итог\n\nКнопка исправлена: теперь [панель](x.md) закрывается. Дальше — проверка.')).toBe(
    'Итог',
  )
  expect(firstSentence('```\nкод\n```\nСделал таблицу погоды')).toBe('Сделал таблицу погоды')
  expect(firstSentence('')).toBe('')
  expect(firstSentence('а'.repeat(300))).toHaveLength(140)
})

test('tools are told in words, the app’s own bookkeeping not at all', () => {
  expect(toolWords('Bash')).toBe('выполняет команду')
  expect(toolWords('PowerShell')).toBe('выполняет команду')
  expect(toolWords('Edit')).toBe('правит файл')
  expect(toolWords('WebSearch')).toBe('ищет в интернете')
  expect(toolWords('mcp__Claude_Browser__navigate')).toBe('работает в браузере')
  expect(toolWords('mcp__abc12345__create_event')).toBe('работает с календарём')
  expect(toolWords('mcp__def67890__search_threads')).toBe('работает с подключением')
  expect(toolWords('mcp__ccd_turn__update_plan')).toBe('')
  expect(toolWords('ToolSearch')).toBe('')
})

test('the plan follows the update_plan calls', () => {
  let plan = followPlan([], {
    items: [
      { content: 'Найти', status: 'in_progress' },
      { content: 'Исправить', status: 'pending' },
      { content: 'Проверить', status: 'pending' },
    ],
  })
  expect(planStep(plan)).toBe('1 из 3: Найти')
  plan = followPlan(plan, { advance: true })
  expect(planStep(plan)).toBe('2 из 3: Исправить')
  plan = followPlan(plan, { done: [2], start: 3 })
  expect(planStep(plan)).toBe('3 из 3: Проверить')
  plan = followPlan(plan, { advance: true })
  expect(planStep(plan)).toBeUndefined()
})

test('a closing box gives its sentence, its question and its own replies', () => {
  expect(
    closingOf({
      recap: 'Кнопка исправлена. Тесты прошли.',
      ask: 'Публикуем? ',
      actions: [{ label: 'Да' }, { label: 'Создать PR', action: 'create_pr' }, { label: 'Нет' }],
    }),
  ).toEqual({ summary: 'Кнопка исправлена.', question: 'Публикуем?', answers: ['Да', 'Нет'] })
  expect(closingOf({ recap: 'Готово.' })).toEqual({ summary: 'Готово.', question: undefined, answers: undefined })
})

test('work left running keeps a finished turn blue, and is told in words', () => {
  const helper = { type: 'subagent', description: 'Вычитка' }

  expect(turnEnd({ summary: 'Жду вычитку.' }, 'answer', '', [helper])).toEqual({
    status: 'working',
    summary: 'Жду вычитку.',
    background: 'ждёт фоновую задачу: Вычитка',
  })
  expect(turnEnd({}, 'answer', 'Сделал.', [])).toEqual({ status: 'done', summary: 'Сделал.' })
  expect(turnEnd({ question: 'Да?' }, 'answer', '', [helper])).toMatchObject({ status: 'waiting' })
  expect(turnEnd({}, 'error', '', [helper])).toMatchObject({ status: 'error' })
  expect(turnEnd({}, 'aborted', '', [helper])).toEqual({ status: 'done', summary: 'Остановлен' })
  expect(backgroundWords([])).toBeUndefined()
  expect(backgroundWords([{ type: 'shell', command: 'build.ps1' }])).toBe('ждёт фоновую задачу: build.ps1')
  expect(backgroundWords([{ type: 'workflow', name: 'review' }])).toBe('ждёт фоновую задачу: review')
  expect(backgroundWords([{ type: 'subagent' }])).toBe('ждёт фоновую задачу')
  expect(backgroundWords([helper, helper, helper])).toBe('ждёт фоновые задачи: 3')
})

test('only work that ends and wakes the chat is waited for', () => {
  const watch = { type: 'monitor', description: 'live updates for artifact (auto-armed on publish)' }

  expect(backgroundWords([watch])).toBeUndefined()
  for (const type of ['dream', 'auto-mode scan', 'memory import', 'teammate', 'MCP task', 'cloud session', undefined]) {
    expect(backgroundWords([{ type, description: 'x' }])).toBeUndefined()
  }
  expect(backgroundWords([watch, { type: 'shell', description: 'Сборка' }])).toBe('ждёт фоновую задачу: Сборка')
  expect(turnEnd({}, 'answer', 'Готово.', [watch])).toEqual({ status: 'done', summary: 'Готово.' })
})
