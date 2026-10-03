import { useSettingsStore } from '../store/settings.store'

export interface AudioFrame {
  level: number
  bands: number[]
  bass: number
  mid: number
  treble: number
  timestamp: number
  muted?: boolean
}

/** Шейдерные пресеты визуализатора (WebGL2, как анимированный фон). */
export const AUDIO_VISUALIZER_PRESETS = ['fire', 'sparks', 'wave', 'spectrum'] as const
export type AudioVisualizerPreset = (typeof AUDIO_VISUALIZER_PRESETS)[number]

/** Старые canvas-пресеты (neon/spectrum/fluid/pulse/full) больше не существуют. */
export function normalizeVisualizerPreset(value: unknown): AudioVisualizerPreset {
  return AUDIO_VISUALIZER_PRESETS.includes(value as AudioVisualizerPreset)
    ? (value as AudioVisualizerPreset)
    : 'fire'
}

export interface AudioOutputDevice {
  id: string
  name: string
  isDefault: boolean
  level: number
}

type Listener = (frame: AudioFrame | null) => void
type DeviceListener = (devices: AudioOutputDevice[]) => void
type DeviceStatusListener = (running: boolean) => void

const listeners = new Set<Listener>()
const demoListeners = new Set<Listener>()
const deviceListeners = new Set<DeviceListener>()
const deviceStatusListeners = new Set<DeviceStatusListener>()
let lastFrame: AudioFrame | null = null
let audioDevices: AudioOutputDevice[] = []
let deviceMonitorUnsubUpdate: (() => void) | null = null
let deviceMonitorUnsubStopped: (() => void) | null = null
let deviceMonitorRunning = false
let frameUnsub: (() => void) | null = null
let frameStoppedUnsub: (() => void) | null = null
let demoFrameId = 0
let demoStartedAt = 0

function emit(frame: AudioFrame | null) {
  lastFrame = frame
  for (const listener of listeners) listener(frame)
}

function emitDevices(devices: AudioOutputDevice[]) {
  audioDevices = devices
  for (const listener of deviceListeners) listener(devices)
}

function emitDeviceStatus(running: boolean) {
  deviceMonitorRunning = running
  for (const listener of deviceStatusListeners) listener(running)
}

// ── Демо-режим (настройки, превью без реального звука) ────────────────────

export function subscribeAudioVisualizer(listener: Listener, demo = false) {
  const target = demo ? demoListeners : listeners
  target.add(listener)
  listener(demo ? null : lastFrame)
  return () => { target.delete(listener) }
}

export function stopAudioVisualizerDemo() {
  cancelAnimationFrame(demoFrameId)
  demoFrameId = 0
  demoStartedAt = 0
  for (const listener of demoListeners) listener(null)
}

export function startAudioVisualizerDemo() {
  cancelAnimationFrame(demoFrameId)
  const started = performance.now()
  const demoId = started
  const tick = (now: number) => {
    if (demoFrameId === 0 || demoId !== demoStartedAt) return
    const elapsed = (now - started) / 1000
    // Спектр, похожий на музыку: бас качает, верха тише, «нота» бегает по частотам
    const note = 0.5 + 0.5 * Math.sin(elapsed * 2.1)
    const beat = Math.max(0, Math.sin(elapsed * Math.PI * 2.4)) ** 6
    const bands = Array.from({ length: 64 }, (_, i) => {
      const x = i / 63
      const shape = Math.max(0.08, 1 - x * 0.75) // низы громче
      const near = Math.exp(-((x - note) ** 2) * 40) // бегущая «нота»
      return Math.min(1, shape * (0.22 + 0.5 * Math.abs(Math.sin(elapsed * 3.1 + i * 0.35))) + near * 0.55)
    })
    const level = Math.min(1, 0.3 + 0.45 * beat + 0.15 * Math.abs(Math.sin(elapsed * 1.3)))
    const bass = Math.min(1, 0.35 + 0.6 * beat)
    const mid = Math.min(1, 0.3 + 0.4 * Math.abs(Math.sin(elapsed * 2.2)))
    const treble = Math.min(1, 0.18 + 0.35 * Math.abs(Math.sin(elapsed * 4.7)))
    for (const listener of demoListeners) listener({ level, bands, bass, mid, treble, timestamp: now })
    demoFrameId = requestAnimationFrame(tick)
  }
  demoStartedAt = demoId
  demoFrameId = requestAnimationFrame(tick)
  return () => {
    if (demoStartedAt === demoId) stopAudioVisualizerDemo()
  }
}

// ── Монитор устройств (список + live-уровни, только чтение) ───────────────

export function subscribeAudioOutputDevices(listener: DeviceListener) {
  deviceListeners.add(listener)
  listener(audioDevices)
  return () => { deviceListeners.delete(listener) }
}

/** Монитор устройств жив? Если false при пустом списке — он умер, а не «ещё ищет». */
export function subscribeAudioDeviceStatus(listener: DeviceStatusListener) {
  deviceStatusListeners.add(listener)
  listener(deviceMonitorRunning)
  return () => { deviceStatusListeners.delete(listener) }
}

export function getAudioOutputDevices(): AudioOutputDevice[] {
  return audioDevices
}

export async function startAudioOutputDeviceMonitor(): Promise<AudioOutputDevice[]> {
  const api = window.syntee.audioDevices
  if (!api) return audioDevices
  if (!deviceMonitorUnsubUpdate) {
    deviceMonitorUnsubUpdate = api.onUpdate(emitDevices)
  }
  if (!deviceMonitorUnsubStopped && api.onStopped) {
    deviceMonitorUnsubStopped = api.onStopped(() => {
      // Монитор умер (PowerShell упал) — гасим статус и список, UI покажет ошибку вместо вечного «Поиск…».
      emitDeviceStatus(false)
      emitDevices([])
    })
  }
  emitDeviceStatus(true)
  const devices = await api.startMonitor()
  emitDevices(devices)
  return devices
}

export async function stopAudioOutputDeviceMonitor() {
  deviceMonitorUnsubUpdate?.()
  deviceMonitorUnsubUpdate = null
  deviceMonitorUnsubStopped?.()
  deviceMonitorUnsubStopped = null
  emitDeviceStatus(false)
  await window.syntee.audioDevices?.stopMonitor()
}

// ── Захват системного звука с выбранного устройства ──────────────────────
// WASAPI loopback живёт в main-процессе (audioVisualizer.ipc.ts) и умеет
// ЛЮБОЕ устройство вывода — в отличие от прежнего Chromium loopback,
// который брал только устройство Windows по умолчанию.

function cleanupCapture() {
  frameUnsub?.()
  frameUnsub = null
  frameStoppedUnsub?.()
  frameStoppedUnsub = null
  emit(null)
}

export async function startSystemAudioVisualizer(deviceId?: string): Promise<void> {
  cleanupCapture()
  const api = window.syntee.audioVisualizer
  if (!api) throw new Error('Аудиозахват недоступен в этой сборке')
  // Устройство: явный аргумент → сохранённая настройка → устройство по умолчанию.
  const stored = (useSettingsStore.getState().settings as Record<string, unknown>)['audioVisualizerDeviceId']
  const id = deviceId ?? (typeof stored === 'string' && stored ? stored : null)
  // AGC-флаг живёт в main-процессе — синхронизируем сохранённую настройку
  // при каждом старте захвата (автозапуск, ручное подключение, смена
  // устройства), иначе после перезапуска приложения она потерялась бы.
  const storedAgc = (useSettingsStore.getState().settings as Record<string, unknown>)['audioVisualizerAgc']
  if (typeof storedAgc === 'boolean') void api.setAgc(storedAgc)
  frameUnsub = api.onFrame(frame => emit(frame))
  frameStoppedUnsub = api.onStopped(() => emit(null))
  try {
    await api.start(id)
  } catch (error) {
    cleanupCapture()
    throw error
  }
}

export function stopSystemAudioVisualizer() {
  cleanupCapture()
  void window.syntee.audioVisualizer?.stop()
}
