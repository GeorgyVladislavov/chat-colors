import type { EngineInterface } from 'claude-code'

import { note } from './host'

// The dialogs the desktop app puts up by itself, inside a call of one of its
// own tools: start a dev server (preview_start), open a site, let Claude use
// an app, show a file. The engine is not asked, so no PermissionRequest comes:
// the call just waits for the person. Only the app's log tells, a line when the
// dialog shows and one when the person answers:
//   Emitted tool permission request <id> for <tool> in session local_<chat>
//   LocalSessions.respondToToolPermission: requestId=<id>, decision=…
//   Received permission response for <id>: … (tool: …)
// Read in the app's code (6.6395, 21.11.2026). An inner format of the app:
// with no log, or other words in it, such a dialog keeps the chat blue, as it
// did before 0.5.16. The engine's own permissions come to the hook as ever
// and stand in the log too.

// The most read at once: lines the app writes in a few seconds are far less.
const READ_MAX = 1024 * 1024
const LOOK_AGAIN_MS = 10 * 60000

export type AppAsk = { kind: 'asked'; id: string; tool: string } | { kind: 'answered'; id: string }

const ASKED = /Emitted tool permission request (\S+) for (\S+) in session (\S+)/
const ANSWERED = /respondToToolPermission: requestId=([^,\s]+)|Received permission response for ([^:\s]+)/

// What these lines of the log say of dialogs: those of this chat, the answers
// to any (an id is a dialog's own).
export const appAsks = (text: string, chatId: string) => {
  const found: AppAsk[] = []
  for (const line of text.split('\n')) {
    const ask = ASKED.exec(line)
    if (ask) {
      if (ask[3] === chatId) found.push({ kind: 'asked', id: ask[1]!, tool: ask[2]! })
      continue
    }
    const answer = ANSWERED.exec(line)
    const id = answer?.[1] ?? answer?.[2]
    if (id) found.push({ kind: 'answered', id })
  }

  return found
}

// Module state: a reload starts over, and a dialog up before it is not seen.
let logPath: string | undefined
let lookedAt = 0
// Where the next read starts, while a call is watched; the end of a line the
// app had not finished writing.
let cursor: number | undefined
let carry = ''
// Counts the stops: a read still under way when the watch stops keeps no place.
let stops = 0
// The engine cannot read a part of a file: the log is not read at all.
let isOff = false

// The app's log: Windows (the installer's and the Store's alike), a Mac.
async function findLog($: EngineInterface) {
  if (logPath || Date.now() - lookedAt < LOOK_AGAIN_MS) return logPath
  lookedAt = Date.now()
  const slash = (path: string) => path.replace(/\\/g, '/')
  const local = await $.env.get('LOCALAPPDATA')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const places = [local && `${slash(local)}/Claude/Logs/main.log`, home && `${slash(home)}/Library/Logs/Claude/main.log`]
  for (const place of places) {
    if (place && (await $.fs.exists(place).catch(() => false))) {
      logPath = place

      return place
    }
  }

  return undefined
}

// A call of the app's own tool begins: what it asks is written from here on.
// Already watching, the earlier start holds.
export async function watchLog($: EngineInterface) {
  if (isOff || cursor !== undefined) return
  const started = stops
  const path = await findLog($)
  if (!path) return
  const { size } = await $.fs.stat(path)
  if (started !== stops || cursor !== undefined) return
  cursor = size
  carry = ''
}

// No call of the app's own tool is under way.
export const stopWatching = () => {
  stops += 1
  cursor = undefined
  carry = ''
}

// The whole lines the app wrote since the last read.
export async function readLog($: EngineInterface) {
  if (cursor === undefined || !logPath) return ''
  const started = stops
  const { size } = await $.fs.stat(logPath)
  if (started !== stops || cursor === undefined) return ''
  // A smaller log is a new one: the app moved the old aside.
  const from = Math.max(size < cursor ? 0 : cursor, size - READ_MAX)
  if (size < cursor) carry = ''
  if (size <= from) {
    cursor = size

    return ''
  }
  const read = String(await $.fs.read(logPath, { offset: from, length: size - from }))
  if (started !== stops) return ''
  // More letters than bytes asked for: an engine from before ranged reads
  // (2.1.314 still) gave the whole log. Each line in it would be new: this
  // load of the mod leaves the log alone.
  if (read.length > size - from) {
    isOff = true
    stopWatching()
    note($, 'журнал приложения: движок читает его только целиком, окна приложения не видны')

    return ''
  }
  const text = carry + read
  cursor = size
  const end = text.lastIndexOf('\n') + 1
  // A line too long to be one of these is not kept.
  carry = text.length - end > 65536 ? '' : text.slice(end)

  return text.slice(0, end)
}
