import { expect, test } from 'claude-code/testing'

import { buildRows, placeNew, stripMark } from './rows'
import type { Listed, ScheduledTask, StatusFile } from './rows'

const chat = (id: string, title: string, cwd: string, at: string, more = {}): Listed => ({
  sessionId: id,
  title,
  cwd,
  isRunning: false,
  lastActivityAt: at,
  ...more,
})

const HOME = 'C:\\Users\\user\\Desktop\\Дача'
const WORK = 'C:\\Users\\user\\Desktop\\Работа'
const SCRATCH = 'C:\\Users\\user\\AppData\\Local\\Claude-Data\\x\\scratch-workspaces\\a\\b'
const NOW = Date.parse('2026-11-03T11:10:00Z')

const ALL = [
  chat('me', 'Этот', SCRATCH, '2026-11-03T11:05:00Z'),
  chat('child', 'Ребёнок', HOME, '2026-11-03T11:00:00Z', { startedBy: 'root', isRunning: true }),
  chat('grandchild', 'Внук', HOME, '2026-11-03T10:50:00Z', { startedBy: 'child' }),
  chat('mail1', 'Почта: уже проверено', HOME, '2026-11-03T10:00:00Z'),
  chat('table', 'Таблицы', WORK, '2026-11-03T09:00:00Z'),
  chat('mail2', 'Почта по расписанию', HOME, '2026-11-02T10:00:00Z'),
  chat('old', 'Старый чат', HOME, '2026-11-01T10:00:00Z'),
  chat('root', 'Корень', HOME, '2026-10-25T10:00:00Z'),
]
const META = { mail1: { task: 'digest' }, mail2: { task: 'digest' } }
const FILES = new Map<string, StatusFile>([
  ['table', { cliId: 'a', desktopId: 'table', status: 'waiting', at: NOW - 5 * 60000 }],
  ['old', { cliId: 'b', desktopId: 'old', status: 'done', at: NOW - 3 * 3600000 }],
])

const build = (tasks?: ScheduledTask[]) => {
  const chats = ALL.filter(one => !(one.sessionId in META))
  const order = placeNew({}, chats)!

  return buildRows({
    all: ALL,
    meta: META,
    files: FILES,
    order,
    tasks,
    selfId: 'me',
    selfFile: { cliId: 'me', status: 'working', at: NOW },
    now: NOW,
  })
}

const TASKS = [
  { taskId: 'digest', title: 'Почта — 10 и 16', enabled: true, nextRunAt: '2026-11-03T13:12:00Z' },
  { taskId: 'off', title: 'Выключенная', enabled: false },
]

const rowsOf = (all: Listed[], files: Map<string, StatusFile>) => buildRows({ all, meta: {}, files, order: {}, now: NOW })

test('runs of a task fold into one row with its next run, below the chats', () => {
  const list = build(TASKS)

  expect(list.filter(row => row.folder === 'Запланированные задачи')).toEqual([
    expect.objectContaining({ id: 'task:digest', title: 'Почта — 10 и 16', note: 'следующая через 2 ч 2 мин' }),
    expect.objectContaining({ id: 'task:off', title: 'Выключенная', status: 'unknown', note: 'выключена' }),
  ])
  expect(list.filter(row => /Почта/.test(row.title))).toHaveLength(1)
})

test('without the task list, the tasks are the ones the runs name', () => {
  const list = build()

  expect(list.filter(row => row.folder === 'Запланированные задачи')).toEqual([
    expect.objectContaining({ id: 'task:digest', title: 'Почта: уже проверено', note: '' }),
  ])
})

test('a run that found something important marks its task', () => {
  const alert = chat('mail3', '⚠ Почта: есть вопрос', HOME, '2026-11-03T11:00:00Z')
  const list = buildRows({
    all: [...ALL, alert],
    meta: { ...META, mail3: { task: 'digest' } },
    files: FILES,
    order: {},
    tasks: TASKS,
    now: NOW,
  })

  expect(list.find(row => row.id === 'task:digest')?.note).toBe('⚠ есть важное · следующая через 2 ч 2 мин')
})

test('folders and families are laid out as the sidebar lays them', () => {
  const list = build()

  expect(list.map(row => `${row.folder}|${row.depth}|${row.title}`)).toEqual([
    'Дача|0|Корень',
    'Дача|1|Ребёнок',
    'Дача|1|Внук',
    'Дача|0|Старый чат',
    'Работа|0|Таблицы',
    'Этот компьютер|0|Этот',
    'Запланированные задачи|0|Почта: уже проверено',
  ])
})

test('each chat is colored by what it does, and the band takes the busy ones', () => {
  const byTitle = Object.fromEntries(build().map(row => [row.title, row]))

  expect(byTitle['Ребёнок']).toMatchObject({ status: 'working', isRecent: true })
  expect(byTitle['Таблицы']).toMatchObject({ status: 'waiting', isRecent: true, age: '5 мин' })
  expect(byTitle['Старый чат']).toMatchObject({ status: 'done', isRecent: false, age: '3 ч' })
  expect(byTitle['Корень']).toMatchObject({ status: 'unknown', isRecent: false })
  expect(byTitle['Этот']).toMatchObject({ status: 'working', isSelf: true })
})

test('the mark a chat puts in its title is not drawn twice', () => {
  const marked = chat('marked', '🔵 Логотип', HOME, '2026-11-03T11:00:00Z', { isRunning: true })
  const list = buildRows({ all: [marked], meta: {}, files: new Map(), order: {}, now: NOW })

  expect(list[0]).toMatchObject({ title: 'Логотип', status: 'working' })
  expect(stripMark('🟢  Почта')).toBe('Почта')
  expect(stripMark('⚠ Почта')).toBe('⚠ Почта')
})

test('a waiting chat carries its question and replies, a done one how it ended', () => {
  const files = new Map<string, StatusFile>([
    ['w', { cliId: 'w', desktopId: 'w', status: 'waiting', at: NOW, question: 'Публикуем?', answers: ['Да', 'Нет'] }],
    ['d', { cliId: 'd', desktopId: 'd', status: 'done', at: NOW, summary: 'Пост готов.', answers: ['Да'] }],
    ['r', { cliId: 'r', desktopId: 'r', status: 'working', at: NOW, step: '2 из 5: Текст', doing: 'ищет в интернете', doingAt: NOW - 3 * 60000 }],
  ])
  const list = rowsOf([
    chat('w', 'Ждёт', HOME, '2026-11-03T11:00:00Z'),
    chat('d', 'Готов', HOME, '2026-11-03T11:00:00Z'),
    chat('r', 'Работает', HOME, '2026-11-03T11:00:00Z', { isRunning: true }),
  ], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Ждёт']).toMatchObject({ status: 'waiting', detail: 'Публикуем?', answers: ['Да', 'Нет'], progress: '' })
  expect(byTitle['Готов']).toMatchObject({ status: 'done', detail: 'Пост готов.', answers: [] })
  expect(byTitle['Работает']).toMatchObject({
    status: 'working',
    detail: '',
    progress: 'шаг 2 из 5: Текст · ищет в интернете 3 мин',
  })
})

test('a chat that asks stays orange however long it waits, and is never taken for broken', () => {
  const files = new Map<string, StatusFile>([
    // Asked three hours ago, no answer since.
    ['w', { cliId: 'w', desktopId: 'w', status: 'waiting', at: NOW - 3 * 3600000, activityAt: NOW - 3 * 3600000, question: 'Публикуем?' }],
    // Held by a dialog the mod did not hear: the app no longer runs it, a tool is open.
    ['p', { cliId: 'p', desktopId: 'p', status: 'working', at: NOW - 20 * 60000, activityAt: NOW - 20 * 60000, doing: 'выполняет команду', doingAt: NOW - 20 * 60000 }],
  ])
  const list = rowsOf([chat('w', 'Ждёт давно', HOME, '2026-11-03T08:00:00Z'), chat('p', 'Окошко', HOME, '2026-11-03T10:50:00Z')], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Ждёт давно']).toMatchObject({ status: 'waiting', isRecent: true, detail: 'Публикуем?' })
  expect(byTitle['Окошко']).toMatchObject({ status: 'waiting', isRecent: true, detail: 'ждёт вашего ответа в чате' })
})

test('a record from an older mod, which beats with no tools, never turns red', () => {
  const files = new Map<string, StatusFile>([
    ['o', { cliId: 'o', desktopId: 'o', status: 'working', at: NOW - 30 * 60000 }],
    ['s', { cliId: 's', desktopId: 's', status: 'working', at: NOW - 30 * 60000 }],
  ])
  const list = rowsOf([
    chat('o', 'Старый код работает', HOME, '2026-11-03T11:00:00Z', { isRunning: true }),
    chat('s', 'Старый код закончил', HOME, '2026-11-03T11:00:00Z'),
  ], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Старый код работает']).toMatchObject({ status: 'working' })
  expect(byTitle['Старый код закончил']).toMatchObject({ status: 'done' })
})

test('only an error Claude gave turns a chat red; a quiet or ended one is not guessed at', () => {
  const files = new Map<string, StatusFile>([
    ['e', { cliId: 'e', desktopId: 'e', status: 'error', at: NOW, error: 'Claude выдал ошибку' }],
    // The app runs it no more, its record still says it works: its end went unwritten.
    ['b', { cliId: 'b', desktopId: 'b', status: 'working', at: NOW - 5 * 60000, activityAt: NOW - 4 * 60000 }],
    // Its turn just ended and it has not mended its record yet: given the time to.
    ['g', { cliId: 'g', desktopId: 'g', status: 'working', at: NOW - 5 * 60000, activityAt: NOW - 2 * 60000 }],
    // Quiet for a long while, still running: still blue.
    ['q', { cliId: 'q', desktopId: 'q', status: 'working', at: NOW - 30 * 60000, activityAt: NOW - 16 * 60000 }],
    ['t', { cliId: 't', desktopId: 't', status: 'working', at: NOW - 30 * 60000, activityAt: NOW - 25 * 60000, doing: 'выполняет команду', doingAt: NOW - 25 * 60000 }],
  ])
  const list = rowsOf([
    chat('e', 'Ошибка', HOME, '2026-11-03T11:00:00Z'),
    chat('b', 'Закончил молча', HOME, '2026-11-03T11:00:00Z'),
    chat('g', 'Только что закончил', HOME, '2026-11-03T11:00:00Z'),
    chat('q', 'Молчит', HOME, '2026-11-03T11:00:00Z', { isRunning: true }),
    chat('t', 'Долгая команда', HOME, '2026-11-03T11:00:00Z', { isRunning: true }),
  ], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Ошибка']).toMatchObject({ status: 'error', note: 'Claude выдал ошибку', isRecent: true })
  expect(byTitle['Закончил молча']).toMatchObject({ status: 'done', note: '' })
  expect(byTitle['Только что закончил']).toMatchObject({ status: 'working', note: '' })
  expect(byTitle['Молчит']).toMatchObject({ status: 'working', note: '' })
  expect(byTitle['Долгая команда']).toMatchObject({ status: 'working', progress: 'выполняет команду 25 мин' })
})

test('a finished chat stays until the person opens it, then ten minutes', () => {
  const files = new Map<string, StatusFile>([
    // Ended in the night, not opened since.
    ['n', { cliId: 'n', desktopId: 'n', status: 'done', at: NOW - 8 * 3600000, unseen: true }],
    ['s', { cliId: 's', desktopId: 's', status: 'done', at: NOW - 3 * 3600000, seenAt: NOW - 9 * 60000 }],
    ['l', { cliId: 'l', desktopId: 'l', status: 'done', at: NOW - 20 * 60000, seenAt: NOW - 11 * 60000 }],
    // Written before the rule: an hour from the end.
    ['o', { cliId: 'o', desktopId: 'o', status: 'done', at: NOW - 30 * 60000 }],
  ])
  const list = rowsOf([
    chat('n', 'Ночной', HOME, '2026-11-03T03:00:00Z'),
    chat('s', 'Только что открыт', HOME, '2026-11-03T08:00:00Z'),
    chat('l', 'Открыт давно', HOME, '2026-11-03T10:50:00Z'),
    chat('o', 'Старая запись', HOME, '2026-11-03T10:40:00Z'),
  ], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Ночной']).toMatchObject({ status: 'done', isRecent: true })
  expect(byTitle['Только что открыт']).toMatchObject({ status: 'done', isRecent: true })
  expect(byTitle['Открыт давно']).toMatchObject({ status: 'done', isRecent: false })
  expect(byTitle['Старая запись']).toMatchObject({ status: 'done', isRecent: true })
})

test('a chat never moves: a new one goes on top, the rest keep their places', () => {
  const chats = ALL.filter(one => !(one.sessionId in META))
  const order = placeNew({}, chats)!
  const fresh = chat('new', 'Новый', HOME, '2026-11-03T11:20:00Z')
  const again = placeNew(order, [...chats, fresh])!

  for (const one of chats) expect(again[one.sessionId]).toBe(order[one.sessionId])
  expect(again.new).toBeLessThan(Math.min(...Object.values(order)))
  expect(placeNew(again, [...chats, fresh])).toBeUndefined()
})

test('a chat waiting on its background work says so, blue though the app says it does not run', () => {
  const background = 'ждёт фоновую задачу: Вычитка текста'
  const files = new Map<string, StatusFile>([
    ['h', { cliId: 'h', desktopId: 'h', status: 'working', at: NOW - 20 * 60000, activityAt: NOW - 30000, step: '5 из 6: Проверить тексты', background }],
    // Its process is gone: no signs of life any more, so it ended.
    ['x', { cliId: 'x', desktopId: 'x', status: 'working', at: NOW - 20 * 60000, activityAt: NOW - 4 * 60000, background }],
  ])
  const list = rowsOf([chat('h', 'Ждёт вычитку', HOME, '2026-11-03T11:00:00Z'), chat('x', 'Процесс умер', HOME, '2026-11-03T11:00:00Z')], files)
  const byTitle = Object.fromEntries(list.map(row => [row.title, row]))

  expect(byTitle['Ждёт вычитку']).toMatchObject({
    status: 'working',
    isRecent: true,
    progress: `шаг 5 из 6: Проверить тексты · ${background}`,
  })
  expect(byTitle['Процесс умер']).toMatchObject({ status: 'done', progress: '' })
})
