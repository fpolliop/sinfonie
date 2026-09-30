/**
 * One queue per workspace for git work that must not overlap: the guided turn-end checkpoint (agent.ts) and
 * "Undo this change" (builder.ts). Without it an undo could race the checkpoint (git's index.lock, or the checkpoint
 * absorbing half-reverted files).
 */
const tails = new Map<string, Promise<unknown>>()

export function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(workspaceId) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  tails.set(workspaceId, tail)
  void tail.then(() => {
    if (tails.get(workspaceId) === tail) tails.delete(workspaceId)
  })
  return run
}
