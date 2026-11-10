import type { EngineInterface, Register, Timer } from 'claude-code'

import { readFocus } from './appfiles'
import { SERVER, TASKS_SERVER, callJson, loadJournal, myFile, note, selfInfo, sessionId, statusDir } from './host'
import type { Self } from './host'
import {
  PERMISSION_ASK,
  PLAN_ASK,
  askerOf,
  closingOf,
  followPlan,
  isDialogAsk,
  isDialogTool,
  isOtherSender,
  planStep,
  toolWords,
  turnEnd,
} from './record'
import type { BackgroundTask, Closing, PlanItem, ToolRun } from './record'
import { MARK, RECENT_MS, SEEN_MS, buildRows, placeNew, saneChats, staleMarks, stripMark } from './rows'
import type { Listed, Meta, Order, ScheduledTask, StatusFile, Written } from './rows'
import { registerView, showRows, shorten, shownRows, startView } from './view'

// Every session that loads this mod writes a record of itself to
// ~/.claude/chat-colors/<session>.json: its status, what it does now, how its
// last turn ended, what it asks. This file keeps that record and reads them
// all with the app's session list into `rows`, which view.tsx draws. The
// README has the map of the other files.

const POLL_MS = 4000
const TASKS_MS = 60000
const FIRST_MARK_MS = 15000
const BUSY_MS = 30000
const ALIVE_MS = 60000
// Nothing is running any more: what a record clears when a tool or a turn ends.
const NOT_DOING = { doing: undefined, doingAt: undefined }

type Mine = Omit<StatusFile, 'cliId' | 'desktopId'>

// Module state: starts over on a reload, which only costs a re-lookup; this
// chat's own record is read back from its file.
let mine: Mine | undefined
let saving: Promise<void> = Promise.resolve()
// What the running turn's closing box says, kept for the turn's end.
let closing: Closing = {}
// What this turn leaves running, told just before it ends.
let leftRunning: readonly BackgroundTask[] = []
// The tool calls under way: a dialog in front of the person belongs to one of
// them and ends with it.
const toolRuns: ToolRun[] = []
let plan: PlanItem[] = []
let isBusy = false
let busySince = 0
let lastTickAt = 0
let tasks: ScheduledTask[] | undefined
let tasksAt = 0
let wantedMark: Written | undefined
let isMarking = false
// The title the app last refused to change: the person typed it, and the app
// changes such a title only with their yes, which a mod's call cannot ask for.
// The refusal holds for this title alone: each new status tries again (the app
// answers at once and shows nothing), so the marks come back as soon as the
// title is Claude's or the app's again. How to give a chat its marks back:
// README.md, «Для Claude: кружок в названии застыл».
let refusedTitle: string | undefined
let markTimer: Timer | undefined
const fileCache = new Map<string, { mtimeMs: number; file?: StatusFile }>()
// Sleeping chats this one took the green mark off lately: asked once a minute.
const unmarkedAt = new Map<string, number>()
const UNMARK_AGAIN_MS = 60000
// The person wrote to this turn from the phone (Remote Control): they read its
// end there.
let isPhoneTurn = false
// Who wrote for the next turn: one only others started leaves what the chat
// asked the person asked.
let nextTurnBy: 'nobody' | 'others' | 'person' = 'nobody'

// Kept from the last answer when the server cannot be asked this time.
const scheduledTasks = async ($: EngineInterface, now: number) => {
  if (tasks && now - tasksAt < TASKS_MS) return tasks
  const found = await callJson($, 'list_scheduled_tasks', {}, TASKS_SERVER).catch(() => undefined)
  if (Array.isArray(found)) {
    tasks = found as ScheduledTask[]
    tasksAt = now
  }

  return tasks
}

// Writes this chat's record, one write at a time, the latest last.
const save = ($: EngineInterface) => {
  saving = saving
    .then(async () => {
      if (!mine) return
      const desktopId = (await selfInfo($, Date.now()))?.sessionId
      const file: StatusFile = { ...mine, cliId: await sessionId($), desktopId }
      await $.fs.write(await myFile($), JSON.stringify(file))
    })
    .catch(() => undefined)
}

// Changes what the record says beside the status, with a sign of life.
const patch = ($: EngineInterface, fields: Partial<Mine>) => {
  const now = Date.now()
  mine = { status: 'done', at: now, ...mine, ...fields, activityAt: now }
  save($)
}

// The mark in the chat's own title, so the app's sidebar shows the status too.
// One rename at a time: a status that changes meanwhile is applied after it.
// False when the app refused: the title is the person's.
const applyMark = async ($: EngineInterface, status: Written | undefined) => {
  const found = (await callJson($, 'get_session', { session_id: 'self' })) as Self | undefined
  if (!found?.sessionId || found.scheduledTaskId) return true
  const base = stripMark(found.title ?? '')
  if (!base) return true
  const title = status ? `${MARK[status]} ${base}` : base
  if (title === found.title) return true
  // Only the app's own error says the title is the person's: a success repeats
  // the title, whatever its words, and another error can pass ("Session self
  // not found"). Until 0.5.10 such a refusal stopped the marks for good, and
  // the mark already in the title stayed, wrong, for as long as the chat lived.
  const result = await $.mcp.call(SERVER, 'set_session_title', { session_id: 'self', title })
  const text = result.content.map(block => ('text' in block ? String(block.text) : '')).join(' ')
  if (result.isError && /set by the user|declin|denied|refus|reject/i.test(text)) {
    if (refusedTitle !== found.title) {
      note($, `кружок в названии не поменять: название «${shorten(base)}» задано вручную, приложение меняет его только с разрешения человека`)
    }
    refusedTitle = found.title

    return false
  }
  refusedTitle = undefined

  return true
}

const markTitle = ($: EngineInterface, status: Written | undefined) => {
  wantedMark = status
  if (isMarking) return
  isMarking = true
  void (async () => {
    for (let pass = 0; pass < 3; pass++) {
      const wanted = wantedMark
      const isApplied = await applyMark($, wanted)
      if (wantedMark === wanted || !isApplied) break
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      isMarking = false
    })
}

// A new status: the record says what goes with it, the title takes its mark.
const setStatus = ($: EngineInterface, status: Written, fields: Partial<Mine> = {}, isPhone = false) => {
  const isChange = mine?.status !== status
  const fresh = isChange ? { unseen: undefined, seenAt: undefined } : {}
  patch($, { ...fresh, ...fields, status, at: isChange ? Date.now() : (mine?.at ?? Date.now()) })
  if (!isChange) return
  note($, `статус: ${status}`)
  markTimer?.cancel()
  markTimer = undefined
  void (async () => {
    // A new chat's first turn waits for the app to name the chat first.
    const isFirstTurn = status === 'working' && (await $.session.turns()) <= 1
    if (isFirstTurn) {
      markTimer = $.clock.after(FIRST_MARK_MS, () => {
        if (mine?.status === 'working') markTitle($, 'working')
      })
    } else {
      markTitle($, status)
    }
    if (status === 'done') await ended($, isPhone)
  })().catch(() => undefined)
}

// A finished chat loses its mark when it leaves the band: `ms` from now.
const unmarkAfter = ($: EngineInterface, ms: number) => {
  markTimer?.cancel()
  markTimer = $.clock.after(Math.max(ms, 0), () => {
    if (mine?.status === 'done') markTitle($, undefined)
  })
}

// The person has seen how the chat ended, now or at `at`: a few minutes more.
const seen = ($: EngineInterface, at?: number, why = 'итог увиден') => {
  const now = Date.now()
  patch($, { unseen: undefined, seenAt: at ?? now })
  note($, why)
  unmarkAfter($, at === undefined ? SEEN_MS : at + SEEN_MS - now)
}

// A window of the app shows the chat on screen, and the app lets it go when
// the person goes elsewhere: a chat that ends with none waits for one. A turn
// the person wrote to from the phone ends where they read it. A run of a
// scheduled task, which nobody opens, keeps the hour.
const ended = async ($: EngineInterface, isPhone = false) => {
  if ((await selfInfo($, Date.now()))?.scheduledTaskId) return unmarkAfter($, RECENT_MS)
  if ((await $.session.surfaces()).length > 0) return seen($)
  if (isPhone) return seen($, undefined, 'итог увиден на телефоне')
  patch($, { unseen: true })
}

// The chat waits on the person: a dialog or a permission.
const ask = ($: EngineInterface, question: string) => setStatus($, 'waiting', { question, answers: [] })

// A sleeping chat cannot take its own mark off when its minutes are up: a
// running one does it for it.
const unmarkSleeping = async ($: EngineInterface, chat: Listed) => {
  const now = Date.now()
  if (now - (unmarkedAt.get(chat.sessionId) ?? 0) < UNMARK_AGAIN_MS) return
  unmarkedAt.set(chat.sessionId, now)
  const title = stripMark(chat.title)
  if (!title) return
  const result = await $.mcp.call(SERVER, 'set_session_title', { session_id: chat.sessionId, title })
  if (!result.isError) note($, `снял кружок со спящего чата «${shorten(title)}»`)
}

// After a reload or a restart, a finished chat picks up where it stood.
const resume = async ($: EngineInterface, isReload: boolean) => {
  // It was at work, waited on background work, or held a dialog. A reload of
  // the mod leaves all of that running; a restart ends it, and then nothing
  // will write its end or wake the chat, unless a turn or a helper still runs.
  if (mine?.status === 'working' || (mine?.status === 'waiting' && isDialogAsk(mine.question))) {
    if (isReload) return
    const agents = await $.agent.list().catch(() => [])
    const isAlive = agents.some(one => ['pending', 'running', 'waiting'].includes(one.status))
    if (isAlive || (await selfInfo($, Date.now()))?.isRunning) return
    note($, 'запущен заново: прежний ход оборвался')
    setStatus($, 'done', { background: undefined, question: undefined, answers: undefined, ...NOT_DOING })
    return
  }
  if (mine?.status !== 'done') return
  if (mine.unseen) {
    if ((await $.session.surfaces()).length > 0) seen($)
    return
  }
  const until = mine.seenAt !== undefined ? mine.seenAt + SEEN_MS : mine.at + RECENT_MS
  unmarkAfter($, until - Date.now())
}

// The turn's end, told once at turn.complete.
const endTurn = ($: EngineInterface, reason: string, text: string) => {
  const { status, ...fields } = turnEnd(closing, reason, text, leftRunning, mine?.unanswered)
  const isPhone = isPhoneTurn
  // Still at work: the end the person reads on the phone is the later one.
  if (status !== 'working') isPhoneTurn = false
  setStatus(
    $,
    status,
    { background: undefined, unanswered: undefined, ...fields, ...NOT_DOING, step: planStep(plan) },
    isPhone,
  )
  closing = {}
  leftRunning = []
  nextTurnBy = 'nobody'
}

// A file is read again only when it changed since the last tick.
const readFiles = async ($: EngineInterface) => {
  const folder = await statusDir($)
  const entries = await $.fs.list(folder).catch(() => [])
  const files = new Map<string, StatusFile>()
  const written = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    let cached = fileCache.get(entry.name)
    if (cached?.mtimeMs !== entry.mtimeMs) {
      const text = await $.fs.read(`${folder}/${entry.name}`).catch(() => '')
      try {
        cached = { mtimeMs: entry.mtimeMs, file: JSON.parse(String(text)) as StatusFile }
      } catch {
        // a file caught mid-write is read again on the next tick
        cached = { mtimeMs: -1 }
      }
      fileCache.set(entry.name, cached)
    }
    // A chat the app moved to a new process leaves its old record behind: the
    // one written last is the chat's.
    const id = cached.file?.desktopId
    if (cached.file && id && entry.mtimeMs >= (written.get(id) ?? -Infinity)) {
      files.set(id, cached.file)
      written.set(id, entry.mtimeMs)
    }
  }

  return files
}

const lookupMeta = async ($: EngineInterface, chats: Listed[]) => {
  const meta = ((await $.store.get('meta')) ?? {}) as Record<string, Meta>
  const missing = chats.filter(chat => meta[chat.sessionId] === undefined)
  for (let at = 0; at < missing.length; at += 10) {
    await Promise.all(
      missing.slice(at, at + 10).map(async chat => {
        const found = (await callJson($, 'get_session', { session_id: chat.sessionId }).catch(
          () => undefined,
        )) as Self | undefined
        if (found) meta[chat.sessionId] = { task: found.scheduledTaskId }
      }),
    )
  }
  if (missing.length > 0) await $.store.set('meta', meta)

  return meta
}

const refresh = async ($: EngineInterface) => {
  // A tick that hangs gives way to the next after a while.
  if (isBusy && Date.now() - busySince < BUSY_MS) return
  isBusy = true
  busySince = Date.now()
  try {
    const now = await $.clock.now()
    // Waiting on background work or held by a dialog, a chat does nothing and
    // the app says it does not run: a sign of life keeps other chats from
    // taking it for ended. Not with nothing open: a chat whose turn's end went
    // unheard has to go quiet for the others to see it ended.
    const isOpen = mine?.status === 'working' && (mine.background !== undefined || mine.doing !== undefined)
    if (isOpen && now - (mine?.activityAt ?? 0) >= ALIVE_MS) patch($, {})
    // Just after the computer slept, nobody has had a tick to show they live.
    const isAwake = lastTickAt === 0 || now - lastTickAt < 3 * POLL_MS
    lastTickAt = now
    const me = await selfInfo($, now)
    const listed = saneChats(await callJson($, 'list_sessions', { limit: 100 }))
    const all: Listed[] = me ? [{ ...me, startedBy: me.parentSessionId }, ...listed] : listed
    const meta = await lookupMeta($, listed)
    if (me) meta[me.sessionId] = { task: me.scheduledTaskId }
    const files = await readFiles($)
    // The finished chats nobody had seen, this one too: has the app's window
    // shown them since they ended?
    const unseen = new Set([...files].filter(([, file]) => file.status === 'done' && file.unseen).map(([id]) => id))
    if (me && mine?.status === 'done' && mine.unseen) unseen.add(me.sessionId)
    const focused = await readFocus($, unseen)
    const myFocus = me ? focused.get(me.sessionId) : undefined
    if (myFocus !== undefined && mine?.status === 'done' && mine.unseen && myFocus > mine.at) {
      seen($, myFocus, 'чат открыли в приложении')
    }
    if (isAwake) {
      for (const chat of staleMarks({ all: listed, meta, files, focused, selfId: me?.sessionId, now })) {
        void unmarkSleeping($, chat).catch(() => undefined)
      }
    }

    let order = ((await $.store.get('order-2')) ?? {}) as Order
    const placed = placeNew(order, all.filter(chat => !meta[chat.sessionId]?.task))
    if (placed) {
      order = placed
      await $.store.set('order-2', order)
    }

    const list = buildRows({
      all,
      meta,
      files,
      order,
      tasks: await scheduledTasks($, now),
      selfId: me?.sessionId,
      selfFile: mine && { ...mine, cliId: await sessionId($) },
      focused,
      now,
    })
    const held = await shownRows($)
    if (JSON.stringify(held) !== JSON.stringify(list)) await showRows($, list)
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  registerView(on)

  on('session.start', async ($, e, next) => {
    await startView($)
    // This chat's record and journal from before a reload or a restart.
    const text = await $.fs.read(await myFile($)).catch(() => '')
    await loadJournal($)
    try {
      const { cliId: _, desktopId: __, ...held } = JSON.parse(String(text)) as StatusFile
      mine = held
    } catch {
      // no record yet: the first turn writes one
    }
    // The list outlives a reload of the mod, not a restart of the chat.
    const isReload = (await shownRows($)).length > 0
    note($, `загрузка, запись: ${mine?.status ?? 'нет'}${isReload ? ', обновление' : ''}`)
    await resume($, isReload).catch(() => undefined)
    void refresh($).catch(() => undefined)
    $.clock.every(POLL_MS, () => {
      void refresh($).catch(() => undefined)
    })

    return next(e)
  })

  // Where the person wrote from: the phone's messages come over Remote Control.
  // Only looks: the prompt goes on as typed whatever happens here.
  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = e.origin?.kind
      if (kind === 'bridge') isPhoneTurn = true
      if (!isOtherSender(kind, e.text)) {
        nextTurnBy = 'person'
        if (mine?.unanswered) patch($, { unanswered: undefined })
        // Answered while the turn still runs: what its closing box asked is over.
        closing = { ...closing, question: undefined, answers: undefined }
      } else if (nextTurnBy === 'nobody') {
        nextTurnBy = 'others'
      }
      note($, `сообщение: ${kind === 'bridge' ? 'с телефона' : (kind ?? 'откуда — неизвестно')}`)
    } catch {
      // the journal can wait
    }

    return next(e)
  })

  // The person opened this chat in the app's window.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    if (mine?.status === 'done' && mine.unseen) seen($)

    return joined
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      closing = {}
      leftRunning = []
      // A permission or a plan to approve is over with its dialog: only a
      // question put in words stays unanswered.
      const unanswered =
        nextTurnBy === 'others' && mine?.status === 'waiting' && mine.question && !isDialogAsk(mine.question)
          ? { question: mine.question, answers: mine.answers }
          : undefined
      nextTurnBy = 'nobody'
      setStatus($, 'working', {
        step: planStep(plan),
        ...NOT_DOING,
        background: undefined,
        summary: undefined,
        question: undefined,
        answers: undefined,
        error: undefined,
        unanswered,
      })
    }

    return next(e)
  })

  // Only read, for turn.complete just after it: what the chat leaves running.
  // It sets no status: the turn's end does, once, as ever.
  on('classic.Stop', async (_, e, next) => {
    leftRunning = e.background_tasks ?? []

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const inBackground = leftRunning.length > 0 ? `, в фоне: ${leftRunning.map(task => task.type).join(', ')}` : ''
    note($, `конец хода: ${e.reason}${closing.question ? ', с вопросом' : ''}${inBackground}`)
    endTurn($, e.reason, done.text ?? '')

    return done
  })

  // What the chat does now; a question put to the person, a plan to approve
  // or a closing question make it wait.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as Record<string, unknown>
    // A helper's tools, plan and closing box are its own, not the chat's. Only
    // a permission it asks is the person's to answer: that is told below.
    const isMine = e.agentId === undefined
    const run: ToolRun = { tool, input }
    toolRuns.push(run)
    if (isMine && tool === 'mcp__ccd_turn__update_plan') {
      plan = followPlan(plan, input)
      patch($, { step: planStep(plan) })
    }
    if (isMine && tool === 'mcp__ccd_turn__wrap_up') {
      closing = closingOf(input)
      // The closing box checks off the task list by itself.
      plan = []
    }
    if (isMine && tool === 'AskUserQuestion') {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown }) : undefined
      run.asks = String(first?.question ?? 'задал вопрос')
      ask($, run.asks)
    }
    if (isMine && tool === 'ExitPlanMode') {
      run.asks = PLAN_ASK
      ask($, run.asks)
    }
    const words = isMine ? toolWords(tool) : ''
    if (words) patch($, { doing: words, doingAt: Date.now() })
    const ran = await next(e).finally(() => {
      toolRuns.splice(toolRuns.indexOf(run), 1)
    })
    // A dialog this very call put to the person was answered: back to work, or
    // to the next dialog still up. Only such a call: another tool ending says
    // nothing of it, and the closing box's call ends after the turn has, its
    // question having to stay.
    if (run.asks !== undefined && mine?.status === 'waiting') {
      const stillAsking = toolRuns.find(one => one.asks !== undefined)
      if (stillAsking) patch($, { question: stillAsking.asks, answers: [] })
      else setStatus($, 'working', { question: undefined, answers: undefined, ...NOT_DOING })
    } else if (words) {
      patch($, NOT_DOING)
    }

    return ran
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const tool = String(e.tool_name)
    // A dialog tool comes here too: the question it asks is already told.
    if (!isDialogTool(tool)) {
      const question = `${PERMISSION_ASK}: ${toolWords(tool) || tool}`
      const asker = askerOf(toolRuns, tool, e.tool_input)
      if (asker) asker.asks = question
      ask($, question)
    }

    return next(e)
  })
}
