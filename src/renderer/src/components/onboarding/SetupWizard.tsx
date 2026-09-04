import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FolderOpen, GitBranch, Loader2, LogIn, RefreshCw, Sparkles, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Badge, inputCls } from '../ui'
import { LoginDialog } from '../LoginDialog'
import { shortPath } from '@/lib/format'
import logo from '../../assets/logo.svg'
import { SPACE_COLORS, VENDORS, type ScannedRepo, type Vendor } from '@shared/types'

const STEPS = ['Welcome', 'Sign in', 'First space', 'Ready'] as const

/**
 * First-run setup: what Sinfonie is, sign in to the vendors you use, make a first space with
 * its repositories, then hand off to the first workspace or the tour. Every step can be skipped.
 */
export function SetupWizard({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const { settings, setError, setShowNewWorkspace, setOnboarding, setActiveSpace } = useApp()
  const finish = async (then?: 'workspace' | 'tour'): Promise<void> => {
    try {
      await api.invoke('settings:update', { onboarding: { ...(settings.onboarding ?? {}), setupDoneAt: new Date().toISOString() } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    onClose()
    if (spaceId) setActiveSpace(spaceId)
    if (then === 'workspace') setShowNewWorkspace(true, spaceId ?? undefined)
    if (then === 'tour') setOnboarding('tour')
  }
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg text-text">
      <div className="drag flex h-[52px] shrink-0 items-center justify-between pl-[88px] pr-4">
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <button key={s} className={clsx('no-drag flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]', i === step ? 'bg-panel-2 text-text' : 'text-muted')} onClick={() => i < step && setStep(i)}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', i < step ? 'bg-ok' : i === step ? 'bg-accent' : 'bg-border')} />
              {s}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="no-drag" onClick={() => void finish()}>
          Skip setup
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-8 py-6">
        <div className="w-full max-w-[760px]">
          {step === 0 && <Welcome />}
          {step === 1 && <SignIn />}
          {step === 2 && <FirstSpace spaceId={spaceId} onSpace={setSpaceId} />}
          {step === 3 && <Ready spaceId={spaceId} onWorkspace={() => void finish('workspace')} onTour={() => void finish('tour')} onDone={() => void finish()} />}
        </div>
      </div>
      {step < 3 && (
        <div className="flex h-[64px] shrink-0 items-center justify-between border-t border-border px-8">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
            <ArrowLeft size={14} /> Back
          </Button>
          <ContinueButton step={step} spaceId={spaceId} onSpace={setSpaceId} onNext={() => setStep(step + 1)} />
        </div>
      )}
    </div>
  )
}

/** Continue is plain on most steps; on First space it creates the space and adds the repos first. */
function ContinueButton({ step, spaceId, onSpace, onNext }: { step: number; spaceId: string | null; onSpace: (id: string) => void; onNext: () => void }): React.JSX.Element {
  const pending = useApp((s) => s.onboardingDraft)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState(false)
  if (step !== 2) {
    return (
      <Button variant="primary" onClick={onNext}>
        Continue <ArrowRight size={14} />
      </Button>
    )
  }
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      let id = spaceId
      if (!id) {
        const sp = await api.invoke('spaces:create', pending.name || 'Personal')
        id = sp.id
        onSpace(id)
      }
      await api.invoke('spaces:update', id, { name: pending.name || 'Personal', color: pending.color })
      if (pending.root) await api.invoke('settings:update', { workspacesRoot: pending.root })
      const paths = pending.repos.filter((p) => !pending.added.has(p))
      if (paths.length) await api.invoke('repos:addPaths', paths, id)
      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="primary" disabled={busy} onClick={() => void go()}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : null} Continue <ArrowRight size={14} />
    </Button>
  )
}

// ---------- 1. Welcome ----------

const FEATURES = [
  {
    icon: <GitBranch size={16} />,
    title: 'One workspace, many repos',
    text: 'Pick the repositories a feature touches. Sinfonie creates a worktree on the same branch in each, so a full-stack change lives in one place and ships together.',
    art: <ArtRepos />
  },
  {
    icon: <Users size={16} />,
    title: 'A crew from any vendor',
    text: 'The chat model orchestrates. It delegates exploring, implementing, testing and reviewing to a crew you assemble from Claude, Codex, Gemini, Grok, or your own API keys and local models.',
    art: <ArtCrew />
  },
  {
    icon: <Sparkles size={16} />,
    title: 'Review cockpit',
    text: 'Open pull requests across your repos in one list. AI review reads the diff, you approve the findings that matter, and it drafts the reply.',
    art: <ArtReview />
  }
]

function Welcome(): React.JSX.Element {
  const [active, setActive] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % FEATURES.length), 4000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="text-center">
      <img src={logo} alt="" className="mx-auto h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(91,124,255,.25)]" />
      <h1 className="mt-4 text-[26px] font-semibold tracking-tight">Welcome to Sinfonie</h1>
      <p className="mx-auto mt-2 max-w-[520px] text-[14px] text-muted">A desktop home for agent-driven development across several repositories at once. Three things worth knowing before you start.</p>
      <div className="mt-8 grid grid-cols-3 gap-3 text-left">
        {FEATURES.map((f, i) => (
          <button key={f.title} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} className={clsx('flex flex-col rounded-xl border p-4 transition-all duration-300', i === active ? 'border-accent/60 bg-panel shadow-[0_10px_40px_rgba(91,124,255,.12)]' : 'border-border bg-panel/40 hover:border-border')}>
            <div className="flex h-[92px] items-center justify-center">{f.art}</div>
            <div className="mt-3 flex items-center gap-2 text-[13px] font-semibold">
              <span className="text-accent">{f.icon}</span> {f.title}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{f.text}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function ArtRepos(): React.JSX.Element {
  return (
    <div className="relative flex flex-col gap-1.5">
      {['frontend', 'backend', 'infra'].map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <span className="w-[54px] rounded-md border border-border bg-bg px-1.5 py-0.5 text-right text-[10px] text-muted">{n}</span>
          <span className="h-px w-5 bg-accent/60" />
          <span className={clsx('h-2 w-2 rounded-full', i === 1 ? 'bg-accent' : 'bg-accent/60')} />
        </div>
      ))}
      <span className="absolute right-[3px] top-[7px] h-[44px] w-px bg-accent/60" />
      <span className="absolute -right-[64px] top-[22px] rounded-full bg-accent/15 px-1.5 py-px text-[10px] text-accent">feature/login</span>
    </div>
  )
}

function ArtCrew(): React.JSX.Element {
  const nodes = [
    { n: 'explorer', m: 'haiku', x: -66, y: 24 },
    { n: 'implementer', m: 'codex', x: 0, y: 34 },
    { n: 'reviewer', m: 'opus', x: 66, y: 24 }
  ]
  return (
    <div className="relative h-[80px] w-[200px]">
      <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">orchestrator</div>
      {nodes.map((d) => (
        <React.Fragment key={d.n}>
          <span className="absolute left-1/2 top-[18px] h-px w-[70px] origin-left bg-border" style={{ transform: `rotate(${Math.atan2(d.y, d.x || 0.001) * (180 / Math.PI)}deg)`, width: Math.hypot(d.x, d.y) }} />
          <div className="absolute left-1/2 top-[18px] -translate-x-1/2 rounded-md border border-border bg-bg px-1.5 py-0.5 text-center text-[9px] leading-tight" style={{ transform: `translate(${d.x - 24}px, ${d.y}px)` }}>
            <div className="text-text">{d.n}</div>
            <div className="text-muted">{d.m}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function ArtReview(): React.JSX.Element {
  return (
    <div className="w-[180px] rounded-lg border border-border bg-bg p-2 text-[10px]">
      <div className="flex items-center gap-1.5 font-medium">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> #482 Add login flow
      </div>
      {['Missing null check in session', 'Token stored in localStorage', 'Unused import'].map((t, i) => (
        <div key={t} className="mt-1 flex items-center gap-1.5 text-muted">
          <span className={clsx('flex h-3 w-3 items-center justify-center rounded border', i < 2 ? 'border-ok bg-ok/20 text-ok' : 'border-border')}>{i < 2 && <Check size={8} />}</span>
          <span className="truncate">{t}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- 2. Sign in ----------

function SignIn(): React.JSX.Element {
  const { settings, setError } = useApp()
  const [login, setLogin] = useState<{ id: string; name: string; vendor: string } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [geminiKey, setGeminiKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const google = settings.providers?.find((p) => p.kind === 'google')
  const idFor = (v: Vendor): string => (v === 'anthropic' ? settings.defaultClaudeAccountId : (settings.defaultAccounts?.[v] ?? `${v}-default`))
  const check = async (id: string): Promise<void> => {
    setChecking(id)
    try {
      await api.invoke('accounts:check', id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setChecking(null)
  }
  // Check every vendor once on arrival so the badges reflect existing CLI logins.
  useEffect(() => {
    for (const v of VENDORS) {
      const acc = settings.claudeAccounts.find((a) => a.id === idFor(v.id))
      if (acc && acc.loggedIn === undefined) void api.invoke('accounts:check', acc.id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const saveKey = async (): Promise<void> => {
    setSavingKey(true)
    try {
      const p = google ? await api.invoke('providers:update', google.id, { apiKey: geminiKey.trim() }) : await api.invoke('providers:add', { kind: 'google', name: 'Google Gemini', apiKey: geminiKey.trim() })
      await api.invoke('providers:models', p.id).catch(() => undefined)
      setGeminiKey('')
      await check(idFor('google'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSavingKey(false)
  }
  const signedIn = settings.claudeAccounts.filter((a) => a.loggedIn).length
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-tight">Sign in to the agents you use</h2>
      <p className="mt-1 text-[13px] text-muted">
        One is enough to start. Claude is the recommended first. Each uses the vendor’s own login, so your subscription applies. You can add more accounts per vendor later under Settings → Accounts.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        {VENDORS.map((v) => {
          const acc = settings.claudeAccounts.find((a) => a.id === idFor(v.id))
          const ok = acc?.loggedIn === true
          return (
            <div key={v.id} className={clsx('rounded-xl border px-4 py-3', ok ? 'border-ok/40 bg-ok/5' : 'border-border bg-panel/40')}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    {v.label} <span className="font-normal text-muted">· {v.agent}</span>
                    {v.id === 'anthropic' && !ok && <Badge tone="accent">recommended</Badge>}
                    {ok && (
                      <Badge tone="ok">
                        <CheckCircle2 size={10} className="mr-1 inline" />
                        signed in
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] text-muted">{ok && acc?.detail ? acc.detail : v.hint}</div>
                </div>
                {acc && (
                  <Button size="sm" variant="ghost" onClick={() => void check(acc.id)} disabled={checking === acc.id} title="Ask the CLI whether this account is signed in">
                    <RefreshCw size={12} className={checking === acc.id ? 'animate-spin' : ''} />
                  </Button>
                )}
                {acc && v.id !== 'google' && (
                  <Button size="sm" variant={ok ? 'subtle' : 'primary'} onClick={() => setLogin({ id: acc.id, name: acc.name, vendor: v.label })}>
                    <LogIn size={12} /> {ok ? 'Sign in again' : 'Sign in'}
                  </Button>
                )}
              </div>
              {v.id === 'google' && !ok && (
                <div className="mt-2 flex items-center gap-2">
                  <input className={inputCls} type="password" placeholder={google?.hasKey ? 'Gemini API key is set; paste a new one to replace it' : 'Gemini API key from aistudio.google.com'} value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && geminiKey.trim() && void saveKey()} />
                  <Button size="sm" variant="primary" disabled={!geminiKey.trim() || savingKey} onClick={() => void saveKey()}>
                    {savingKey ? <Loader2 size={12} className="animate-spin" /> : null} Save
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[12px] text-muted">{signedIn === 0 ? 'Nothing signed in yet. You can continue and sign in later, but chats will not run until you do.' : `${signedIn} account${signedIn === 1 ? '' : 's'} ready.`}</p>
      {login && (
        <LoginDialog
          accountId={login.id}
          vendorLabel={login.vendor}
          accountName={login.name}
          onClose={() => {
            setLogin(null)
            void check(login.id)
          }}
        />
      )}
    </div>
  )
}

// ---------- 3. First space ----------

function FirstSpace({ spaceId, onSpace }: { spaceId: string | null; onSpace: (id: string) => void }): React.JSX.Element {
  const { settings, spaces, setOnboardingDraft } = useApp()
  const draft = useApp((s) => s.onboardingDraft)
  const [scanRoot, setScanRoot] = useState<string | null>(null)
  const [scan, setScan] = useState<ScannedRepo[] | null>(null)
  const [scanning, setScanning] = useState(false)
  void spaceId
  void onSpace
  const existing = spaces[0]
  useEffect(() => {
    if (existing && !draft.name) setOnboardingDraft({ name: existing.name, color: existing.color })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const runScan = async (root: string): Promise<void> => {
    setScanning(true)
    setScanRoot(root)
    try {
      const r = await api.invoke('repos:scan', root)
      setScan(r)
      setOnboardingDraft({ added: new Set(r.filter((x) => x.added).map((x) => x.path)) })
    } finally {
      setScanning(false)
    }
  }
  useEffect(() => {
    // Try the usual place first; fall back to the home folder.
    void (async () => {
      setScanning(true)
      const first = await api.invoke('repos:scan', '~/repos').catch(() => [] as ScannedRepo[])
      if (first.length) {
        setScanRoot('~/repos')
        setScan(first)
        setOnboardingDraft({ added: new Set(first.filter((x) => x.added).map((x) => x.path)) })
        setScanning(false)
      } else await runScan('~')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const browse = async (): Promise<void> => {
    const p = await api.invoke('dialog:pickFolder', 'Where do your repositories live?')
    if (p) await runScan(p)
  }
  const toggle = (path: string): void => setOnboardingDraft({ repos: draft.repos.includes(path) ? draft.repos.filter((p) => p !== path) : [...draft.repos, path] })
  const root = draft.root || settings.workspacesRoot
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-tight">Your first space</h2>
      <p className="mt-1 text-[13px] text-muted">A space groups repositories, workspaces and settings: personal projects, work, a client. Start with one; add more from the dots at the bottom of the sidebar.</p>
      <div className="mt-5 grid grid-cols-[1fr_auto] items-end gap-4">
        <label className="block">
          <span className="mb-1 block text-[12px] text-muted">Name</span>
          <input className={inputCls} value={draft.name} placeholder="Personal" onChange={(e) => setOnboardingDraft({ name: e.target.value })} />
        </label>
        <div>
          <span className="mb-1 block text-[12px] text-muted">Color</span>
          <div className="flex gap-1.5">
            {SPACE_COLORS.map((c) => (
              <button key={c} className={clsx('h-6 w-6 rounded-full border-2 transition-transform', draft.color === c ? 'scale-110 border-text' : 'border-transparent hover:scale-110')} style={{ background: c }} onClick={() => setOnboardingDraft({ color: c })} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4">
        <span className="mb-1 block text-[12px] text-muted">Where Sinfonie creates workspaces (one folder per workspace, with a worktree per repo)</span>
        <button className="flex w-full items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-left text-[13px] hover:border-accent" onClick={() => void api.invoke('dialog:pickFolder', 'Workspaces folder', root).then((p) => p && setOnboardingDraft({ root: p }))}>
          <FolderOpen size={14} className="text-muted" /> {shortPath(root)}
        </button>
      </div>
      <div className="mt-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px] text-muted">Repositories for this space. Pick the ones a feature usually touches together.</span>
          <span className="ml-auto text-[11px] text-muted">{scanRoot ? `Looking in ${shortPath(scanRoot)}` : ''}</span>
          <Button size="sm" variant="ghost" onClick={() => void browse()}>
            <FolderOpen size={12} /> Browse…
          </Button>
        </div>
        <div className="max-h-[220px] overflow-auto rounded-lg border border-border">
          {scanning && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> Scanning for git repositories…
            </div>
          )}
          {!scanning && scan && scan.length === 0 && <div className="px-3 py-3 text-[12px] text-muted">No git repositories here. Browse to the folder that holds them, or skip and add repos later.</div>}
          {!scanning &&
            scan?.map((r) => {
              const on = r.added || draft.repos.includes(r.path)
              return (
                <label key={r.path} className={clsx('flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0', on ? 'bg-accent/5' : 'hover:bg-panel')}>
                  <input type="checkbox" checked={on} disabled={r.added} onChange={() => toggle(r.path)} />
                  <span className="text-[13px] font-medium">{r.name}</span>
                  <span className="truncate text-[11px] text-muted">{shortPath(r.path)}</span>
                  {r.added && <Badge tone="ok">already added</Badge>}
                </label>
              )
            })}
        </div>
        <p className="mt-1 text-[11px] text-muted">{draft.repos.length ? `${draft.repos.length} selected` : 'Nothing selected yet. Two or more is where Sinfonie shines.'}</p>
      </div>
    </div>
  )
}

// ---------- 4. Ready ----------

function Ready({ spaceId, onWorkspace, onTour, onDone }: { spaceId: string | null; onWorkspace: () => void; onTour: () => void; onDone: () => void }): React.JSX.Element {
  const { settings, spaces, repos } = useApp()
  const space = spaces.find((s) => s.id === spaceId)
  const mine = useMemo(() => repos.filter((r) => r.spaceId === spaceId), [repos, spaceId])
  const signedIn = settings.claudeAccounts.filter((a) => a.loggedIn)
  const rows = [
    { ok: signedIn.length > 0, text: signedIn.length ? `Signed in: ${signedIn.map((a) => VENDORS.find((v) => v.id === (a.vendor ?? 'anthropic'))?.agent).join(', ')}` : 'No account signed in yet (Settings → Accounts)' },
    { ok: Boolean(space), text: space ? `Space “${space.name}” created` : 'No space yet' },
    { ok: mine.length > 0, text: mine.length ? `${mine.length} repositor${mine.length === 1 ? 'y' : 'ies'}: ${mine.map((r) => r.name).join(', ')}` : 'No repositories yet (space settings → Repositories)' }
  ]
  return (
    <div className="text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ok/15 text-ok">
        <Check size={28} />
      </div>
      <h2 className="mt-4 text-[22px] font-semibold tracking-tight">You’re set</h2>
      <div className="mx-auto mt-4 max-w-[460px] text-left">
        {rows.map((r) => (
          <div key={r.text} className="flex items-center gap-2 py-1 text-[13px]">
            {r.ok ? <CheckCircle2 size={15} className="shrink-0 text-ok" /> : <span className="h-[15px] w-[15px] shrink-0 rounded-full border border-border" />}
            <span className={r.ok ? '' : 'text-muted'}>{r.text}</span>
          </div>
        ))}
      </div>
      <p className="mx-auto mt-4 max-w-[460px] text-[13px] text-muted">A workspace is one branch across the repos you pick. Create the first one now, or take a two-minute tour of the app.</p>
      <div className="mt-6 flex items-center justify-center gap-2">
        <Button variant="primary" onClick={onWorkspace}>
          Create your first workspace
        </Button>
        <Button onClick={onTour}>Take the tour</Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  )
}
