import { expect, test } from 'claude-code/testing'

import { PANE, paneRow as row, seededWith } from './testkit'

const ROWS = [
  row({
    id: 'a',
    title: 'Логотип',
    folder: 'Дача',
    status: 'working',
    age: '2 мин',
    isRecent: true,
    progress: 'шаг 2 из 4: Нарисовать варианты · выполняет команду',
  }),
  row({
    id: 'b',
    title: 'Посты',
    folder: 'Дача',
    depth: 1,
    status: 'waiting',
    age: 'только что',
    isRecent: true,
    detail: 'Опубликовать пост сегодня?',
    answers: ['Да, сегодня', 'Завтра'],
  }),
  row({ id: 'e', title: 'Сайт', folder: 'Дача', status: 'done', age: '20 мин', isSelf: true, isRecent: true, detail: 'Сайт обновлён.' }),
  row({ id: 'f', title: 'Заметки', folder: 'Дача', status: 'error', age: '5 мин', isRecent: true, note: 'Claude выдал ошибку' }),
  row({ id: 'c', title: 'Таблицы', folder: 'Работа', status: 'done', age: '2 ч' }),
  row({ id: 'd', title: 'Старый', folder: 'Работа', status: 'unknown', age: '3 дн' }),
  row({ id: 'task:p', title: 'Почта', folder: 'Запланированные задачи', status: 'done', age: '1 ч', note: 'следующая через 2 ч' }),
  row({ id: 'task:q', title: 'Отчёт', folder: 'Запланированные задачи', status: 'unknown', note: 'выключена' }),
]

const seeded = seededWith(ROWS)

test('the pane draws the busy chats and every scheduled task, on every surface', async ($, on) => {
  on('state.get', seeded)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Логотип/ }))?.text).toContain('работает')
    expect((await ui.find({ type: 'Text', text: /Посты/ }))?.text).toContain('ждёт ответа')
    expect((await ui.find({ type: 'Text', text: /Сайт/ }))?.text).toContain('этот чат · готово · 20 мин')
    expect(await ui.find({ type: 'Text', text: /Таблицы/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Старый/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Работа$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /Почта/ }))?.text).toContain('готово · 1 ч · следующая через 2 ч')
    expect((await ui.find({ type: 'Text', text: /Отчёт/ }))?.text).toContain('выключена')
    expect(await ui.find({ type: 'Text', text: /шаг 2 из 4: Нарисовать варианты · выполняет команду/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Опубликовать пост сегодня\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Сайт обновлён\./ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Заметки/ }))?.text).toContain('ошибка · 5 мин · Claude выдал ошибку')
    expect(await ui.find({ key: 'b:Да, сегодня' })).toBeDefined()
    expect(await ui.find({ key: 'b:Завтра' })).toBeDefined()
    await ui.unmount()
  }
})

test('a reply pressed in the pane goes to the waiting chat, and its buttons give way', async ($, on) => {
  on('state.get', (_, e, next) =>
    e.key === 'rows' ? { value: { value: { shape: 'rows-4', value: ROWS }, version: 1 } } : next(e),
  )
  const messages: unknown[] = []
  on('mcp.call', (_, e) => {
    messages.push({ tool: e.tool, ...e.args })

    return { value: { content: [{ type: 'text' as const, text: 'delivered' }], isError: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'b:Завтра' })
  await pane.unmount()

  expect(messages).toEqual([
    {
      tool: 'send_message',
      session_id: 'b',
      message: 'Ответ пользователя на твой вопрос «Опубликовать пост сегодня?» (нажата кнопка в панели «Чаты» в другом чате): Завтра',
    },
  ])
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ key: 'b:Завтра' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /✓ отправлено: Завтра/ })).toBeDefined()
  await after.unmount()
})

test('with nothing busy, the pane says so and still lists the tasks', async ($, on) => {
  on('state.get', seededWith(ROWS.filter(one => one.folder !== 'Дача')))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /ни один чат не работает/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Почта/ })).toBeDefined()
  await ui.unmount()
})

test('the button opens, closes and opens the pane again, its word following', async ($, on) => {
  // The rows come from the test; whether the pane is up, from the kit's own state.
  on('state.get', (_, e, next) =>
    e.key === 'rows' ? { value: { value: { shape: 'rows-4', value: ROWS }, version: 1 } } : next(e),
  )
  const calls: string[] = []
  let isListed = false
  on('ui.panes', () => ({
    value: isListed ? [{ id: 'chat-colors', title: 'Чаты', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', () => {
    calls.push('open')
    isListed = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.push('close')
    isListed = false

    return { value: undefined }
  })

  const BAND = {
    plugin: 'chat-colors',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as const
  const word = async () => {
    const ui = await $.ui.mount(BAND)
    const button = await ui.find({ key: 'toggle' })
    await ui.unmount()

    return button?.text
  }
  const press = async () => {
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }

  expect(await word()).toBe('Все чаты')
  await press()
  expect(await word()).toBe('Скрыть чаты')
  await press()
  expect(await word()).toBe('Все чаты')
  await press()
  expect(await word()).toBe('Скрыть чаты')
  expect(calls).toEqual(['open', 'close', 'open'])
})

test('a value stored under another shape draws the empty list', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ id: 'x' }], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Загружаю/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows the busy chats and a button for the pane, on every surface', async ($, on) => {
  on('state.get', seeded)
  const opened: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('state.set', () => ({ value: { isSet: true, version: 2 } }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chat-colors',
      component: 'AbovePrompt',
      surface,
      props: {
        hasSurvey: false,
        isCollapsed: false,
        isWorking: false,
        maxRows: 4,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    })

    const band = (await ui.findAll({ type: 'Text' })).map(one => one.text).join(' ')
    expect(band).toContain('Логотип')
    expect(band).toContain('Посты')
    expect(band).toContain('Заметки')
    expect(band).not.toContain('Таблицы')
    expect(band).not.toContain('Старый')
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
  expect(opened).toEqual(['chat-colors', 'chat-colors', 'chat-colors', 'chat-colors'])
})

test('with only this chat busy, the band says no other chat works', async ($, on) => {
  on('state.get', seededWith(ROWS.filter(one => one.isSelf || !one.isRecent)))

  const ui = await $.ui.mount({
    plugin: 'chat-colors',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  })

  expect(await ui.find({ type: 'Text', text: /^Сейчас ни один другой чат не работает$/ })).toBeDefined()
  await ui.unmount()
})
