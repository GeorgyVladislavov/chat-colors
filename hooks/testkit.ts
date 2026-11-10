import type { Engine, TestBody } from 'claude-code/testing'

import type { ChatRow } from '../types'

// What the mod's tests share: the engine's side of a session, stood in for by
// hooks, and the pane as the host hands it over. No tests of its own here.

export type On = Parameters<TestBody>[1]
export type Record_ = Record<string, unknown>

// The engine spells paths its own way: the record is told by its name.
export const isRecord = (path: string) => /[\\/]chat-colors[\\/]cli-test\.json$/.test(path)

export type Setup = {
  // What the chat's record says when the session starts.
  held: Record_
  // The app's windows showing the chat.
  screens?: string[]
  // What $.agent.list() answers.
  agents?: Array<{ status: string }>
  // The chat's title before any mark, whether the app says it runs, and the
  // other chats the app lists.
  title?: string
  isRunning?: boolean
  others?: unknown[]
  // What turn.complete answers.
  answer?: string
  // Stands for a tool and its dialogs.
  runTool?: () => unknown
  // Takes the record's writes, for a test that reads them during a call.
  written?: Record_[]
  // Files and folders beyond the record; undefined for none.
  readFile?: (path: string) => string | undefined
  listDir?: (path: string) => unknown[] | undefined
}

// A session with every call on $ answered: what it wrote is read back from the
// arrays it returns.
export const startSession = async ($: Engine, on: On, setup: Setup) => {
  const records = setup.written ?? []
  const timers: number[] = []
  const titles: string[] = []
  const renames: { id: string; title: string }[] = []
  on('fs.write', (_, e) => {
    if (isRecord(e.path)) records.push(JSON.parse(e.text) as Record_)

    return { value: undefined }
  })
  on('fs.read', (_, e) => ({
    value: isRecord(e.path) ? JSON.stringify({ cliId: 'cli-test', ...setup.held }) : (setup.readFile?.(e.path) ?? ''),
  }))
  on('fs.list', (_, e) => ({ value: (setup.listDir?.(String(e.path ?? '')) ?? []) as never }))
  on('env.get', () => ({ value: 'C:\\Users\\test' }))
  on('session.id', () => ({ value: 'cli-test' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.surfaces', () => ({ value: (setup.screens ?? []) as never }))
  on('agent.list', () => ({ value: (setup.agents ?? []) as never }))
  on('clock.now', () => ({ value: Date.now() }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'set_session_title') {
      titles.push(String(e.args.title))
      renames.push({ id: String(e.args.session_id), title: String(e.args.title) })
    }
    const text =
      e.tool === 'get_session'
        ? JSON.stringify({
            sessionId: 'local_test',
            title: titles.at(-1) ?? setup.title ?? 'Отчёт',
            cwd: '/',
            isRunning: setup.isRunning ?? false,
            lastActivityAt: '',
          })
        : e.tool === 'list_sessions'
          ? JSON.stringify(setup.others ?? [])
          : e.tool === 'list_scheduled_tasks'
            ? '[]'
            : '{}'

    return { value: { content: [{ type: 'text' as const, text }], isError: false } }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', (_, e) => {
    timers.push(e.ms)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'chats' } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: setup.answer ?? 'Отчёт готов.' }))
  on('tool.call', async () => {
    await setup.runTool?.()

    return { result: {} }
  })
  on('classic.Stop', () => ({}))
  on('classic.Notification', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  return { records, timers, titles, renames }
}

// The record's writes, the renames and the reading of files go one after
// another: these let them land.
export const settle = async ($: Engine) => {
  for (let tick = 0; tick < 120; tick++) {
    await $.classic.Notification({ message: 'tick', notification_type: 'tick' })
  }
}

// The pane's mount, as the host hands it over.
export const PANE = {
  plugin: 'chat-colors',
  component: 'Pane',
  requestId: 'chat-colors',
  props: {
    title: 'Чаты',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

export const paneRow = (more: Pick<ChatRow, 'id' | 'title' | 'folder' | 'status'> & Partial<ChatRow>): ChatRow => ({
  depth: 0,
  age: '',
  isSelf: false,
  isRecent: false,
  note: '',
  detail: '',
  answers: [],
  progress: '',
  ...more,
})

// Stands for the host's state: the rows, the pane closed, nothing sent yet.
export const seededWith = (rows: object[]) => (_: unknown, e: { key: string }) => ({
  value:
    e.key === 'rows'
      ? { value: { shape: 'rows-4', value: rows }, version: 1 }
      : { value: e.key === 'sent' ? {} : false, version: 1 },
})
