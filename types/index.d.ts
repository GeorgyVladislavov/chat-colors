export type ChatStatus = 'working' | 'waiting' | 'done' | 'error' | 'unknown'

export type ChatRow = {
  id: string
  title: string
  folder: string
  depth: number
  status: ChatStatus
  age: string
  isSelf: boolean
  // Working, broken, or stopped within the last hour: shown in the band and the pane.
  isRecent: boolean
  // What went wrong with a red chat; a scheduled task's next run, or that it is off.
  note: string
  // How a finished chat ended, or what a waiting one asks.
  detail: string
  // The replies a waiting chat's closing question offers, sent from the pane.
  answers: string[]
  // When a waiting chat began to wait: the same words asked later are a new question.
  askedAt?: number
  // A working chat's plan step and the tool running now.
  progress: string
  // Where a reply goes when `id` is not a chat's: a scheduled task's latest run.
  chatId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'chat-colors': {
      rows: Shaped<ChatRow[]>
      isPaneOpen: boolean
      // The replies sent from the pane, by chat: the question they answer, when
      // it was asked, and the reply.
      sent: Record<string, { question: string; answer: string; askedAt?: number }>
    }
  }
}
