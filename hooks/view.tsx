import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatRow, ChatStatus } from '../types'
import { SERVER, note } from './host'
import { PANE_REPLY } from './record'
import { MARK, TASKS } from './rows'

// What the person sees: the band above the prompt, the pane its button opens
// and closes, the replies and links pressed there. It only reads `rows`;
// register.tsx fills them.

const PANE = 'chat-colors'
const TITLE = 'Чаты'
const CHIP_CHARS = 28

const rows = atom({ plugin: 'chat-colors', key: 'rows' } as const, [], {
  shape: 'rows-4',
})
const isPaneOpen = atom({ plugin: 'chat-colors', key: 'isPaneOpen' } as const, false)
// The replies sent from the pane, by chat: the question they answer, and the reply.
const sent = atom({ plugin: 'chat-colors', key: 'sent' } as const, {})

const COLOR: Record<ChatStatus, string> = {
  working: '#3b82f6',
  waiting: '#f97316',
  done: '#22c55e',
  error: '#ef4444',
  unknown: 'inactive',
}
// The pane marks each chat with the same circle its title carries in the app's
// sidebar: about three times the size of a text dot, easy to see (05.11.2026).
const DOT: Record<ChatStatus, string> = { ...MARK, unknown: '⚪' }
const LABEL: Record<ChatStatus, string> = {
  working: 'работает',
  waiting: 'ждёт ответа',
  done: 'готово',
  error: 'ошибка',
  unknown: 'нет данных',
}

// The rows are read and written here: the engine reads a state value's name
// from the file that uses it, so it does not pass through an import.
export async function shownRows($: EngineInterface) {
  return read($, rows)
}

export async function showRows($: EngineInterface, list: ChatRow[]) {
  await update($, rows, () => list)
}

// The button keeps its own word on whether the pane is up: the mod's own
// close does not reach its ui.close hook, which hears the person's close mark.
async function togglePane($: EngineInterface) {
  const isListed = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isListed && (await read($, isPaneOpen))) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await update($, isPaneOpen, () => false)

    return false
  }
  // A pane the engine still holds is closed first, so the open shows it afresh.
  if (isListed) await $.ui.close({ id: PANE }).catch(() => undefined)
  await $.ui.open({ id: PANE, title: TITLE })
  await update($, isPaneOpen, () => true)

  return true
}

// A reply from the pane reaches the waiting chat as a message from this one,
// saying it is the person's own answer.
async function sendAnswer($: EngineInterface, row: ChatRow, answer: string) {
  const message = `Ответ пользователя на твой вопрос «${row.detail}» (${PANE_REPLY} в другом чате): ${answer}`
  const result = await $.mcp.call(SERVER, 'send_message', { session_id: row.chatId ?? row.id, message })
  if (result.isError) {
    $.ui.toast(`Не получилось отправить ответ в «${shorten(row.title)}»`)
    return
  }
  await update($, sent, held => ({ ...held, [row.id]: { question: row.detail, answer, askedAt: row.askedAt ?? 0 } }))
  $.ui.toast(`Ответ «${answer}» отправлен в «${shorten(row.title)}»`)
}

export const shorten = (text: string) =>
  text.length > CHIP_CHARS ? `${text.slice(0, CHIP_CHARS - 1).trimEnd()}…` : text

// A chat's name in the pane is a link that opens that chat in the app. The app
// takes claude://code/continue?session=<id> (its taskbar menu opens chats so),
// handed here to the system. The markdown link's own target is never opened:
// the press comes to the mod. Desktop only: from the phone it would turn the
// computer's window, not the phone's.
const CHAT_ID = /^local_[A-Za-z0-9-]{1,64}$/
const chatLink = (id: string) => `claude://code/continue?session=${id}`
const linkTarget = (id: string) => `https://claude.ai/code/${id}`
const linkText = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, '\\$&')
const isLinked = (row: ChatRow, surface: string) =>
  surface === 'desktop' && !row.isSelf && row.folder !== TASKS && CHAT_ID.test(row.id)

async function openChat($: EngineInterface, row: ChatRow) {
  const url = chatLink(row.id)
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // Not explorer.exe: it swallows a claude:// link without passing it on
  // (05.11.2026). cmd's start gets an empty title, so it opens the link; the
  // link holds no character cmd reads (CHAT_ID).
  const tries = isWindows
    ? [
        ['rundll32.exe', 'url.dll,FileProtocolHandler', url],
        ['cmd.exe', '/d', '/c', 'start', '', url],
      ]
    : [['open', url], ['xdg-open', url]]
  for (const argv of tries) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10000 })
      note($, `передал ссылку на чат «${shorten(row.title)}» из панели (${argv[0]}, код ${exitCode})`)
      return
    } catch {
      // not on this system: the next one
    }
  }
  note($, `не открылся из панели чат «${shorten(row.title)}»`)
  $.ui.toast(`Не получилось открыть «${shorten(row.title)}»`)
}

// On each start: the command for the pane, and whether the pane is up.
export async function startView($: EngineInterface) {
  await $.command.register({
    name: 'chats',
    description: 'Открыть или закрыть панель со всеми чатами',
  })
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  await update($, isPaneOpen, () => isOpen)
}

export function registerView(on: Parameters<Register>[0]) {
  on('command.run', { command: 'chats' }, async $ => {
    const isOpen = await togglePane($)

    return { text: isOpen ? 'Панель «Чаты» открыта.' : 'Панель «Чаты» закрыта.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)

    return closed
  })

  // The band: the other chats that work, wait, broke, or stopped within the
  // hour, and the button for the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = (await read($, rows)).filter(row => row.isRecent && !row.isSelf)
    const isOpen = await read($, isPaneOpen)

    return (
      <Box flexDirection="row">
        <Button key="toggle" onPress={() => togglePane($)}>
          {isOpen ? 'Скрыть чаты' : 'Все чаты'}
        </Button>
        <Text wrap="wrap">
          {'  '}
          {busy.length === 0 && <Text dimColor>Сейчас ни один другой чат не работает</Text>}
          {busy.map(row => (
            <Text>
              <Text color={COLOR[row.status]} weight={row.status === 'done' ? undefined : 'semibold'}>
                ● {shorten(row.title)}
              </Text>
              {'   '}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })

  // The pane: the busy chats by folder, as the band takes them, then every
  // scheduled task. Under each, a line: what it does, how it ended, or what
  // it asks, with the replies to send.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const replies = (await read($, sent)) as Record<string, { question: string; answer: string; askedAt?: number }>
    const shown = list.filter(row => row.isRecent || row.folder === TASKS)
    const folders = [...new Set(shown.map(row => row.folder))]
    const isQuiet = list.length > 0 && !shown.some(row => row.folder !== TASKS)
    const details = (row: ChatRow) =>
      [
        row.isSelf ? 'этот чат' : '',
        row.folder === TASKS && row.status === 'unknown' ? (row.age ? 'последний запуск' : '') : LABEL[row.status],
        row.age,
        row.note,
      ]
        .filter(Boolean)
        .join(' · ')

    return (
      <Box flexDirection="column">
        <Text>
          {/* No-break spaces inside an entry: a narrow pane wraps the legend
              between entries, never between a circle and its word. Green is
              "done": it holds until the person opens the chat, not an hour. */}
          <Text color={COLOR.working}>{`${DOT.working} работает`}</Text>
          {'   '}
          <Text color={COLOR.waiting}>{`${DOT.waiting} ждёт ответа`}</Text>
          {'   '}
          <Text color={COLOR.done}>{`${DOT.done} готово`}</Text>
          {'   '}
          <Text color={COLOR.error}>{`${DOT.error} ошибка`}</Text>
        </Text>
        {list.length === 0 && <Text dimColor>Загружаю список чатов…</Text>}
        {isQuiet && (
          <Box marginTop={1}>
            <Text dimColor>Сейчас ни один чат не работает</Text>
          </Box>
        )}
        {folders.map(folder => (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor weight="semibold">
              {folder}
            </Text>
            {shown
              .filter(row => row.folder === folder)
              .map(row => {
                const line = row.progress || row.detail
                const reply = replies[row.id]
                // The same words asked again later are a new question.
                const isAnswered =
                  reply !== undefined && reply.question === row.detail && reply.askedAt === (row.askedAt ?? 0)

                return (
                  <Box flexDirection="column">
                    {isLinked(row, e.surface) ? (
                      <Box flexDirection="row">
                        <Text>{DOT[row.status]} </Text>
                        <Markdown
                          key={`open:${row.id}`}
                          text={`[${linkText(row.title)}](${linkTarget(row.id)})`}
                          pressableLinks={[linkTarget(row.id)]}
                          onLinkPress={() => openChat($, row)}
                        />
                        <Text dimColor wrap="truncate-end">
                          {'  '}
                          {details(row)}
                        </Text>
                      </Box>
                    ) : (
                      <Text wrap="truncate-end">
                        <Text>{DOT[row.status]} </Text>
                        <Text
                          color={row.status === 'unknown' ? undefined : COLOR[row.status]}
                          weight={row.status === 'done' || row.status === 'unknown' ? undefined : 'semibold'}
                        >
                          {row.title}
                        </Text>
                        <Text dimColor>
                          {'  '}
                          {details(row)}
                        </Text>
                      </Text>
                    )}
                    {line !== '' && (
                      <Text dimColor wrap="truncate-end">
                        {'   '}
                        {line}
                      </Text>
                    )}
                    {row.answers.length > 0 && !row.isSelf && !isAnswered && (
                      <Box flexDirection="row">
                        <Text>{'   '}</Text>
                        {row.answers.map(answer => (
                          <Button key={`${row.id}:${answer}`} onPress={() => sendAnswer($, row, answer)}>
                            {answer}
                          </Button>
                        ))}
                      </Box>
                    )}
                    {isAnswered && (
                      <Text dimColor>
                        {'   '}✓ отправлено: {reply.answer}
                      </Text>
                    )}
                  </Box>
                )
              })}
          </Box>
        ))}
      </Box>
    )
  })
}
