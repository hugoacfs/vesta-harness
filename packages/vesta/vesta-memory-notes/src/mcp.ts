/**
 * A minimal client for one Streamable-HTTP MCP server: initialize once, keep
 * the session id, call tools, parse JSON or SSE answers. Used for the memory
 * server on loopback; every call is bounded by a timeout.
 */

export interface McpToolResult {
  readonly text: string
  readonly isError: boolean
}

export class McpClient {
  private sessionId: string | undefined
  private nextId = 1

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  private async post(body: Record<string, unknown>): Promise<{ status: number; sessionId: string | undefined; payload: unknown }> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const sessionId = response.headers.get('mcp-session-id') ?? undefined
    const raw = await response.text()
    let payload: unknown = undefined
    for (const line of raw.split('\n')) {
      const trimmed = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        payload = JSON.parse(trimmed)
      } catch {
        // keep the last parseable object
      }
    }
    return { status: response.status, sessionId, payload }
  }

  private async initialize(): Promise<void> {
    this.sessionId = undefined
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vesta-memory-notes', version: '0.1.0' } },
    })
    if (result.status >= 400) throw new Error(`memory server initialize answered ${String(result.status)}`)
    this.sessionId = result.sessionId
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
  }

  /**
   * Call one tool; re-initializes once when the server has forgotten the session.
   * @param name - the tool name.
   * @param args - the arguments.
   * @returns the concatenated text content and the error flag.
   */
  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.sessionId === undefined) await this.initialize()
    let result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } })
    if (result.status === 404 || result.status === 400) {
      await this.initialize()
      result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } })
    }
    if (result.status >= 400) throw new Error(`memory server answered ${String(result.status)} to ${name}`)
    const payload = result.payload as {
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean }
      error?: { message?: string }
    } | undefined
    if (payload?.error !== undefined) throw new Error(`memory server error on ${name}: ${payload.error.message ?? 'unknown'}`)
    const content = payload?.result?.content ?? []
    return {
      text: content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'),
      isError: payload?.result?.isError === true,
    }
  }
}
