import type { EngineInterface } from 'claude-code'

import type { Listed } from './rows'

// What every part of the mod needs: calls to the app's servers, this chat's id,
// where its files lie, its journal.

export const SERVER = 'ccd_session_mgmt'
export const TASKS_SERVER = 'scheduled-tasks'
const SELF_MS = 60000
const JOURNAL_LINES = 40

export type Self = Listed & { parentSessionId?: string; scheduledTaskId?: string }

// Module state: starts over on a reload, which only costs a re-lookup.
let dir: string | undefined
let cliId: string | undefined
let self: Self | undefined
let selfAt = 0
// The last few things that moved this chat's record, kept beside the record
// for finding out why a chat showed the color it did.
let journal: string[] = []

export async function callJson(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  server = SERVER,
) {
  const result = await $.mcp.call(server, tool, args)
  const block = result.content.find(one => one.type === 'text')
  const text = block && 'text' in block ? block.text : undefined
  if (result.isError || typeof text !== 'string') return undefined

  return JSON.parse(text) as unknown
}

export async function statusDir($: EngineInterface) {
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  dir = `${home.replace(/\\/g, '/')}/.claude/chat-colors`

  return dir
}

export async function sessionId($: EngineInterface) {
  cliId ??= await $.session.id()

  return cliId
}

export async function myFile($: EngineInterface) {
  return `${await statusDir($)}/${await sessionId($)}.json`
}

async function journalFile($: EngineInterface) {
  return `${await statusDir($)}/log/${await sessionId($)}.log`
}

// The journal from before a reload or a restart.
export async function loadJournal($: EngineInterface) {
  const lines = await $.fs.read(await journalFile($)).catch(() => '')
  journal = String(lines).split('\n').filter(Boolean).slice(-JOURNAL_LINES)
}

// One line in the journal, UTC time first.
export function note($: EngineInterface, text: string) {
  // The same line again and again says nothing new.
  if (journal[journal.length - 1]?.endsWith(` ${text}`)) return
  journal = [...journal, `${new Date().toISOString().slice(0, 19)} ${text}`].slice(-JOURNAL_LINES)
  void (async () => $.fs.write(await journalFile($), `${journal.join('\n')}\n`))().catch(() => undefined)
}

// This chat as the app has it.
export async function selfInfo($: EngineInterface, now: number) {
  if (self && now - selfAt < SELF_MS) return self
  const found = (await callJson($, 'get_session', { session_id: 'self' }).catch(
    () => undefined,
  )) as Self | undefined
  if (found?.sessionId) {
    self = found
    selfAt = now
  }

  return self
}
