// Starts studio-engine and keeps it alive. The engine exits by itself when our end of
// its stdin closes, so it never outlives the app (even if the app crashes).

import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { EngineProcess } from '../shared/api'
import { log } from './log'

const MAX_RESTARTS_PER_MINUTE = 5

export class EngineSupervisor extends EventEmitter {
  private child?: ChildProcess
  private restartTimes: number[] = []
  private stopping = false
  status: EngineProcess = { state: 'stopped' }

  constructor(private exe: string, private args: string[]) {
    super()
  }

  start() {
    this.stopping = false
    this.spawnEngine()
  }

  stop() {
    this.stopping = true
    this.child?.stdin?.end()
    this.child?.kill()
    this.setStatus({ state: 'stopped' })
  }

  private setStatus(status: EngineProcess) {
    this.status = { ...status, restarts: this.restartTimes.length }
    this.emit('status', this.status)
  }

  private spawnEngine() {
    const child = spawn(this.exe, [...this.args, '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.setStatus({ state: 'starting', pid: child.pid })
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
    // The engine's errors go to the log too (opened from the Dock or app grid, nobody sees stderr).
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d)
      log('engine', d.toString().trimEnd())
    })
    child.on('spawn', () => this.setStatus({ state: 'running', pid: child.pid }))
    child.on('error', (err) => {
      log('engine.error', `could not start: ${err.message}`)
      this.setStatus({ state: 'failed', error: `Could not start the engine: ${err.message}` })
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (this.stopping) return
      log('engine.exit', `exited (${code ?? signal})`)
      const now = Date.now()
      this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000)
      this.restartTimes.push(now)
      if (this.restartTimes.length > MAX_RESTARTS_PER_MINUTE) {
        this.setStatus({ state: 'failed', error: `The engine stopped ${this.restartTimes.length} times in a minute (last exit ${code ?? signal}).` })
        return
      }
      this.setStatus({ state: 'restarting', error: `Engine exited (${code ?? signal}); restarting.` })
      setTimeout(() => this.spawnEngine(), 250 * 2 ** (this.restartTimes.length - 1))
    })
  }
}
