import type { ChatRow, ChatStatus } from '../types'

// Turning the app's session list and the chats' own status files into the
// rows the pane and the band draw. Pure: register.tsx does the reading.

export const NO_FOLDER = 'Этот компьютер'
export const TASKS = 'Запланированные задачи'
// How long a finished chat stays in the band and the pane once the person has
// opened it; one nobody has opened stays until someone does.
export const SEEN_MS = 10 * 60000
// The same for a record from before that rule, or an end the chat did not
// write: counted from the end.
export const RECENT_MS = 60 * 60000
// A chat the app no longer runs, still saying it works this long after its
// last sign of life, ended its turn without writing so: a live chat mends its
// own record within seconds, so this long means nothing there mends it.
const ENDED_MS = 3 * 60000
// A tool running longer than this shows how long.
const LONG_TOOL_MS = 60000
// A record this far behind the app's last activity for its chat is an old one.
const BEHIND_MS = 2 * 60000

export type Written = 'working' | 'waiting' | 'done' | 'error'
// A question put to the person, still without an answer.
export type Asked = { question: string; answers?: string[] }

// What a chat puts in front of its own title, for the app's sidebar.
export const MARK: Record<Written, string> = { working: '🔵', waiting: '🟠', done: '🟢', error: '🔴' }
const MARKED = /^(?:🔵|🟠|🟢|🔴)\s*/u
export const stripMark = (title: string) => title.replace(MARKED, '').trim()

// What a chat writes about itself: its status, and what the pane says of it.
export type StatusFile = {
  cliId: string
  desktopId?: string
  status: Written
  // When the status last changed.
  at: number
  // The last sign of life: a turn, a tool starting or ending.
  activityAt?: number
  // How its last turn ended, in a sentence.
  summary?: string
  // What it asks the person, and the replies its closing question offers.
  question?: string
  answers?: string[]
  // Someone other than the person woke it while it asked: what to ask again
  // when that turn ends.
  unanswered?: Asked
  // Where its plan stands ("3 из 5: …"), and the tool running now, in words.
  step?: string
  doing?: string
  doingAt?: number
  // Its turn ended and work it left runs on: what it waits for, in words.
  background?: string
  // Why its turn broke.
  error?: string
  // A finished chat the person has not opened since, and when they did.
  unseen?: boolean
  seenAt?: number
}
export type Listed = {
  sessionId: string
  title: string
  cwd: string
  isRunning: boolean
  lastActivityAt: string
  startedBy?: string
}
// What never changes about a session, looked up once and kept in the store.
export type Meta = { task?: string }
export type Order = Record<string, number>
// A scheduled task as the app's scheduled-tasks server lists it.
export type ScheduledTask = { taskId: string; title?: string; enabled: boolean; nextRunAt?: string }

// The app's list as it may come: a chat it has not named or dated yet still
// gets its row, and what is not a chat at all does not break the others.
export const saneChats = (chats: unknown): Listed[] =>
  (Array.isArray(chats) ? (chats as Partial<Listed>[]) : [])
    .filter(chat => typeof chat?.sessionId === 'string' && chat.sessionId !== '')
    .map(chat => ({
      ...chat,
      sessionId: chat.sessionId!,
      title: typeof chat.title === 'string' ? chat.title : '',
      cwd: typeof chat.cwd === 'string' ? chat.cwd : '',
      isRunning: chat.isRunning === true,
      lastActivityAt: typeof chat.lastActivityAt === 'string' ? chat.lastActivityAt : '',
    }))

export const folderName = (cwd: string) => {
  if (cwd === '' || /scratch-workspaces/i.test(cwd)) return NO_FOLDER
  const parts = cwd.split(/[\\/]/).filter(Boolean)

  return parts[parts.length - 1] ?? cwd
}

// Folders as the sidebar lists them: by name, the chats with no folder last,
// the scheduled tasks below everything.
const folderRank = (name: string) => (name === TASKS ? 2 : name === NO_FOLDER ? 1 : 0)
const byFolder = (a: string, b: string) =>
  folderRank(a) - folderRank(b) || a.localeCompare(b, 'ru')

export const ageText = (ms: number) => {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч`

  return `${Math.floor(hours / 24)} дн`
}

const untilText = (ms: number) => {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'скоро'
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest > 0 ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`

  return `через ${Math.floor(hours / 24)} дн`
}

// A chat's status; for a red one, what went wrong; for one the mod did not
// hear ask, what it waits on. Red is only what the chat itself wrote: an
// error Claude gave; a chat gone quiet is not guessed at.
const stateOf = (
  chat: Listed,
  file: StatusFile | undefined,
  now: number,
): { status: ChatStatus; problem?: string; question?: string } => {
  if (file?.status === 'error') return { status: 'error', problem: file.error || 'ошибка' }
  // A chat that asks stays orange however long it waits.
  if (file?.status === 'waiting') return { status: 'waiting' }
  if (file?.status === 'working') {
    const quiet = now - (file.activityAt ?? file.at)
    // Stopped in the middle of a tool: a dialog holds it, the person's turn. Not
    // when it waits on work it left running, and not when no sign of life came
    // for this long: a live chat with a tool open beats, a dead one does not.
    if (!chat.isRunning && file.doing && !file.background && quiet <= RECENT_MS) {
      return { status: 'waiting', question: 'ждёт вашего ответа в чате' }
    }
    if (!chat.isRunning && quiet > ENDED_MS) return { status: 'done' }

    return { status: 'working' }
  }
  if (chat.isRunning) return { status: 'working' }
  if (file?.status === 'done') return { status: 'done' }

  return { status: 'unknown' }
}

// A finished chat: until the person has opened it, then a few minutes.
const isFreshDone = (file: StatusFile | undefined, since: number, now: number) => {
  if (file?.status === 'done' && file.unseen) return true
  if (file?.status === 'done' && file.seenAt !== undefined) return now - file.seenAt < SEEN_MS

  return now - since < RECENT_MS
}

// The app notes when its window last showed each chat, even one whose process
// sleeps and so cannot hear it: a finished chat shown after its end was seen
// then.
export const seenByFocus = (file: StatusFile, focusedAt: number | undefined): StatusFile =>
  file.status === 'done' && file.unseen && focusedAt !== undefined && focusedAt > file.at
    ? { ...file, unseen: undefined, seenAt: focusedAt }
    : file

// A sleeping chat cannot take its own mark off: a finished one whose time in
// the band is over and whose title is still green is unmarked by a chat that
// runs, and so is a blue one that died in the middle of a turn. A running
// chat, this one, and a task's runs see to their own.
export const staleMarks = ({
  all,
  meta,
  files,
  focused,
  selfId,
  now,
}: Pick<Sources, 'all' | 'meta' | 'files' | 'focused' | 'selfId' | 'now'>) =>
  saneChats(all).filter(chat => {
    if (chat.isRunning || chat.sessionId === selfId || meta[chat.sessionId]?.task) return false
    const held = files.get(chat.sessionId)
    if (!held) return false
    const isFinished = chat.title.startsWith(MARK.done) && held.status === 'done'
    const isDead =
      chat.title.startsWith(MARK.working) && held.status === 'working' && stateOf(chat, held, now).status === 'done'
    if (!isFinished && !isDead) return false
    // A record behind the chat's last activity may not be its latest: left
    // alone for a while. Not for good: the app moves that time with no turn.
    const lastActive = Date.parse(chat.lastActivityAt)
    const isBehind = !Number.isNaN(lastActive) && lastActive > (held.activityAt ?? held.at) + BEHIND_MS
    if (isBehind && now - lastActive < SEEN_MS) return false
    const file = seenByFocus(held, focused?.get(chat.sessionId))

    return !isFreshDone(file, file.at, now)
  })

// What a working chat is busy with: its plan's step, and the tool running now.
const progressOf = (file: StatusFile | undefined, now: number) => {
  if (!file) return ''
  const isLong = file.doing && file.doingAt !== undefined && now - file.doingAt > LONG_TOOL_MS
  const doing = file.doing ? `${file.doing}${isLong ? ` ${ageText(now - file.doingAt!)}` : ''}` : ''

  return [file.step ? `шаг ${file.step}` : '', doing, file.background].filter(Boolean).join(' · ')
}

const rootFinder = (chats: Listed[]) => {
  const ids = new Set(chats.map(chat => chat.sessionId))
  const parentOf = new Map(chats.map(chat => [chat.sessionId, chat.startedBy]))

  return (id: string) => {
    let at = id
    for (let step = 0; step < 50; step++) {
      const parent = parentOf.get(at)
      if (!parent || !ids.has(parent)) return at
      at = parent
    }

    return at
  }
}

// Each chat gets its place once and keeps it. The first time, places follow
// the sidebar (most recent first, a chat by the most recent of its family);
// a chat seen later goes above the others, as the sidebar puts it. Answers
// the order with the new places, or undefined when nothing was new.
export const placeNew = (order: Order, listed: Listed[]): Order | undefined => {
  const chats = saneChats(listed)
  const fresh = chats.filter(chat => order[chat.sessionId] === undefined)
  if (fresh.length === 0) return undefined

  const rootOf = rootFinder(chats)
  const latest = new Map<string, string>()
  for (const chat of chats) {
    const root = rootOf(chat.sessionId)
    if (chat.lastActivityAt > (latest.get(root) ?? '')) latest.set(root, chat.lastActivityAt)
  }
  const keyOf = (chat: Listed) =>
    rootOf(chat.sessionId) === chat.sessionId ? (latest.get(chat.sessionId) ?? '') : chat.lastActivityAt
  const placed = { ...order }
  const sorted = [...fresh].sort((a, b) => keyOf(b).localeCompare(keyOf(a)))
  if (Object.keys(order).length === 0) {
    sorted.forEach((chat, index) => (placed[chat.sessionId] = index))
  } else {
    let low = Object.values(order).reduce((min, one) => Math.min(min, one), 0)
    for (const chat of sorted.reverse()) placed[chat.sessionId] = --low
  }

  return placed
}

export type Sources = {
  all: Listed[]
  meta: Record<string, Meta>
  files: Map<string, StatusFile>
  order: Order
  // Absent when the scheduled-tasks server could not be asked: the tasks are
  // then the ones the runs name.
  tasks?: ScheduledTask[]
  selfId?: string
  // This chat's own record, as it keeps it: it is alive, so never stuck.
  selfFile?: StatusFile
  // When the app's window last showed a chat, by the app's own note, for the
  // finished chats nobody had seen; absent where the app's files were not found.
  focused?: Map<string, number>
  now: number
}

export const buildRows = ({ all: listed, meta, files, order, tasks, selfId, selfFile, focused, now }: Sources) => {
  const all = saneChats(listed)
  const rowOf = (chat: Listed, folder: string, depth: number): ChatRow => {
    const isSelf = chat.sessionId === selfId
    const held = isSelf ? selfFile : files.get(chat.sessionId)
    const file = held && !isSelf ? seenByFocus(held, focused?.get(chat.sessionId)) : held
    const { status, problem, question }: { status: ChatStatus; problem?: string; question?: string } = isSelf
      ? { status: selfFile?.status ?? 'unknown', problem: selfFile?.error }
      : stateOf(chat, file, now)
    const since = !file ? Date.parse(chat.lastActivityAt) : file.at
    // Working, broken or waiting on the person: shown until that changes; done,
    // until the person has seen it.
    const isRecent =
      status === 'working' || status === 'error' || status === 'waiting' || (status === 'done' && isFreshDone(file, since, now))
    const detail =
      status === 'waiting'
        ? (file?.question ?? question ?? '')
        : status === 'done' || status === 'error'
          ? (file?.summary ?? '')
          : ''

    return {
      id: chat.sessionId,
      title: stripMark(chat.title) || 'Без названия',
      folder,
      depth,
      status,
      age: Number.isNaN(since) ? '' : ageText(now - since),
      isSelf,
      isRecent,
      note: status === 'error' ? (problem ?? '') : '',
      detail,
      answers: status === 'waiting' ? (file?.answers ?? []) : [],
      askedAt: status === 'waiting' ? file?.at : undefined,
      progress: status === 'working' ? progressOf(file, now) : '',
    }
  }

  // As the sidebar draws them: each first chat, then every chat started
  // from it, one step in.
  const chats = all.filter(chat => !meta[chat.sessionId]?.task)
  const rootOf = rootFinder(chats)
  const place = (chat: Listed) => order[chat.sessionId] ?? 0
  const list: ChatRow[] = []
  const roots = chats.filter(chat => rootOf(chat.sessionId) === chat.sessionId)
  const folders = [...new Set(roots.map(chat => folderName(chat.cwd)))].sort(byFolder)
  for (const folder of folders) {
    const inFolder = roots.filter(chat => folderName(chat.cwd) === folder)
    for (const root of inFolder.sort((a, b) => place(a) - place(b))) {
      list.push(rowOf(root, folder, 0))
      const family = chats.filter(chat => chat !== root && rootOf(chat.sessionId) === root.sessionId)
      for (const chat of family.sort((a, b) => place(a) - place(b))) {
        list.push(rowOf(chat, folder, 1))
      }
    }
  }

  // A scheduled task is one row: colored by its latest run, with its next one.
  const runs = all
    .filter(chat => meta[chat.sessionId]?.task)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const known: ScheduledTask[] =
    tasks ??
    [...new Set(runs.map(run => meta[run.sessionId]!.task!))]
      .sort()
      .map(taskId => ({ taskId, enabled: true }))
  for (const task of known) {
    const run = runs.find(one => meta[one.sessionId]?.task === task.taskId)
    const title = task.title ?? (run ? stripMark(run.title) : task.taskId)
    const latest: ChatRow = run
      ? rowOf(run, TASKS, 0)
      : {
          id: '',
          title,
          folder: TASKS,
          depth: 0,
          status: 'unknown',
          age: '',
          isSelf: false,
          isRecent: false,
          note: '',
          detail: '',
          answers: [],
          progress: '',
        }
    const nextAt = task.nextRunAt ? Date.parse(task.nextRunAt) : NaN
    const next = !task.enabled
      ? 'выключена'
      : Number.isNaN(nextAt)
        ? ''
        : `следующая ${untilText(nextAt - now)}`
    // A run that found something important says so in its title.
    const isAlert = run ? stripMark(run.title).startsWith('⚠') : false
    const note = [latest.note, isAlert ? '⚠ есть важное' : '', next].filter(Boolean).join(' · ')
    // The row stands for the task; a reply goes to the chat of its latest run.
    list.push({ ...latest, id: `task:${task.taskId}`, chatId: latest.id || undefined, title, note })
  }

  return list
}
