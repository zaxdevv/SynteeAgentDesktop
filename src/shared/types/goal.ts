export type GoalStatus = 'running' | 'paused' | 'blocked' | 'completed' | 'unverified' | 'stopped' | 'limit'
export interface ChatGoal {
  id: string
  chatId: string
  objective: string
  criteria: string[]
  constraints: string[]
  progress: string[]
  status: GoalStatus
  steps: number
  maxSteps: number
  createdAt: number
  updatedAt: number
  evidence: string[]
  blocker?: string
}
