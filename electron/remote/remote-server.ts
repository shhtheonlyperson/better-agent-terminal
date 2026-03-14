import { WebSocketServer, WebSocket } from 'ws'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { invokeHandler } from './handler-registry'
import { broadcastHub } from './broadcast-hub'
import { PROXIED_EVENTS, type RemoteFrame } from './protocol'

interface AuthenticatedClient {
  ws: WebSocket
  label: string
  connectedAt: number
}

export class RemoteServer {
  private wss: WebSocketServer | null = null
  private token: string = ''
  private clients: Map<WebSocket, AuthenticatedClient> = new Map()
  private broadcastListener: ((...args: unknown[]) => void) | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  configDir: string = '' // Set by main.ts to app.getPath('userData')

  get port(): number | null {
    const addr = this.wss?.address()
    if (addr && typeof addr === 'object') return addr.port
    return null
  }

  get isRunning(): boolean {
    return this.wss !== null
  }

  get connectedClients(): { label: string; connectedAt: number }[] {
    return Array.from(this.clients.values()).map(c => ({
      label: c.label,
      connectedAt: c.connectedAt
    }))
  }

  private loadPersistedToken(): string | null {
    if (!this.configDir) return null
    try {
      const tokenPath = path.join(this.configDir, 'server-token.json')
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
      return data.token || null
    } catch {
      return null
    }
  }

  private persistToken(token: string): void {
    if (!this.configDir) return
    try {
      fs.writeFileSync(
        path.join(this.configDir, 'server-token.json'),
        JSON.stringify({ token }, null, 2)
      )
    } catch (e) {
      console.warn('[RemoteServer] Failed to persist token:', e)
    }
  }

  start(port: number = 9876, token?: string): { port: number; token: string } {
    if (this.wss) throw new Error('Server already running')

    // Priority: explicit token > persisted token > new random token
    this.token = token || this.loadPersistedToken() || randomBytes(16).toString('hex')
    this.persistToken(this.token)

    this.wss = new WebSocketServer({ host: '0.0.0.0', port })

    this.wss.on('connection', (ws) => {
      let authenticated = false

      // Auth timeout — must authenticate within 5 seconds
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this.sendFrame(ws, { type: 'auth-result', id: '0', error: 'Auth timeout' })
          ws.close()
        }
      }, 5000)

      ws.on('message', async (raw) => {
        let frame: RemoteFrame
        try {
          frame = JSON.parse(raw.toString())
        } catch {
          return // ignore malformed
        }

        // Auth handshake
        if (frame.type === 'auth') {
          if (frame.token === this.token) {
            authenticated = true
            clearTimeout(authTimeout)
            this.clients.set(ws, {
              ws,
              label: (frame.args?.[0] as string) || 'Remote Client',
              connectedAt: Date.now()
            })
            this.sendFrame(ws, { type: 'auth-result', id: frame.id, result: true })
            console.log(`[RemoteServer] Client authenticated: ${this.clients.get(ws)?.label}`)
          } else {
            this.sendFrame(ws, { type: 'auth-result', id: frame.id, error: 'Invalid token' })
            ws.close()
          }
          return
        }

        if (!authenticated) {
          this.sendFrame(ws, { type: 'invoke-error', id: frame.id, error: 'Not authenticated' })
          return
        }

        // Pong
        if (frame.type === 'ping') {
          this.sendFrame(ws, { type: 'pong', id: frame.id })
          return
        }

        // Invoke
        if (frame.type === 'invoke' && frame.channel) {
          try {
            // Strip trailing nulls — JSON serializes undefined → null, breaking default params
            let args = frame.args || []
            while (args.length > 0 && args[args.length - 1] == null) {
              args = args.slice(0, -1)
            }
            const result = await invokeHandler(frame.channel, args)
            this.sendFrame(ws, { type: 'invoke-result', id: frame.id, result })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            this.sendFrame(ws, { type: 'invoke-error', id: frame.id, error: message })
          }
          return
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this.clients.get(ws)
        if (client) {
          console.log(`[RemoteServer] Client disconnected: ${client.label}`)
        }
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        console.error('[RemoteServer] WebSocket error:', err.message)
        this.clients.delete(ws)
      })
    })

    // Subscribe to broadcastHub → push proxied events to all clients
    this.broadcastListener = (channel: unknown, ...args: unknown[]) => {
      if (typeof channel !== 'string') return
      if (!PROXIED_EVENTS.has(channel)) return
      const frame: RemoteFrame = {
        type: 'event',
        id: '0',
        channel,
        args
      }
      const data = JSON.stringify(frame)
      for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data)
        }
      }
    }
    broadcastHub.on('broadcast', this.broadcastListener)

    // Heartbeat — detect dead connections every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return
      for (const client of this.clients.values()) {
        if (client.ws.readyState !== WebSocket.OPEN) {
          this.clients.delete(client.ws)
          continue
        }
        client.ws.ping()
      }
    }, 30000)

    console.log(`[RemoteServer] Started on port ${port}, token: ${this.token.substring(0, 8)}...`)
    return { port, token: this.token }
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    if (this.broadcastListener) {
      broadcastHub.off('broadcast', this.broadcastListener)
      this.broadcastListener = null
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close()
    }
    this.clients.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    console.log('[RemoteServer] Stopped')
  }

  private sendFrame(ws: WebSocket, frame: RemoteFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
}
