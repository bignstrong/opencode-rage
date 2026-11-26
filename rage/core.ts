import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const bundled = fileURLToPath(new URL('../native/target/release/rage-core', import.meta.url))
const unexpected = () => new Error('Некорректный ответ rage-core')

function recorderEnv() {
  const override = process.env.RAGE_FFMPEG || process.env.FFMPEG_BIN || process.env.OPENCODE_VOICE_FFMPEG
  if (override) return { ...process.env, RAGE_FFMPEG: override }
  try {
    const binary: unknown = createRequire(import.meta.url)('ffmpeg-static')
    if (typeof binary === 'string') {
      accessSync(binary, constants.X_OK)
      return { ...process.env, RAGE_FFMPEG: binary }
    }
  } catch { /* System FFmpeg can also provide AVFoundation. */ }
  return { ...process.env, RAGE_FFMPEG: 'ffmpeg' }
}

function launch(args: string[], frame: (value: unknown) => void, options: {
  signal?: AbortSignal; gracefulAbort?: string; env?: NodeJS.ProcessEnv
} = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const child = spawn(process.env.RAGE_CORE || bundled, args, {
    detached: true, stdio: 'pipe', env: options.env,
  })
  let error: Error | undefined
  let diagnostic = ''
  let deadline: NodeJS.Timeout | undefined
  let closed = false
  let groupKilled = false
  function kill() {
    if (closed || groupKilled || child.pid === undefined) return
    // Abort and exit can race. On macOS a second signal to a dying group can return EPERM.
    try { process.kill(-child.pid, 'SIGKILL'); groupKilled = true }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
  }
  function end(command: string) {
    if (closed) return
    if (!child.stdin.writableEnded) child.stdin.end(command)
    deadline ??= setTimeout(kill, command === 'stop\n' ? 12_000 : 1500)
  }
  const abort = () => options.gracefulAbort === undefined ? kill() : end(options.gracefulAbort)
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1024) })
  // An unplug can close the reader just before a user presses Stop.
  child.stdin.on('error', () => {})
  if (options.gracefulAbort === undefined) child.stdin.end()
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    if (error || signal?.aborted) return
    try { frame(JSON.parse(line)) }
    catch (cause) { error = cause instanceof Error ? cause : unexpected(); kill() }
  })
  child.once('error', e => { error = e })
  // A crashed core cannot reap its recorder or speech engine.
  child.once('exit', code => { if (code !== 0) kill() })
  signal?.addEventListener('abort', abort, { once: true })
  const done = new Promise<Error | undefined>(resolve => {
    child.once('close', (code, exitSignal) => {
      closed = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      resolve(error ?? (code === 0 ? undefined : new Error(diagnostic.trim() || `rage-core ${args[0]}: ${exitSignal ?? code}`)))
    })
  })
  return { done, end, kill }
}

async function result(args: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<unknown> {
  let value: unknown
  const process = launch(args, frame => {
    if (value !== undefined) throw unexpected()
    value = frame
  }, { signal, env })
  const error = await process.done
  signal?.throwIfAborted()
  if (error) throw error
  return value
}

function names(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(name => typeof name === 'string')) throw unexpected()
  return value
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw unexpected()
  return value
}

export async function listInputs(signal?: AbortSignal, env: NodeJS.ProcessEnv = recorderEnv()): Promise<string[]> {
  return names(await result(['devices'], signal, env))
}

export async function watchInputs(update: (names: string[]) => void, signal: AbortSignal): Promise<void> {
  const watcher = launch(['watch'], value => update(names(value)), { signal, gracefulAbort: '', env: recorderEnv() })
  const error = await watcher.done
  if (!signal.aborted) throw error ?? new Error('Наблюдение за микрофонами остановлено')
}

export type InputLevel = 0 | 1 | 2 | 3
export type ListenEvent = { event: 'waiting' } | { event: 'level'; level: InputLevel } | { event: 'heard'; id: number } | { event: 'text'; id: number; text: string }

export async function listen(source: { wav: string } | { input: string }, language: string, model: string,
  update: (event: ListenEvent) => void, signal: AbortSignal, env: NodeJS.ProcessEnv = recorderEnv(),
  onTrainingError = (message: string) => console.warn(message)) {
  signal.throwIfAborted()
  const args = 'wav' in source ? ['--wav', source.wav] : ['--input', source.input]
  if (!args[1]?.trim()) throw new Error(`Missing ${args[0]} value`)
  const dir = await mkdtemp(join(tmpdir(), 'rage-listen-'))
  try {
    const worker = launch(['listen', ...args, language, model], value => {
      if (typeof value !== 'object' || !value || !('event' in value)) throw unexpected()
      if (value.event === 'waiting') return update({ event: 'waiting' })
      if (value.event === 'training_error' && 'message' in value) return onTrainingError(string(value.message))
      if (value.event === 'level') {
        if (!('level' in value) || (value.level !== 0 && value.level !== 1 && value.level !== 2 && value.level !== 3)) throw unexpected()
        return update({ event: 'level', level: value.level })
      }
      if (!('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) throw unexpected()
      if (value.event === 'heard') return update({ event: 'heard', id: value.id })
      if (value.event !== 'text' || !('text' in value) || typeof value.text !== 'string') throw unexpected()
      update({ event: 'text', id: value.id, text: value.text })
    }, { signal, gracefulAbort: 'cancel\n', env: { ...env, TMPDIR: dir } })
    const error = await worker.done
    if (!signal.aborted && error) throw error
    if (!signal.aborted && 'input' in source) throw new Error('Microphone disconnected')
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export async function ensureDefaultModel(signal: AbortSignal): Promise<string> {
  return string(await result(['ensure-model'], signal))
}

export async function transcribe(path: string, settings: { language: string; model: string }, signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env, training?: { id: string; directory: string; onError: (message: string) => void }): Promise<string> {
  signal.throwIfAborted()
  const args = ['transcribe', path, settings.language || 'auto']
  if (settings.model && settings.model !== 'default') args.push(settings.model)
  // Killing the native process group also kills whisper, bypassing native temp-file destructors.
  const dir = await mkdtemp(join(tmpdir(), 'rage-stt-'))
  const workerEnv = {
    ...env, TMPDIR: dir, RAGE_TRAINING_TAKE_ID: training?.id,
    ...(training && { RAGE_TRAINING_DIR: training.directory }),
  }
  try {
    const value = await result(args, signal, workerEnv)
    if (training && typeof value === 'object' && value && 'text' in value && 'training_error' in value) {
      training.onError(string(value.training_error))
      return string(value.text)
    }
    return string(value)
  } catch (error) {
    if (training && signal.reason?.name === 'TimeoutError') {
      try {
        await result(['training-asr-timeout', ...args.slice(1)], AbortSignal.timeout(2000), workerEnv)
      } catch (failure) {
        training.onError(`RAGE_TRAINING_DIR: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
    }
    throw error
  }
  finally { await rm(dir, { recursive: true, force: true }) }
}

export async function startTake(input: string | null, onLost: () => void, signal?: AbortSignal,
  env: NodeJS.ProcessEnv = recorderEnv(), audioDir = tmpdir()) {
  signal?.throwIfAborted()
  const dir = await mkdtemp(join(audioDir, 'rage-take-'))
  const path = join(dir, 'take.wav')
  const dispose = async () => {
    await rm(path, { force: true })
    try { await rmdir(dir) } catch (cause) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
    }
  }
  try {
    let ready = false
    let finished: boolean | undefined
    let trainingId: string | undefined
    let trainingError: string | undefined
    let stopping = false
    let canceled = false
    let opened!: () => void
    const started = new Promise<void>(resolve => { opened = resolve })
    const recorder = launch(['record', path, ...(input === null ? [] : [input])], value => {
      if (typeof value !== 'object' || !value || !('event' in value)) throw unexpected()
      if (value.event === 'ready' && !ready && finished === undefined) { ready = true; opened(); return }
      if (value.event !== 'finished' || !('interrupted' in value) || typeof value.interrupted !== 'boolean' || finished !== undefined) throw unexpected()
      finished = value.interrupted || !stopping
      if ('training_error' in value) trainingError = string(value.training_error)
      if ('training_id' in value) {
        trainingId = string(value.training_id)
        if (!/^take-[a-zA-Z0-9]{16}$/.test(trainingId)) throw unexpected()
      }
    }, { signal, gracefulAbort: 'cancel\n', env })
    const timeout = setTimeout(recorder.kill, 15000)
    const hasAudio = async () => (await stat(path).catch(() => undefined))?.size
    const ended = recorder.done.then(async error => {
      if (!ready && !canceled && !signal?.aborted && !await hasAudio()) throw error ?? new Error('Не удалось начать запись')
      if (!stopping && !canceled && !signal?.aborted) onLost()
      return error
    })
    try { await Promise.race([started, ended]) }
    finally { clearTimeout(timeout) }
    if (signal?.aborted) { await ended; signal.throwIfAborted() }
    return {
      path,
      async finish() {
        stopping = true
        recorder.end('stop\n')
        try {
          const error = await ended
          signal?.throwIfAborted()
          if (canceled || !await hasAudio()) throw error ?? new Error('Запись пуста')
          const interrupted = !ready || !!error || finished !== false
          const directory = env.RAGE_TRAINING_DIR
          const training = !interrupted && trainingId && directory ? { id: trainingId, directory } : undefined
          return { path, interrupted, dispose, training, trainingError }
        } catch (cause) { await dispose(); throw cause }
      },
      async cancel() {
        canceled = true
        recorder.end('cancel\n')
        try { await ended } finally { await dispose() }
      },
    }
  } catch (error) { await dispose(); throw error }
}
