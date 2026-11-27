import { availableParallelism, freemem, totalmem } from 'node:os'
import type { AssistantHardwareAssessment, AssistantModelSize } from '../../shared/assistants'

const GiB = 1024 ** 3
const MINIMUM_TOTAL_MEMORY = 3 * GiB

interface HardwareSnapshot {
  platform: string
  architecture: string
  logicalCpus: number
  totalMemory: number
  availableMemory: number | null
}

export function hasAssistantRuntimeTarget(platform: string = process.platform, architecture: string = process.arch): boolean {
  return (platform === 'win32' || platform === 'linux') && architecture === 'x64'
}

export function getAssistantCpuThreads(logicalCpus = availableParallelism()): number {
  return Math.min(8, Math.max(1, Math.floor(logicalCpus / 2)))
}

function readHardware(): HardwareSnapshot {
  const physicalMemory = totalmem()
  const processLimit = process.constrainedMemory?.() ?? 0
  const totalMemory = processLimit > 0 ? Math.min(physicalMemory, processLimit) : physicalMemory
  const availableMemory = process.availableMemory?.() ?? freemem()
  // libuv reports zero for unknown system free memory and for exhausted cgroups.
  const availableKnown = availableMemory > 0 || (availableMemory === 0 && processLimit > 0 && processLimit < physicalMemory)
  return {
    platform: process.platform,
    architecture: process.arch,
    logicalCpus: Math.max(1, availableParallelism()),
    totalMemory,
    availableMemory: Number.isFinite(availableMemory) && availableKnown ? Math.min(totalMemory, availableMemory) : null,
  }
}

export function assessAssistantHardware(hardware = readHardware()): AssistantHardwareAssessment {
  const { platform, architecture, logicalCpus, totalMemory, availableMemory } = hardware
  const runtimeSupported = hasAssistantRuntimeTarget(platform, architecture)
  const tier = !runtimeSupported
    ? 'unsupported'
    : totalMemory < 8 * GiB || logicalCpus < 4
      ? 'limited'
      : totalMemory >= 24 * GiB && logicalCpus >= 8
        ? 'performance'
        : 'balanced'
  const modelSize: AssistantModelSize = tier === 'performance' ? 'qwen-coder-1.5b'
    : tier === 'balanced' ? '1.2B' : '0.8B'
  const recommendation: AssistantHardwareAssessment['recommendation'] = runtimeSupported && totalMemory >= MINIMUM_TOTAL_MEMORY ? {
    modelSize,
    ctxSize: tier === 'limited' ? 4096 : tier === 'performance' ? 16384 : 8192,
    device: 'cpu',
    threads: getAssistantCpuThreads(logicalCpus),
  } : null
  return {
    architecture,
    logicalCpus,
    totalMemoryGiB: Math.round(totalMemory / GiB * 10) / 10,
    availableMemoryGiB: availableMemory === null ? null : Math.round(availableMemory / GiB * 10) / 10,
    runtimeSupported,
    tier,
    recommendation,
  }
}

export function getAssistantStartupError(weightsBytes: number, contextTokens: number, hardware = readHardware()): string | undefined {
  if (!hasAssistantRuntimeTarget(hardware.platform, hardware.architecture)) {
    return 'Для этой системы нет встроенной сборки локальной модели. Поддерживаются Windows и Linux x64.'
  }
  if (hardware.totalMemory === 0) return 'Не удалось определить объём ОЗУ.'
  if (hardware.totalMemory < MINIMUM_TOTAL_MEMORY) return 'Для локальной модели нужно минимум 3 ГиБ ОЗУ.'
  // Reserve for the model, initial runtime allocations, and additional KV cache.
  const headroom = weightsBytes + 0.75 * GiB + Math.max(0, contextTokens - 4096) * 64 * 1024
  if (hardware.availableMemory !== null && hardware.availableMemory < headroom) {
    return `Для запуска освободите ОЗУ. Нужно примерно ${(headroom / GiB).toFixed(1)} ГиБ доступной памяти.`
  }
  return undefined
}
