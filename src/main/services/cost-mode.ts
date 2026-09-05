import { getStore } from '../store'

/** How hard a space tries to save tokens. Lean beats budget; a space setting beats the app default. */
export type CostMode = 'standard' | 'budget' | 'lean'

export const LEAN = {
  /** Tool calls allowed per user message before the agent must stop and report. */
  toolCap: 25,
  /** Budget mode's looser cap. The SDK's maxBudgetUsd is per session, not per turn, so a tool cap is the per-turn brake. */
  budgetToolCap: 60,
  /** Bash output is cut to this many trailing lines. */
  bashTail: 120,
  /** Reviews: turn caps. */
  reviewTurns: 30,
  fixTurns: 50,
  effort: 'medium' as const
}

export function costModeFor(spaceId?: string): CostMode {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const lean = space?.leanMode ?? settings.leanMode ?? false
  if (lean) return 'lean'
  const budget = space?.budgetMode ?? settings.budgetMode ?? false
  return budget ? 'budget' : 'standard'
}

/** Sonnet unless the chosen model is already Sonnet or Haiku. */
export function leanModel(model: string): string {
  return /haiku|sonnet/.test(model) ? model : 'sonnet'
}

/** Cut a shell command's output to the last lines, unless it already limits itself or runs detached. */
export function leanBashCommand(cmd: string): string {
  const c = cmd.trim()
  if (!c || /\|\s*(tail|head|wc|grep|jq|cut|sed|awk)\b/.test(c) || /&\s*$/.test(c) || /\bnohup\b/.test(c)) return cmd
  return `( ${c} ) 2>&1 | tail -n ${LEAN.bashTail}`
}

/**
 * Tools lean mode removes. Measured: an explicit `tools` allow-list rewrites the tool block and
 * defeats Claude Code's shared prompt cache (126k tokens written per fresh session instead of 11k),
 * while `disallowedTools` keeps the cache warm. Same for `excludeDynamicSections`, so lean leaves the preset alone.
 */
export const LEAN_DISALLOWED = ['Agent', 'WebFetch', 'WebSearch', 'NotebookEdit']

export function leanPrompt(): string {
  return [
    '',
    'Lean mode: the user is on a tight token budget. Work alone; there is no crew and no subagents. Read only what the task needs: targeted greps and small ranges, never whole directories or exploratory sweeps. Do not run whole test suites or builds unless asked; run the narrowest check that proves the change. Keep answers short, no summaries of what you read. Do not re-read files you already have in context.',
    `Sinfonie allows ${LEAN.toolCap} tool calls per message in this mode. When it refuses a call, stop, say in a few lines what is done and what remains, and let the user say "continue".`
  ].join('\n')
}
