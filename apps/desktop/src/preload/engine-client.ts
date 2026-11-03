// Newline-delimited JSON-RPC client for studio-engine over the local socket
// (a named pipe on Windows, a Unix socket elsewhere). Reconnects on its own.

import net from 'node:net'
import type { LinkState } from '../shared/api'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class EngineClient {
  private socket?: net.Socket
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(s: LinkState) => void>()
  private eventListeners = new Set<(method: string, params: unknown) => void>()
  state: LinkState = 'connecting'

  constructor(private path: string) {
    this.connect()
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onEvent(cb: (method: string, params: unknown) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const socket = this.socket
    if (!socket || this.state !== 'connected') return Promise.reject(new Error('The engine is not connected yet.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private setState(s: LinkState) {
    if (s === this.state) return
    this.state = s
    for (const cb of this.listeners) cb(s)
  }

  private connect() {
    const socket = net.connect(this.path)
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('connect', () => this.setState('connected'))
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined
      for (const p of this.pending.values()) p.reject(new Error('The engine disconnected.'))
      this.pending.clear()
      this.buffer = ''
      this.setState('disconnected')
      setTimeout(() => this.connect(), 300)
    })
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.trim()) continue
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id == null) {
        if (msg.method) for (const cb of this.eventListeners) cb(msg.method, msg.params)
        continue
      }
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }
}
