/**
 * The review inbox (redesign phase 5): one list for pull requests, builder hand-offs and incidents, each change
 * with a pre-read (what it does, in plain words) and a risk level with its reasons.
 */

export type RiskLevel = 'low' | 'medium' | 'high'

/** Where the "what it does" sentence came from, so the reader knows how much to trust it. */
type PreReadSource = 'ai-review' | 'description' | 'heuristic'

export interface PreRead {
  /** "owner/name#number" for a pull request, "ws:<id>" for a local workspace without one. */
  key: string
  summary: string
  summarySource: PreReadSource
  risk: RiskLevel
  /** Plain reasons behind the risk, most important first. */
  reasons: string[]
  /** The risk is always computed by rules on the diff, checks and findings, never guessed by a model. */
  riskSource: 'heuristic'
  files: number
  additions: number
  deletions: number
  /** Changed paths (first 200), for the detail pane. */
  paths: string[]
  checks: { passed: number; failed: number; pending: number; failedNames: string[] }
  headRefName?: string
  baseRefName?: string
  isFork?: boolean
  /** The head commit read (PR head, or the local branches' HEADs joined): "updated since" compares against it. */
  headSha?: string
  computedAt: string
}

/** What the reviewer did with an item: asked for changes (a note went back) or approved it. */
export interface InboxMark {
  state: 'changes-requested' | 'approved'
  note: string
  at: string
  /** Where the note went: the builder's conversation, or a GitHub review. */
  via: 'conversation' | 'github'
  url?: string
  /** The head commit when the reviewer acted; a different head later means the change was updated since. */
  headSha?: string
}
