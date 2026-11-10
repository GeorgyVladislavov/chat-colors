// What a chat writes about itself, worked out from what it does: its tools in
// words, its plan's step, how its turn ended in a sentence. Pure: register.tsx
// feeds it the tool calls.

import type { Asked, Written } from './rows'

const SUMMARY_CHARS = 140

export type PlanItem = { content: string; status: string }

// The first sentence of a text, as plain words.
export const firstSentence = (text: string) => {
  const line =
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map(one =>
        one
          .replace(/^[\s#>*-]+/, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*_`]/g, '')
          .trim(),
      )
      .find(Boolean) ?? ''
  const sentence = line.match(/^.*?[.!?…](?=\s|$)/)?.[0] ?? line

  return sentence.length > SUMMARY_CHARS ? `${sentence.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : sentence
}

// What a tool does, in words; empty for the app's own bookkeeping.
export const toolWords = (tool: string) => {
  if (tool === 'Bash' || tool === 'PowerShell') return 'выполняет команду'
  if (tool === 'Read') return 'читает файл'
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return 'правит файл'
  if (tool === 'Grep' || tool === 'Glob') return 'ищет в файлах'
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'ищет в интернете'
  if (tool === 'Agent' || tool === 'Task') return 'работает с помощником'
  if (tool === 'Skill') return 'читает инструкцию'
  if (/^mcp__ccd_|^(ToolSearch|TodoWrite|AskUserQuestion|ExitPlanMode)$/.test(tool)) return ''
  if (/Browser|chrome/i.test(tool)) return 'работает в браузере'
  if (/computer-use/.test(tool)) return 'управляет компьютером'
  if (/__(create_event|list_events|update_event|get_event|search_events)$/.test(tool)) return 'работает с календарём'
  if (tool.startsWith('mcp__')) return 'работает с подключением'

  return 'работает'
}

// The app's task list after an update_plan call: a new list, or steps moved on.
export const followPlan = (
  plan: PlanItem[],
  input: { items?: unknown; advance?: unknown; done?: unknown; start?: unknown },
) => {
  let next = plan.map(item => ({ ...item }))
  if (Array.isArray(input.items)) {
    next = input.items.map(item => {
      const one = item as { content?: unknown; status?: unknown }

      return { content: String(one.content ?? ''), status: String(one.status ?? 'pending') }
    })
  }
  if (input.advance === true) {
    const at = next.findIndex(item => item.status === 'in_progress')
    if (at >= 0) next[at]!.status = 'completed'
    const pending = next.findIndex(item => item.status === 'pending')
    if (pending >= 0) next[pending]!.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const number of input.done) {
      const item = next[Number(number) - 1]
      if (item) item.status = 'completed'
    }
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    for (const item of next) if (item.status === 'in_progress') item.status = 'pending'
    next[input.start - 1]!.status = 'in_progress'
  }

  return next
}

// Where the plan stands: "3 из 5: what that step is", or nothing once done.
export const planStep = (plan: PlanItem[]) => {
  const at = plan.findIndex(item => item.status === 'in_progress')
  if (at < 0) return undefined

  return `${at + 1} из ${plan.length}: ${plan[at]!.content}`
}

export type Closing = { summary?: string; question?: string; answers?: string[] }
export type TurnEnd = {
  status: Written
  summary?: string
  question?: string
  answers?: string[]
  error?: string
  background?: string
}
// Work a chat left running, as the engine lists it when the turn ends.
export type BackgroundTask = { type?: string; description?: string; command?: string; name?: string }

// The work a chat waits for: it ends, and the engine wakes the chat with it.
// The engine lists more. A `monitor` can run for good: the app arms one by
// itself on each published page. Its own housekeeping wakes nobody.
const WAITED_FOR = new Set(['subagent', 'workflow', 'shell'])

// What a chat waits for, in words; nothing when it waits for nothing.
export const backgroundWords = (tasks: readonly BackgroundTask[]) => {
  const waited = tasks.filter(task => WAITED_FOR.has(task.type ?? ''))
  if (waited.length === 0) return undefined
  if (waited.length > 1) return `ждёт фоновые задачи: ${waited.length}`
  const what = waited[0]?.description || waited[0]?.command || waited[0]?.name

  return what ? `ждёт фоновую задачу: ${firstSentence(what)}` : 'ждёт фоновую задачу'
}

// Who can answer such a question: the person, at the computer or on the phone.
// All else that writes to a chat cannot: other chats, work that ended, the
// app's own notes (`sdk`: every one the journals held on 09.11.2026 was such).
const THE_PERSON = new Set(['composer', 'bridge'])
// A reply pressed in the pane reaches the chat as another chat's message: only
// these words tell it from one.
export const PANE_REPLY = 'нажата кнопка в панели «Чаты»'

export const isOtherSender = (kind: string | undefined, text: string) =>
  kind !== undefined && !THE_PERSON.has(kind) && !text.includes(PANE_REPLY)

// What a dialog says of itself. These two are over with their dialog; a
// question put in words is still a question after it.
export const PERMISSION_ASK = 'просит разрешения'
export const PLAN_ASK = 'план ждёт вашего одобрения'
export const isDialogAsk = (question: string | undefined) =>
  question !== undefined && (question.startsWith(PERMISSION_ASK) || question === PLAN_ASK)

// The tools that are a dialog themselves: the engine asks for them as for any
// permission, and what they ask is their own question.
export const isDialogTool = (tool: string) => tool === 'AskUserQuestion' || tool === 'ExitPlanMode'

// A tool call under way, this chat's or a helper's, and what it has put to the
// person. The dialog ends when the call does.
export type ToolRun = { tool: string; input: Record<string, unknown>; asks?: string }

const sameInput = (asked: unknown, given: Record<string, unknown>) =>
  typeof asked === 'object' &&
  asked !== null &&
  Object.entries(asked).every(([key, value]) => JSON.stringify(given[key]) === JSON.stringify(value))

// Which call a permission dialog belongs to: the same tool with the same input,
// else the same tool, else any call under way.
export const askerOf = (runs: readonly ToolRun[], tool: string, input: unknown) => {
  const free = runs.filter(run => run.asks === undefined)
  const sameTool = free.filter(run => run.tool === tool)

  return sameTool.find(run => sameInput(input, run.input)) ?? sameTool[0] ?? free[0]
}

// How a turn ends, told once at turn.complete: red only on an error Claude
// gave, waiting on the closing box's question or on one still unanswered from
// before, still working on what it left running (the engine wakes the chat as
// each piece ends), done otherwise. A closing box with no question says itself
// that nothing is pending, so it ends an unanswered question too.
export const turnEnd = (
  closing: Closing,
  reason: string,
  text: string,
  leftRunning: readonly BackgroundTask[] = [],
  unanswered?: Asked,
): TurnEnd => {
  const summary = closing.summary ?? (text ? firstSentence(text) : undefined)
  if (reason === 'error') return { status: 'error', summary, error: 'Claude выдал ошибку' }
  if (reason === 'aborted') return { status: 'done', summary: 'Остановлен' }
  if (reason === 'refusal') return { status: 'done', summary: 'Claude отказался отвечать' }
  if (closing.question) return { status: 'waiting', summary, question: closing.question, answers: closing.answers }
  if (unanswered && closing.summary === undefined) {
    return { status: 'waiting', summary, question: unanswered.question, answers: unanswered.answers }
  }
  const background = backgroundWords(leftRunning)
  if (background) return { status: 'working', summary, background }

  return { status: 'done', summary }
}

// The replies a closing box offers: its own buttons, not the app's actions.
export const closingOf = (input: { recap?: unknown; ask?: unknown; actions?: unknown }) => {
  const ask = typeof input.ask === 'string' ? input.ask.trim() : ''
  const answers = Array.isArray(input.actions)
    ? input.actions
        .map(action => action as { label?: unknown; action?: unknown })
        .filter(action => typeof action.label === 'string' && action.action === undefined)
        .map(action => String(action.label))
    : []

  return {
    summary: typeof input.recap === 'string' ? firstSentence(input.recap) : undefined,
    question: ask || undefined,
    answers: ask ? answers : undefined,
  }
}
