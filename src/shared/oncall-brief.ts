import type { Incident } from './types'

/** Turns an incident (the Slack thread and the triage) into the first message of a workspace chat. */
export function incidentBrief(inc: Incident): string {
  const r = inc.report
  const lines: string[] = []
  lines.push(`Work on this on-call incident: **${inc.title}**`)
  lines.push(`Source: #${inc.channelName}${inc.permalink ? ` (${inc.permalink})` : ''}, severity ${r?.severity ?? 'unknown'}, ${r?.category ?? 'uncategorised'}.`)
  lines.push('')
  if (r) {
    lines.push('## Triage so far')
    lines.push(r.summary)
    if (r.likelyCause) lines.push(`\n**Likely cause:** ${r.likelyCause}`)
    if (r.evidence?.length) lines.push('\n**Evidence:**', ...r.evidence.map((e) => `- ${e}`))
    if (r.nextSteps?.length) lines.push('\n**Suggested next steps:**', ...r.nextSteps.map((s) => `- ${s}`))
    if (r.proposedFix) {
      lines.push(`\n**Proposed fix** (in ${r.proposedFix.repo}): ${r.proposedFix.summary}`, ...r.proposedFix.changes.map((c) => `- ${c}`))
      if (r.proposedFix.risks) lines.push(`Risks: ${r.proposedFix.risks}`)
    }
    lines.push('')
  }
  if (inc.messages.length) {
    lines.push('## The thread')
    for (const m of inc.messages.slice(0, 40)) lines.push(`- **${m.userName ?? m.user}:** ${m.text.replace(/\s+/g, ' ').trim()}`)
    if (inc.messages.length > 40) lines.push(`- … ${inc.messages.length - 40} more messages in Slack`)
    lines.push('')
  }
  lines.push('Start by confirming the cause in the code and the logs, then propose a plan before changing anything. Keep the fix small and add a test where one is missing.')
  return lines.join('\n')
}
