import type { AgentCallbacks } from '../agent/types'

type PlanItem = Parameters<NonNullable<AgentCallbacks['onTodoUpdate']>>[0][number]

export const PLAN_PROGRESS_INTERVAL = 12

/** Checks the current checklist using completed tool calls from this run. */
export class PlanProgress {
  items: PlanItem[] = []
  private calls = 0
  private evidence = new Map<string, boolean>()

  setItems(items: PlanItem[]): void {
    items = items.filter(item => typeof item?.text === 'string').map(item => {
      const exactCommand = /^(?:run|запусти|выполни|прогони) `([^`]+)`[.!]?$/iu.exec(item.text.trim())?.[1]
      const command = (typeof item.verifyCommand === 'string' ? item.verifyCommand : exactCommand)?.trim()
      const verifyCommand = command && command.length <= 512 && !/[;&|<>\r\n]/.test(command) ? command : undefined
      return { ...item, verifyCommand }
    })
    const unchanged = items.length === this.items.length && items.every((item, index) =>
      item.text === this.items[index].text && item.verifyCommand === this.items[index].verifyCommand)
    if (!unchanged) this.resetEvidence()
    this.items = items
  }

  resetEvidence(): void {
    this.calls = 0
    this.evidence.clear()
  }

  observe(command?: string, success = false): void {
    this.calls++
    if (command && this.items.filter(item => item.verifyCommand === command).length === 1) {
      this.evidence.set(command, success)
    }
  }

  check(): PlanItem[] {
    if (this.calls < PLAN_PROGRESS_INTERVAL) return []
    this.calls %= PLAN_PROGRESS_INTERVAL
    const completed: PlanItem[] = []
    this.items = this.items.map(item => {
      if ((item.status !== 'pending' && item.status !== 'in_progress')
        || !item.verifyCommand || this.evidence.get(item.verifyCommand) !== true) return item
      const done = { ...item, status: 'done' as const }
      completed.push(done)
      return done
    })
    this.evidence.clear()
    return completed
  }
}
