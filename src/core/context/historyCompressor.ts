import type { AssistantsSettings } from '../../shared/assistants'
import type { ChatMessage } from './contextManager'
import { Janitor, type JanitorArchiveEntry } from './janitor'

/**
 * Reconstruct the optimized view of the surviving history for an estimate.
 * The worker applies the same rules to its own messages. Saved tool steps
 * stay exact so hiding, editing or rewinding later messages is reversible.
 */
export function projectRequestHistory(
  messages: ChatMessage[],
  settings: AssistantsSettings,
  calibrationKey?: string,
  archive?: JanitorArchiveEntry[],
): ChatMessage[] {
  if (!settings.enabled || !settings.janitorEnabled || messages.length === 0) return messages
  const janitor = new Janitor(settings)
  const history = archive?.length ? [...messages] : messages
  if (archive?.length) {
    janitor.hydrateArchive(archive)
    janitor.restoreSummaries(history)
  }
  const report = janitor.scan(history, 0, 'light', undefined, calibrationKey)
  return report.totalTokensSaved >= settings.janitorMinSavingsTokens ? janitor.apply(history, report) : history
}
