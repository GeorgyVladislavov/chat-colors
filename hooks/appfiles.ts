import type { EngineInterface } from 'claude-code'

import { note } from './host'

// When the app's window last showed a chat, from the file the app keeps on each
// chat: a sleeping chat cannot hear that it was opened. An inner format of the
// app: with no files or no such field, chats just wait for their own window.

const APP_FOLDERS_MS = 10 * 60000

// Looked for now and then; each chat's file read again only when it changed.
let appFolders: string[] | undefined
let appFoldersAt = 0
const focusCache = new Map<string, { mtimeMs: number; at?: number }>()

// Where the desktop app keeps a file per chat (<folder>/<account>/<org>/
// local_<id>.json): the Store app's data folder, the installer's, a Mac's.
// None found: a chat waits for its own window, as before.
async function findAppFolders($: EngineInterface) {
  if (appFolders && Date.now() - appFoldersAt < APP_FOLDERS_MS) return appFolders
  const slash = (path: string) => path.replace(/\\/g, '/')
  const local = await $.env.get('LOCALAPPDATA')
  const roaming = await $.env.get('APPDATA')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const roots: string[] = []
  if (local) {
    for (const entry of await $.fs.list(`${slash(local)}/Claude-Data`).catch(() => [])) {
      if (entry.kind === 'dir') roots.push(`${slash(local)}/Claude-Data/${entry.name}/claude-code-sessions`)
    }
  }
  if (roaming) roots.push(`${slash(roaming)}/Claude/claude-code-sessions`)
  if (home) roots.push(`${slash(home)}/Library/Application Support/Claude/claude-code-sessions`)
  const found: string[] = []
  for (const root of roots) {
    for (const account of await $.fs.list(root).catch(() => [])) {
      if (account.kind !== 'dir') continue
      for (const org of await $.fs.list(`${root}/${account.name}`).catch(() => [])) {
        if (org.kind === 'dir') found.push(`${root}/${account.name}/${org.name}`)
      }
    }
  }
  const wasFound = appFolders === undefined ? undefined : appFolders.length > 0
  if (wasFound !== found.length > 0) {
    note($, found.length > 0 ? 'файлы приложения о чатах найдены' : 'файлы приложения о чатах не найдены')
  }
  appFolders = found
  appFoldersAt = Date.now()

  return found
}

// When the app's window last showed each of these chats, by the app's file on
// it; a file is read again only when it changed.
export async function readFocus($: EngineInterface, ids: Set<string>) {
  const focused = new Map<string, number>()
  if (ids.size === 0) return focused
  for (const folder of await findAppFolders($)) {
    for (const entry of await $.fs.list(folder).catch(() => [])) {
      const id = entry.name.replace(/\.json$/, '')
      if (entry.kind !== 'file' || !ids.has(id)) continue
      const path = `${folder}/${entry.name}`
      let cached = focusCache.get(path)
      if (cached?.mtimeMs !== entry.mtimeMs) {
        const text = String(await $.fs.read(path).catch(() => ''))
        const at = Number(/"lastFocusedAt"\s*:\s*(\d+)/.exec(text)?.[1])
        // A file not read is read again on the next tick.
        cached = { mtimeMs: text ? entry.mtimeMs : -1, at: at > 0 ? at : undefined }
        focusCache.set(path, cached)
      }
      if (cached.at !== undefined && cached.at > (focused.get(id) ?? 0)) focused.set(id, cached.at)
    }
  }

  return focused
}
