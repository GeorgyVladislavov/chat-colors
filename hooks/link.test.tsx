import { expect, test } from 'claude-code/testing'

import type { ChatRow } from '../types'
import { PANE, paneRow, seededWith } from './testkit'

// A chat's name in the pane is a link: pressed, the app opens that chat
// (claude://code/continue?session=<id>, handed to the system). Desktop only;
// this chat and the scheduled tasks stay plain.

const row = (more: Parameters<typeof paneRow>[0]): ChatRow => paneRow({ isRecent: true, ...more })
const ROWS = [
  row({ id: 'local_aaa-111', title: 'Логотип [новый] *срочно*', folder: 'Дача', status: 'working', age: '2 мин' }),
  row({ id: 'local_bbb-222', title: 'Посты', folder: 'Дача', status: 'done', age: '5 мин', detail: 'Готово.' }),
  row({ id: 'local_ccc-333', title: 'Сайт', folder: 'Дача', status: 'working', isSelf: true }),
  row({ id: 'task:p', title: 'Почта', folder: 'Запланированные задачи', status: 'done', age: '1 ч' }),
]
const LINK_A = 'https://claude.ai/code/local_aaa-111'

const seeded = seededWith(ROWS)

test('on the desktop each other chat is a link, with its line beside it', async ($, on) => {
  on('state.get', seeded)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const link = await ui.find({ key: 'open:local_aaa-111' })
  expect(link?.type).toBe('Markdown')
  // the name's own brackets and stars stay text, not markdown
  expect(link?.text).toBe(`[Логотип \\[новый\\] \\*срочно\\*](${LINK_A})`)
  expect(link?.props.pressableLinks).toEqual([LINK_A])
  expect(await ui.find({ key: 'open:local_bbb-222' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /работает · 2 мин/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /готово · 5 мин/ })).toBeDefined()
  // this chat and a scheduled task: no link, the name as before
  expect(await ui.find({ key: 'open:local_ccc-333' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Сайт/ }))?.text).toContain('этот чат')
  expect(await ui.find({ key: 'open:task:p' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Почта/ }))?.text).toContain('готово · 1 ч')
  await ui.unmount()
})

test('elsewhere the names stay plain text', async ($, on) => {
  on('state.get', seeded)
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
    expect((await ui.find({ type: 'Text', text: /Посты/ }))?.text).toContain('готово · 5 мин')
    await ui.unmount()
  }
})

test('pressing a name on Windows opens that chat through the app link', async ($, on) => {
  on('state.get', seeded)
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : 'C:\\Users\\test' }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:local_aaa-111', link: { href: LINK_A } })
  await ui.unmount()

  // Not explorer.exe: it swallows a claude:// link without passing it on (05.11.2026).
  expect(runs).toEqual([['rundll32.exe', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=local_aaa-111']])
  expect(toasts).toEqual([])
})

test('on Windows, if rundll32 cannot start, cmd start opens the link', async ($, on) => {
  on('state.get', seeded)
  on('fs.write', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : 'C:\\Users\\test' }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'rundll32.exe') return { deny: 'rundll32.exe: not found' }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:local_aaa-111', link: { href: LINK_A } })
  await ui.unmount()

  expect(runs).toEqual([
    ['rundll32.exe', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=local_aaa-111'],
    // the empty title, so that start takes the link for what to open
    ['cmd.exe', '/d', '/c', 'start', '', 'claude://code/continue?session=local_aaa-111'],
  ])
})

test('elsewhere it tries open, then xdg-open, and says so when neither starts', async ($, on) => {
  on('state.get', seeded)
  on('fs.write', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])

    return { deny: `${e.argv[0]}: not found` }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:local_bbb-222', link: { href: 'https://claude.ai/code/local_bbb-222' } })
  await ui.unmount()

  expect(runs).toEqual([
    ['open', 'claude://code/continue?session=local_bbb-222'],
    ['xdg-open', 'claude://code/continue?session=local_bbb-222'],
  ])
  expect(toasts).toEqual(['Не получилось открыть «Посты»'])
})

test('each chat in the pane carries the circle its sidebar title has, and so does the legend', async ($, on) => {
  on('state.get', seeded)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    // a circle of its own before each chat: the working chat and this one,
    // the done chat and the done task
    expect(texts.filter(text => text === '🔵 ')).toHaveLength(2)
    expect(texts.filter(text => text === '🟢 ')).toHaveLength(2)
    expect(texts.some(text => text.startsWith('🔵 Сайт'))).toBe(true)
    expect(texts.some(text => text.startsWith('🟢 Почта'))).toBe(true)
    // the legend: each circle bound to its word by no-break spaces, green just "done"
    expect(texts.some(text => text.includes('🟠\u00a0ждёт\u00a0ответа'))).toBe(true)
    expect(texts.some(text => text.includes('🟢\u00a0готово'))).toBe(true)
    expect(texts.some(text => text.includes('за час'))).toBe(false)
    expect(texts.some(text => text.includes('●'))).toBe(false)
    await ui.unmount()
  }
})