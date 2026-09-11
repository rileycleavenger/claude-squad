import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * An async iterable of user messages that never ends on its own.
 *
 * This is what keeps an agent's `query()` call alive as a long-running conversation:
 * the SDK pulls from this iterator and, when it is empty, simply waits. Pushing a
 * message wakes the pending `next()` and starts the agent's next turn.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  /** Queue a user turn. Wakes the agent if it is idle. */
  push(content: string): void {
    if (this.closed) return
    this.pending.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
    this.flush()
  }

  /** End the conversation; the agent's `query()` generator will finish. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.flush()
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Messages queued but not yet handed to the agent. */
  get depth(): number {
    return this.pending.length
  }

  private flush(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.pending.length > 0) {
        yield this.pending.shift()!
      }
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.wake = resolve
      })
    }
  }
}
