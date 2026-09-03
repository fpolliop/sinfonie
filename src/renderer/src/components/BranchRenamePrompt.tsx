import React, { useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Dialog } from './ui'

/** Shown after a rename when the new name implies a different branch. */
export function BranchRenamePrompt(): React.JSX.Element | null {
  const prompt = useApp((s) => s.branchPrompt)
  const setBranchPrompt = useApp((s) => s.setBranchPrompt)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState(false)
  if (!prompt) return null
  const go = async (renameBranches: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke('workspaces:rename', prompt.workspaceId, prompt.name, { renameBranches })
      setBranchPrompt(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBranchPrompt(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Rename the branches too?" onClose={() => !busy && setBranchPrompt(null)} width={460}>
      <p className="mb-2 text-[13px]">
        The workspace will be called <strong>{prompt.name}</strong>.
      </p>
      <p className="mb-4 text-[12px] text-muted">
        Its branch in every repo is currently <code className="rounded bg-panel-2 px-1">{prompt.currentBranch}</code>. Rename it to <code className="rounded bg-panel-2 px-1">{prompt.newSlug}</code> as well? Branches already on GitHub are renamed there too, so open pull requests follow along. The folder on disk keeps its name.
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setBranchPrompt(null)} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => go(false)} disabled={busy}>
          Keep branch
        </Button>
        <Button variant="primary" onClick={() => go(true)} disabled={busy}>
          {busy ? 'Renaming…' : 'Rename branch too'}
        </Button>
      </div>
    </Dialog>
  )
}
