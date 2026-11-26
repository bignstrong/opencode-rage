import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ensureDefaultModel, listen, listInputs, startTake, transcribe, watchInputs, type ListenEvent } from './core.ts'
import type { Plugin } from '@opencode/plugin/tui'
import type { KeymapLayer } from '@opencode/plugin/tui/context'
import tui from '../src/tui.ts'

let root: string, log: string
const previous = Object.fromEntries(['RAGE_RUST', 'RAGE_CORE', 'RAGE_FFMPEG', 'RAGE_FIXTURE', 'RAGE_LOG', 'TMPDIR', 'RAGE_LISTEN_WAV'].map(key => [key, process.env[key]]))
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'rage-adapter-test-'))
  log = join(root, 'log')
  const binary = join(root, 'fixture core')
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [cmd, ...args] = process.argv.slice(2)
const mode = process.env.RAGE_FIXTURE
const log = value => fs.appendFileSync(process.env.RAGE_LOG, JSON.stringify(value) + '\\n')
const frame = value => console.log(JSON.stringify(value))
log([cmd, ...args])
if (cmd === 'devices') {
  if (mode === 'malformed') frame([1])
  else frame(['USB', 'USB', 'Диктофон'])
} else if (cmd === 'watch') {
  frame([]); frame(['Диктофон'])
  process.stdin.resume().on('end', () => log(['watch closed']))
} else if (cmd === 'listen') {
  fs.writeFileSync(process.env.TMPDIR + '/unfinished.wav', 'fixture audio')
  if (mode === 'malformed') frame({event:'text', id:'1', text:'bad id'})
  else if (mode === 'bad level') frame({event:'level', level:Number(args[1])})
  else {
    frame({event:'waiting'})
    for (const level of [0, 1, 2, 3]) frame({event:'level', level})
    frame({event:'heard', id:1})
    frame({event:'text', id:1, text:'мой текст'})
    if (mode === 'training') frame({event:'training_error', message:'training disk full'})
    if (args[0] === '--input' && mode !== 'lost') {
      process.stdin.on('data', chunk => log([String(chunk).trim()]))
    }
  }
} else if (cmd === 'record') {
  if (mode === 'missing') { console.error('Микрофон отключён'); process.exit(1) }
  fs.writeFileSync(args[0], 'fixture audio')
  if (mode === 'early') process.exit(1)
  frame({ event: 'ready' })
  if (mode === 'unplug') { frame({event:'finished', interrupted:true}); process.exit(0) }
  let command = ''
  process.stdin.setEncoding('utf8').on('data', chunk => command += chunk).on('end', () => {
    log([command.trim()])
    if (mode === 'crash') process.exit(1)
    const training = mode === 'training' && command.trim() === 'stop'
    frame({event: 'finished', interrupted: false, ...(training && {training_id: 'take-ABCDEFGHIJKLMNOP'})})
  })
} else if (cmd === 'ensure-model') {
  frame('/models/base.bin')
} else if (cmd === 'transcribe') {
  if (mode === 'training') {
    log(['training', process.env.RAGE_TRAINING_TAKE_ID, process.env.RAGE_TRAINING_DIR])
    if (process.env.RAGE_TRAINING_TAKE_ID) {
      frame({text: 'мой текст', training_error: 'training disk full'})
      process.exit(0)
    }
  }
  if (mode === 'host' || mode === 'crash') {
    if (process.env.RAGE_RECOVER_WAV !== (mode === 'crash' ? '1' : '0')) process.exit(2)
    log(['native options', process.env.RAGE_FFMPEG, process.env.RAGE_WHISPER, process.env.OPENCODE_VOICE_TRANSCRIBE_CPP, process.env.RAGE_CLEANUP_FILTER])
  }
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.TMPDIR + '/unfinished.txt', 'fixture')
    log(['whisper', child.pid, process.env.TMPDIR])
  } else if (mode === 'failed') {
    console.error('whisper failed'); process.exit(1)
  } else frame('мой текст')
} else if (cmd === 'training-asr-timeout') {
  log(['timeout ID', process.env.RAGE_TRAINING_TAKE_ID])
}
`, { mode: 0o700 })
  Object.assign(process.env, { RAGE_CORE: binary, RAGE_FFMPEG: binary, RAGE_LOG: log, TMPDIR: root })
})
beforeEach(async () => { process.env.RAGE_FIXTURE = ''; await writeFile(log, '') })
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { force: true, recursive: true })
})
async function events(): Promise<unknown[][]> {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function waitUntil<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4000
  do {
    const value = await check()
    if (value !== undefined) return value
    await delay(10)
  } while (Date.now() < deadline)
  throw new Error('Fixture timed out')
}
const settings = { language: 'ru', model: 'default' }

test('one-shot commands preserve Unicode, duplicates, optional args, spaces, and native errors', async () => {
  const { signal } = new AbortController()
  assert.deepEqual(await listInputs(signal), ['USB', 'USB', 'Диктофон'])
  assert.equal(await ensureDefaultModel(signal), '/models/base.bin')
  assert.equal(await transcribe('/voice input', settings, signal), 'мой текст')
  assert.equal(await transcribe('/voice input', { ...settings, model: '/модели/a b.bin' }, signal), 'мой текст')
  assert.deepEqual(await events(), [
    ['devices'], ['ensure-model'], ['transcribe', '/voice input', 'ru'], ['transcribe', '/voice input', 'ru', '/модели/a b.bin'],
  ])
  process.env.RAGE_FIXTURE = 'malformed'
  await assert.rejects(listInputs(signal), /Некорректный/)
  process.env.RAGE_FIXTURE = 'failed'
  await assert.rejects(transcribe('/a', settings, signal), /whisper failed/)
  assert.deepEqual((await readdir(root)).filter(x => x.startsWith('rage-stt-')), [])
})

test('watch consumes initial and changed frames and closes stdin on abort', async () => {
  const controller = new AbortController()
  const snapshots: string[][] = []
  await watchInputs(inputs => {
    snapshots.push(inputs)
    if (snapshots.length === 2) controller.abort()
  }, controller.signal)
  assert.deepEqual(snapshots, [[], ['Диктофон']])
  assert.deepEqual(await events(), [['watch'], ['watch closed']])
})

test('listen passes only the explicit source, drains WAV EOF and drops frames after abort', async () => {
  const frames: ListenEvent[] = []
  const ac = new AbortController()
  await listen({ wav: '/source with spaces.wav' }, 'ru', '/models/small.bin', e => frames.push(e), ac.signal)
  assert.deepEqual(frames, [
    { event: 'waiting' }, ...[0, 1, 2, 3].map(level => ({ event: 'level', level })),
    { event: 'heard', id: 1 }, { event: 'text', id: 1, text: 'мой текст' },
  ])
  await listen({ input: ':pinned iPhone' }, 'auto', 'whisper-base', e => { frames.push(e); ac.abort() }, ac.signal)
  assert.equal(frames.length, 8)
  assert.deepEqual(await events(), [
    ['listen', '--wav', '/source with spaces.wav', 'ru', '/models/small.bin'],
    ['listen', '--input', ':pinned iPhone', 'auto', 'whisper-base'], ['cancel'],
  ])
  const { signal } = new AbortController()
  process.env.RAGE_FIXTURE = 'lost'
  await assert.rejects(listen({ input: ':pinned' }, 'auto', 'm', () => {}, signal), /disconnected/)
  await assert.rejects(listen({ wav: '' }, 'auto', 'm', () => {}, signal), /--wav/)
  process.env.RAGE_FIXTURE = 'malformed'
  await assert.rejects(listen({ wav: 'bad' }, 'auto', 'm', () => {}, signal), /Некорректный/)
  assert.equal((await events()).filter(([cmd]) => cmd === 'listen').length, 4)
  assert.deepEqual((await readdir(root)).filter(x => x.startsWith('rage-listen-')), [])
})

test('listen rejects meter levels outside the four integer buckets', async () => {
  process.env.RAGE_FIXTURE = 'bad level'
  const { signal } = new AbortController()
  for (const wav of ['-1', '1.5', '4']) {
    await assert.rejects(listen({ wav }, 'auto', 'm', () => assert.fail('invalid level'), signal), /Некорректный/)
  }
})

test('listen reports training warnings without dropping normal events', async () => {
  process.env.RAGE_FIXTURE = 'training'
  const { signal } = new AbortController()
  const frames: ListenEvent[] = []
  const warnings: string[] = []
  await listen({ wav: 'fixture.wav' }, 'auto', 'm', frame => frames.push(frame), signal,
    process.env, message => warnings.push(message))
  assert.equal(frames.at(-1)?.event, 'text')
  assert.deepEqual(warnings, ['training disk full'])
})

test('a normal take waits for stop and hands off a disposable WAV', async () => {
  const take = await startTake('USB Mic', () => assert.fail('unexpected input loss'))
  const { path, interrupted, dispose } = await take.finish()
  assert.equal(interrupted, false)
  assert.deepEqual(await events(), [['record', path, 'USB Mic'], ['stop']])
  assert.equal(await readFile(path, 'utf8'), 'fixture audio')
  await dispose()
  await assert.rejects(readdir(dirname(path)), { code: 'ENOENT' })
})

test('only stopped owned takes can hand off their training ID; errors do not discard recognized text', async () => {
  process.env.RAGE_FIXTURE = 'training'
  const directory = join(root, 'training')
  const env = { ...process.env, RAGE_TRAINING_DIR: directory, RAGE_TRAINING_TAKE_ID: 'untrusted' }
  const take = await startTake(null, () => assert.fail('unexpected input loss'), undefined, env)
  const recording = await take.finish()
  assert.deepEqual(recording.training, { id: 'take-ABCDEFGHIJKLMNOP', directory })
  const { signal } = new AbortController()
  const warnings: string[] = []
  assert.equal(await transcribe(recording.path, settings, signal, env, {
    ...recording.training!, onError: message => warnings.push(message),
  }), 'мой текст')
  assert.deepEqual(warnings, ['training disk full'])
  assert.equal(await transcribe('/external.wav', settings, signal, env), 'мой текст')
  assert.deepEqual((await events()).filter(([cmd]) => cmd === 'training'), [
    ['training', 'take-ABCDEFGHIJKLMNOP', directory],
    ['training', null, directory],
  ])
  await recording.dispose()
})

test('unplug and pre-ready exit publish a partial draft; a crash racing Stop also marks it interrupted', async () => {
  for (const mode of ['unplug', 'early', 'crash']) {
    process.env.RAGE_FIXTURE = mode
    let lost!: () => void
    const notification = new Promise<void>(resolve => { lost = resolve })
    const take = await startTake(null, lost)
    if (mode !== 'crash') await notification
    const recovered = await take.finish()
    assert.equal(recovered.interrupted, true)
    assert.equal(await readFile(recovered.path, 'utf8'), 'fixture audio')
    await recovered.dispose()
  }
})

test('startup failure and cancellation remove temp audio; default mic adds no argv', async () => {
  process.env.RAGE_FIXTURE = 'missing'
  await assert.rejects(startTake('USB', () => assert.fail('not ready')), /Микрофон отключён/)
  process.env.RAGE_FIXTURE = ''
  const controller = new AbortController()
  const take = await startTake(null, () => assert.fail('canceled'), controller.signal)
  controller.abort()
  await take.cancel()
  const log = await events()
  assert.equal(log[1].length, 2)
  assert.deepEqual(log[2], ['cancel'])
  assert.deepEqual((await readdir(root)).filter(x => x.startsWith('rage-take-')), [])
})

test('aborting transcription stops the whisper descendant and removes its partial files', async () => {
  process.env.RAGE_FIXTURE = 'hang'
  const controller = new AbortController()
  const task = transcribe('/a', settings, controller.signal)
  try {
    const [, pid, dir] = await waitUntil(async () => (await events()).find(([cmd]) => cmd === 'whisper'))
    assert.equal(typeof pid, 'number')
    assert.equal(typeof dir, 'string')
    assert.ok((await readdir(String(dir))).includes('unfinished.txt'))
    controller.abort()
    await assert.rejects(task, { name: 'AbortError' })
    await waitUntil(async () => {
      try { process.kill(Number(pid), 0) }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; throw e }
    })
    await assert.rejects(readdir(String(dir)), { code: 'ENOENT' })
  } finally { controller.abort(); await task.catch(() => {}) }
})

test('owned manual recording marks its ASR timeout after killing the old worker', async () => {
  process.env.RAGE_FIXTURE = 'hang'
  const controller = new AbortController()
  const id = 'take-ABCDEFGHIJKLMNOP'
  const task = transcribe('/a', settings, controller.signal, process.env, {
    id, directory: root, onError: message => assert.fail(message),
  })
  try {
    await waitUntil(async () => (await events()).find(([cmd]) => cmd === 'whisper'))
    controller.abort(new DOMException('test timeout', 'TimeoutError'))
    await assert.rejects(task, { name: 'TimeoutError' })
    assert.deepEqual((await events()).at(-1), ['timeout ID', id])
  } finally { controller.abort(); await task.catch(() => {}) }
})

test('full V2 host routes native takes through the existing submit, model, settings and unplug paths', {
  skip: process.platform !== 'darwin',
}, async () => {
  process.env.RAGE_RUST = '1'
  const sent: unknown[] = []
  const confirmations: string[] = []
  const toasts: string[] = []
  let layer!: () => KeymapLayer
  const store = {
    model: 'whisper-small', language: 'de', uiLanguage: 'ru',
    mic: ':uid:1:iPhone', autoSubmit: true, onboardingDone: true, setupSkipped: true,
    downloadDir: join(root, 'models and takes'), cleanupCutoffHz: 180, voiceEnhance: true,
    recordingHotkey: 'alt+r', hotkeyMigratedV3: true,
  }
  const models = join(store.downloadDir, 'models')
  const whisper = join(models, 'ggml-small.bin')
  const breeze = join(models, 'Breeze-ASR-25-Q4_K_M.gguf')
  await mkdir(models, { recursive: true })
  await writeFile(whisper, 'fixture whisper model')
  await writeFile(breeze, 'fixture sidecar model')
  const binary = process.env.RAGE_CORE
  const done = await tui.setup({
    options: { whisperCli: binary, transcribeCpp: binary, ffmpeg: binary,
      ready: { isModelDownloaded: () => true, ensureEngineReady: async () => true,
        ensureRecorderReady: async () => true, ensureDownloaded: async () => true } },
    storage: { store: (_: string, { initial }: { initial: object }) => [
      Object.assign(store, { ...initial, ...store }), (mutate: (value: object) => void) => mutate(store),
    ] },
    ui: { toast: { show: ({ message }: { message: string }) => toasts.push(message) },
      router: { current: () => ({ type: 'session', sessionID: 'original' }) },
      dialog: { confirm: async ({ title }: { title: string }) => { confirmations.push(title); return false } },
      slot: ({ append, render }: { append: string; render: () => unknown }) => {
        if (append === 'app') render()
        return () => {}
      } },
    keymap: { layer: (fn: () => KeymapLayer) => { layer = fn } },
    client: { session: { prompt: async (value: unknown) => sent.push(value) } },
  } as unknown as Plugin.Context)
  try {
    const commands = layer().commands!
    assert.deepEqual(commands.map(c => c.slash?.name), ['voice', 'voice-submit', 'voice-stop', 'voice-settings', 'orbs', 'rage-listen'])
    const cmd = commands.find(c => c.id === 'voice.record')!
    assert.equal(cmd.bind, 'alt+r')
    process.env.RAGE_FIXTURE = 'host'
    await cmd.run()
    await cmd.run()
    assert.deepEqual(sent, [{ sessionID: 'original', text: 'мой текст' }], toasts.join('\n'))
    let log = await events()
    const [, wav, mic] = log[0]
    assert.equal(mic, store.mic)
    assert.ok(String(wav).startsWith(join(store.downloadDir, 'recordings')))
    assert.deepEqual(log[2], ['transcribe', wav, 'de', whisper])
    assert.deepEqual(log[3], ['native options', binary, binary, process.env.OPENCODE_VOICE_TRANSCRIBE_CPP ?? null,
      'highpass=f=180,adeclick,dynaudnorm=f=150:g=7,alimiter=limit=0.95'])
    await assert.rejects(readdir(dirname(String(wav))), { code: 'ENOENT' })
    store.voiceEnhance = false
    process.env.RAGE_FIXTURE = 'crash'
    await cmd.run()
    await cmd.run()
    assert.equal(sent.length, 1)
    assert.deepEqual(confirmations, ['Микрофон недоступен'])
    assert.ok(toasts.some(t => t.includes('исходное поле ввода')))
    log = await events()
    assert.equal(log.at(-1)?.at(-1), '')
    process.env.RAGE_FIXTURE = 'host'
    store.model = 'handy-breeze-asr-25-gguf'
    store.language = 'auto'
    await cmd.run()
    await cmd.run()
    assert.equal(sent.length, 2)
    log = await events()
    assert.deepEqual(log.at(-2)?.slice(2), ['auto', breeze])
    assert.deepEqual(log.at(-1), ['native options', binary, process.env.RAGE_WHISPER ?? null, binary, ''])
    process.env.RAGE_FIXTURE = 'hang'
    await cmd.run()
    const decoding = cmd.run()
    await waitUntil(async () => (await events()).find(([cmd]) => cmd === 'whisper'))
    await commands.find(c => c.id === 'voice.stop')!.run()
    await decoding
    assert.equal(sent.length, 2)
    assert.deepEqual(await readdir(join(store.downloadDir, 'recordings')), [])

    process.env.RAGE_LISTEN_WAV = join(root, 'explicit QA.wav')
    process.env.RAGE_FIXTURE = ''
    await commands.find(c => c.id === 'voice.listen')!.run()
    const listenCall = await waitUntil(async () => (await events()).find(([cmd]) => cmd === 'listen'))
    assert.deepEqual(listenCall, ['listen', '--wav', process.env.RAGE_LISTEN_WAV, 'auto', breeze])
    await commands.find(c => c.id === 'voice.stop')!.run()
    assert.equal(sent.length, 2)

    // Exercise the real native error classification when enumeration succeeds but opening fails.
    const ffmpeg = join(root, 'missing pinned input')
    await writeFile(ffmpeg, `#!/bin/sh
case " $* " in
  *' -list_devices '*) printf 'AVFoundation audio devices:\\n[0] iPhone  [uid:1]\\n' >&2; exit 1;;
esac
echo '[avfoundation @ 0x1] Audio device not found' >&2
exit 1
`, { mode: 0o700 })
    process.env.RAGE_CORE = fileURLToPath(new URL('../native/target/release/rage-core', import.meta.url))
    process.env.RAGE_FFMPEG = ffmpeg
    await cmd.run()
    assert.deepEqual(confirmations, ['Микрофон недоступен', 'Микрофон недоступен'], toasts.join('\n'))
    assert.equal(sent.length, 2)
    assert.deepEqual(await readdir(join(store.downloadDir, 'recordings')), [])
  } finally { if (typeof done === 'function') await done() }
})
