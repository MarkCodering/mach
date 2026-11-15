/**
 * React bindings.
 *
 * ```tsx
 * import { useChat } from 'machjs/react'
 * function Chat() {
 *   const { messages, draft, status, send, stop } = useChat({ api: '/chat' })
 *   ...
 * }
 * ```
 */
import { useRef, useSyncExternalStore } from 'react'
import { type ChatOptions, type ChatState, type ChatStore, createChat } from './client.js'

export type UseChatResult = ChatState & Pick<ChatStore, 'send' | 'stop' | 'setMessages'>

/**
 * Chat state for a Mach agent endpoint. The store is created once per component instance;
 * options are read at creation (pass a function for `headers` to keep them fresh).
 */
export function useChat(options: ChatOptions): UseChatResult {
  const ref = useRef<ChatStore | null>(null)
  if (ref.current === null) ref.current = createChat(options)
  const store = ref.current
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { ...state, send: store.send, stop: store.stop, setMessages: store.setMessages }
}

export { createChat }
export type { ChatOptions, ChatState, ChatStore }
