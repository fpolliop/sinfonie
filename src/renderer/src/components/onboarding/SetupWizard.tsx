import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FolderOpen, GitBranch, Loader2, LogIn, RefreshCw, Sparkles, Users, Palette } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Badge, inputCls } from '../ui'
import { LoginDialog } from '../LoginDialog'
import { shortPath } from '@/lib/format'
import logo from '../../assets/logo.svg'
import { SPACE_COLORS, VENDORS, type AppMode, type DiscoveredOrg, type ScannedRepo, type Vendor } from '@shared/types'
import { useGuided } from '@/lib/guided'

const EXPERT_STEPS = ['Welcome', 'Sign in', 'First space', 'Ready'] as const
const GUIDED_STEPS = ['Welcome', 'Sign in', 'Your team', 'Ready'] as const

/**
 * First-run setup: what Sinfonie is, sign in to the vendors you use, make a first space with
 * its repositories, then hand off to the first workspace or the tour. Every step can be skipped.
 */
export function SetupWizard({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const guided = useGuided()
  const STEPS = guided ? GUIDED_STEPS : EXPERT_STEPS
  const { settings, setError, setShowNewWorkspace, setOnboarding, setActiveSpace, setAssistantOpen } = useApp()
  const finish = async (then?: 'workspace' | 'tour' | 'assistant'): Promise<void> => {
    try {
      await api.invoke('settings:update', { onboarding: { ...(settings.onboarding ?? {}), setupDoneAt: new Date().toISOString() } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    onClose()
    if (spaceId) setActiveSpace(spaceId)
    if (then === 'workspace') setShowNewWorkspace(true, spaceId ?? undefined)
    if (then === 'tour') setOnboarding('tour')
    if (then === 'assistant') setAssistantOpen(true)
  }
  // Guided setup is three short screens and nothing works without them, so it cannot be skipped;
  // the sign-in step waits for Claude.
  const claudeReady = settings.claudeAccounts.some((a) => a.id === settings.defaultClaudeAccountId && a.loggedIn)
  const blocked = guided && step === 1 && !claudeReady
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
        {!guided && (
          <Button size="sm" variant="ghost" className="no-drag" onClick={() => void finish()}>
            Skip setup
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-8 py-6">
        <div className="w-full max-w-[760px]">
          {step === 0 && <Welcome />}
          {step === 1 && <SignIn />}
          {step === 2 && (guided ? <JoinTeam onSpace={setSpaceId} /> : <FirstSpace spaceId={spaceId} onSpace={setSpaceId} />)}
          {step === 3 && (guided ? <GuidedReady spaceId={spaceId} onWorkspace={() => void finish('workspace')} onDone={() => void finish()} /> : <Ready spaceId={spaceId} onWorkspace={() => void finish('workspace')} onTour={() => void finish('tour')} onAssistant={() => void finish('assistant')} onDone={() => void finish()} />)}
        </div>
      </div>
      {step < 3 && (
        <div className="flex h-[64px] shrink-0 items-center justify-between border-t border-border px-8">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
            <ArrowLeft size={14} /> Back
          </Button>
          <ContinueButton step={guided && step === 2 ? -1 : step} disabled={blocked} spaceId={spaceId} onSpace={setSpaceId} onNext={() => setStep(step + 1)} />
        </div>
      )}
    </div>
  )
}

/** Continue is plain on most steps; on First space it creates the space and adds the repos first. */
function ContinueButton({ step, spaceId, onSpace, onNext, disabled }: { step: number; spaceId: string | null; onSpace: (id: string) => void; onNext: () => void; disabled?: boolean }): React.JSX.Element {
  const pending = useApp((s) => s.onboardingDraft)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState(false)
  if (step !== 2) {
    return (
      <Button variant="primary" onClick={onNext} disabled={disabled} title={disabled ? 'Sign in to Claude first' : undefined}>
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
    text: 'Open pull requests across your repos in one list. AI review reads the diff, you approve the findings that matter, and it fixes what you approve.',
    art: <ArtReview />
  },
  {
    icon: <Sparkles size={16} />,
    title: 'A setup assistant',
    text: 'Tell it how your team builds, tests and ships. It designs a crew with prompts written for your repos, adds repositories, creates spaces and connects your tools, confirming every change first.',
    art: <ArtAssistant />
  },
  {
    icon: <GitBranch size={16} />,
    title: 'Databases and on-call',
    text: 'A Data tab for Postgres, MySQL, SQLite, MongoDB and BigQuery, read-only by default. An on-call agent that triages Slack alerts against your code and cloud logs and drafts the fix as a PR.',
    art: <ArtData />
  }
]

const GUIDED_FEATURES = [
  { title: 'Describe', text: 'Say what you want to build or change, in your own words. The assistant finds the right apps and gets to work.' },
  { title: 'Preview', text: 'Watch the result in the Preview tab while it is being built, on your Mac, before anyone else sees it.' },
  { title: 'Send for review', text: 'When it looks right, send it. It is checked and reviewed first, then a colleague approves and it goes live.' }
]

function Welcome(): React.JSX.Element {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const mode = useApp((s) => s.settings.mode ?? 'expert')
  const setError = useApp((s) => s.setError)
  const guided = mode === 'guided'
  // Cycle the expert showcase until the user points at a card, then hold on their choice.
  useEffect(() => {
    if (guided || paused) return
    const t = setInterval(() => setActive((a) => (a + 1) % FEATURES.length), 4000)
    return () => clearInterval(t)
  }, [guided, paused])
  const choose = (m: AppMode): void => {
    api.invoke('settings:update', { mode: m }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className="text-center">
      <img src={logo} alt="" className="mx-auto h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(91,124,255,.25)]" />
      <h1 className="mt-4 text-[26px] font-semibold tracking-tight">Welcome to Sinfonie</h1>
      <p className="mx-auto mt-2 max-w-[520px] text-[14px] text-muted">First, how do you work? This sets up the app for you; you can change it any time in Settings.</p>
      <div className="mx-auto mt-5 grid max-w-[560px] grid-cols-2 gap-3 text-left">
        {(
          [
            { id: 'expert', title: 'I write code', text: 'Repositories, branches, terminals, diffs, pull requests: the whole toolbox.' },
            { id: 'guided', title: 'I build with AI, I don’t write code', text: 'Describe what you want, watch the preview, send it for review. No code, no commands.' }
          ] as { id: AppMode; title: string; text: string }[]
        ).map((o) => (
          <button key={o.id} onClick={() => choose(o.id)} className={clsx('rounded-xl border p-4 text-left transition-colors', mode === o.id ? 'border-accent bg-panel shadow-[0_10px_40px_rgba(91,124,255,.12)]' : 'border-border bg-panel/40 hover:border-accent/50')}>
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <span className={clsx('h-3 w-3 rounded-full border', mode === o.id ? 'border-accent bg-accent' : 'border-border')} /> {o.title}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{o.text}</p>
          </button>
        ))}
      </div>
      {guided ? (
        <div className="mt-8 grid grid-cols-3 gap-3 text-left">
          {GUIDED_FEATURES.map((f, i) => (
            <div key={f.title} className="flex flex-col rounded-xl border border-border bg-panel/40 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-[11px] text-accent">{i + 1}</span> {f.title}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{f.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mx-auto mt-6 max-w-[680px] rounded-xl border border-border bg-panel/40 p-4 text-left">
          <div className="flex items-center gap-5">
            <div className="flex h-[96px] w-[260px] shrink-0 items-center justify-center overflow-hidden">{FEATURES[active].art}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="text-accent">{FEATURES[active].icon}</span> {FEATURES[active].title}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{FEATURES[active].text}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FEATURES.map((f, i) => (
              <button key={f.title} onClick={() => (setPaused(true), setActive(i))} onMouseEnter={() => (setPaused(true), setActive(i))} className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors', i === active ? 'border-accent/60 bg-accent/10 text-text' : 'border-border text-muted hover:text-text')}>
                {f.icon} {f.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const SVG_TEXT = { fontFamily: 'inherit', fontSize: 10 } as const

function Pill({ x, y, w, label, sub, accent }: { x: number; y: number; w: number; label: string; sub?: string; accent?: boolean }): React.JSX.Element {
  const h = sub ? 30 : 22
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={accent ? 'rgba(124,156,255,.12)' : 'var(--color-bg)'} stroke={accent ? 'rgba(124,156,255,.6)' : 'var(--color-border)'} />
      <text x={x + w / 2} y={y + (sub ? 12 : 15)} textAnchor="middle" fill={accent ? 'var(--color-accent)' : 'var(--color-text)'} style={SVG_TEXT} fontWeight={accent ? 600 : 500}>
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + 24} textAnchor="middle" fill="var(--color-muted)" style={{ ...SVG_TEXT, fontSize: 9 }}>
          {sub}
        </text>
      )}
    </g>
  )
}

/** Three repos joined into one branch. */
function ArtRepos(): React.JSX.Element {
  const rows = [
    { n: 'frontend', y: 4 },
    { n: 'backend', y: 34 },
    { n: 'infra', y: 64 }
  ]
  return (
    <svg width={240} height={90} viewBox="0 0 240 90" aria-hidden>
      {rows.map((r) => (
        <g key={r.n}>
          <Pill x={8} y={r.y} w={70} label={r.n} />
          <path d={`M78 ${r.y + 11} C 110 ${r.y + 11}, 110 45, 138 45`} fill="none" stroke="rgba(124,156,255,.55)" strokeWidth={1.2} />
        </g>
      ))}
      <circle cx={140} cy={45} r={5} fill="var(--color-accent)" />
      <line x1={145} y1={45} x2={156} y2={45} stroke="rgba(124,156,255,.55)" strokeWidth={1.2} />
      <Pill x={156} y={34} w={80} label="feature/login" accent />
    </svg>
  )
}

/** An orchestrator delegating to three crew members on different vendors. */
function ArtCrew(): React.JSX.Element {
  const kids = [
    { n: 'explorer', m: 'haiku', x: 6 },
    { n: 'implementer', m: 'codex', x: 84 },
    { n: 'reviewer', m: 'opus', x: 162 }
  ]
  return (
    <svg width={240} height={90} viewBox="0 0 240 90" aria-hidden>
      {kids.map((k) => (
        <line key={k.n} x1={120} y1={24} x2={k.x + 36} y2={58} stroke="var(--color-border)" strokeWidth={1.2} />
      ))}
      <Pill x={78} y={2} w={84} label="orchestrator" accent />
      {kids.map((k) => (
        <Pill key={k.n} x={k.x} y={58} w={72} label={k.n} sub={k.m} />
      ))}
    </svg>
  )
}

function ArtAssistant(): React.JSX.Element {
  return (
    <div className="w-[190px] rounded-lg border border-border bg-bg p-2 text-[10px]">
      <div className="ml-auto w-[80%] rounded-md bg-accent/15 px-2 py-1">Set up my crew</div>
      <div className="mt-1 w-[88%] rounded-md bg-panel px-2 py-1 text-muted">How do you test? Unit and e2e, or just unit?</div>
      <div className="mt-1 flex gap-1">
        {['Unit', 'Unit + e2e', 'Other'].map((o, i) => (
          <span key={o} className={clsx('rounded border px-1 py-px', i === 1 ? 'border-accent/60 text-accent' : 'border-border text-muted')}>
            {o}
          </span>
        ))}
      </div>
      <div className="mt-1 w-[88%] rounded-md bg-panel px-2 py-1 text-muted">Proposed: explorer (haiku), implementer (sonnet), tester (haiku), reviewer (opus). Save?</div>
    </div>
  )
}

function ArtData(): React.JSX.Element {
  return (
    <div className="w-[190px] rounded-lg border border-border bg-bg p-2 font-mono text-[9px]">
      <div className="text-muted">SELECT id, email FROM users LIMIT 3</div>
      <div className="mt-1 grid grid-cols-[28px_1fr] gap-x-1 border-t border-border pt-1">
        {[
          ['1', 'ada@x.io'],
          ['2', 'linus@x.io'],
          ['3', 'grace@x.io']
        ].map(([a, b]) => (
          <React.Fragment key={a}>
            <span className="text-muted">{a}</span>
            <span>{b}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1 border-t border-border pt-1 text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> #on-call: ETIMEDOUT worker → draft PR ready
      </div>
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
  const guided = useGuided()
  const vendors = guided ? VENDORS.filter((v) => v.id === 'anthropic') : VENDORS
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-tight">{guided ? 'Sign in to Claude' : 'Sign in to the agents you use'}</h2>
      <p className="mt-1 text-[13px] text-muted">
        {guided
          ? 'The assistant runs on your Claude account. Sign in with the account your team uses; a browser window opens and comes back here.'
          : 'One is enough to start, and the first one you sign in to becomes the default engine for chats. Each uses the vendor’s own login, so your subscription applies. You can add more accounts per vendor later under Settings → Accounts, and change the engine under Settings → General.'}
      </p>
      <div className="mt-5 flex flex-col gap-2">
        {vendors.map((v) => {
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
      <p className="mt-3 text-[12px] text-muted">{signedIn === 0 ? (guided ? 'Not signed in yet. Continue lights up once Claude is signed in.' : 'Nothing signed in yet. You can continue and sign in later, but chats will not run until you do.') : guided ? 'Signed in. Continue to join your team.' : `${signedIn} account${signedIn === 1 ? '' : 's'} ready.`}</p>
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
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (scan ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
  }, [scan, filter])
  const groups = useMemo(() => {
    const m = new Map<string, ScannedRepo[]>()
    for (const r of filtered) {
      const dir = r.path.slice(0, r.path.lastIndexOf('/')) || '/'
      m.set(dir, [...(m.get(dir) ?? []), r])
    }
    return Array.from(m.entries())
  }, [filtered])
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
      // The usual places first, home last: a home scan can list hundreds of repos.
      for (const root of ['~/repos', '~/code', '~/dev', '~/projects', '~/src', '~/workspace', '~/Developer']) {
        const found = await api.invoke('repos:scan', root).catch(() => [] as ScannedRepo[])
        if (found.length) {
          setScanRoot(root)
          setScan(found)
          setOnboardingDraft({ added: new Set(found.filter((x) => x.added).map((x) => x.path)) })
          setScanning(false)
          return
        }
      }
      await runScan('~')
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
          <span className="mb-1 block text-[12px] text-muted">Space name (you can rename it later by double-clicking it in the sidebar)</span>
          <input className={inputCls} value={draft.name} placeholder="e.g. Personal, Work, a client" autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setOnboardingDraft({ name: e.target.value })} />
        </label>
        <div>
          <span className="mb-1 block text-[12px] text-muted">Color</span>
          <div className="grid grid-cols-8 gap-1.5">
            {SPACE_COLORS.map((c) => (
              <button key={c} type="button" title={c} aria-pressed={draft.color === c} className={clsx('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-bg transition-shadow', draft.color === c ? 'ring-2 ring-text' : 'hover:ring-2 hover:ring-border')} style={{ background: c }} onClick={() => setOnboardingDraft({ color: c })}>
                {draft.color === c && <Check size={13} className="text-black/70" />}
              </button>
            ))}
            <label title="Custom colour" className="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-dashed border-border text-muted hover:border-text">
              <Palette size={12} />
              <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={draft.color} onChange={(e) => setOnboardingDraft({ color: e.target.value })} />
            </label>
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
          <span className="ml-auto truncate text-[11px] text-muted">{scanRoot ? `${filtered.length}${scan && filtered.length !== scan.length ? ` of ${scan.length}` : ''} in ${shortPath(scanRoot)}` : ''}</span>
          <Button size="sm" variant="ghost" onClick={() => void browse()}>
            <FolderOpen size={12} /> Browse…
          </Button>
        </div>
        <input className={clsx(inputCls, 'mb-1.5')} placeholder="Filter by name or folder…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-[240px] overflow-auto rounded-lg border border-border">
          {scanning && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> Scanning for git repositories…
            </div>
          )}
          {!scanning && scan && scan.length === 0 && <div className="px-3 py-3 text-[12px] text-muted">No git repositories here. Browse to the folder that holds them, or skip and add repos later.</div>}
          {!scanning && scan && scan.length > 0 && filtered.length === 0 && <div className="px-3 py-3 text-[12px] text-muted">Nothing matches "{filter}".</div>}
          {!scanning &&
            groups.map(([dir, list]) => (
              <div key={dir}>
                <div className="sticky top-0 border-b border-border bg-panel px-3 py-1 text-[11px] text-muted">{shortPath(dir)}</div>
                {list.map((r) => {
                  const on = r.added || draft.repos.includes(r.path)
                  return (
                    <button
                      key={r.path}
                      type="button"
                      disabled={r.added}
                      onClick={() => toggle(r.path)}
                      className={clsx('flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 disabled:cursor-default', on ? 'bg-accent/10' : 'hover:bg-panel')}
                    >
                      <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-border')}>{on && <Check size={11} />}</span>
                      <span className="text-[13px] font-medium">{r.name}</span>
                      {r.added && <Badge tone="ok">already added</Badge>}
                    </button>
                  )
                })}
              </div>
            ))}
        </div>
        <p className="mt-1 flex items-center gap-2 text-[11px] text-muted">
          {draft.repos.length ? `${draft.repos.length} selected` : 'Nothing selected yet. Two or more is where Sinfonie shines.'}
          {draft.repos.length > 0 && (
            <button className="text-accent hover:underline" onClick={() => setOnboardingDraft({ repos: [] })}>
              Clear
            </button>
          )}
        </p>
      </div>
    </div>
  )
}

// ---------- 4. Ready ----------

function Ready({ spaceId, onWorkspace, onTour, onAssistant, onDone }: { spaceId: string | null; onWorkspace: () => void; onTour: () => void; onAssistant: () => void; onDone: () => void }): React.JSX.Element {
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
      <p className="mx-auto mt-4 max-w-[460px] text-[13px] text-muted">A workspace is one branch across the repos you pick. Create the first one now, let the assistant design your crew and connect your tools, or take a two-minute tour of the app.</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={onWorkspace}>
          Create your first workspace
        </Button>
        <Button onClick={onAssistant}>
          <Sparkles size={13} /> Set up with the assistant
        </Button>
        <Button onClick={onTour}>Take the tour</Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  )
}

// ---------- 3 (guided). Your team ----------

/**
 * Sinfonie sign-in with the work email, then the organisation that claimed that domain: join it, and its
 * shared spaces (the team's apps) arrive on this Mac by themselves.
 */
function JoinTeam({ onSpace }: { onSpace: (id: string) => void }): React.JSX.Element {
  const cloud = useApp((s) => s.settings.cloud)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredOrg[] | null>(null)
  const [shared, setShared] = useState<Record<string, number>>({})
  const account = cloud?.account
  const orgs = useMemo(() => account?.orgs ?? [], [account])
  const teamSpaces = useMemo(() => spaces.filter((sp) => sp.orgId && orgs.some((o) => o.id === sp.orgId)), [spaces, orgs])
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    if (!account) return
    api.invoke('cloud:discover').then(setDiscovered).catch(() => setDiscovered([]))
    api
      .invoke('cloud:orgs')
      .then((list) => setShared(Object.fromEntries(list.map((o) => [o.id, o.sharedSpaces]))))
      .catch(() => undefined)
  }, [account])
  useEffect(() => {
    if (teamSpaces[0]) onSpace(teamSpaces[0].id)
  }, [teamSpaces, onSpace])
  const countOf = (orgId: string): number => teamSpaces.filter((sp) => sp.orgId === orgId).length
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-tight">Your team</h2>
      <p className="mt-1 text-[13px] text-muted">Sign in with your work email. Your team's apps are set up for you once you are in.</p>
      {!account ? (
        <div className="mt-5 flex flex-col gap-2">
          <div className="rounded-xl border border-border bg-panel/40 px-4 py-3">
            <div className="text-[13px] font-semibold">Sign in to Sinfonie</div>
            <div className="mt-1 text-[11px] text-muted">Use the account that has your work email. A browser window opens and comes back here.</div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => void run('gh', () => api.invoke('cloud:signIn', 'github'))}>
                <LogIn size={12} /> Sign in with GitHub
              </Button>
              <Button variant="primary" disabled={busy !== null} onClick={() => void run('google', () => api.invoke('cloud:signIn', 'google'))}>
                <LogIn size={12} /> Sign in with Google
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-2">
          <div className="rounded-xl border border-ok/40 bg-ok/5 px-4 py-3 text-[13px]">
            <CheckCircle2 size={14} className="mr-1 inline text-ok" /> Signed in as {account.user.name || account.user.login}
            {account.emails?.length ? <span className="text-muted"> · {account.emails.map((e) => e.email).join(', ')}</span> : null}
          </div>
          {orgs.map((o) => (
            <div key={o.id} className="rounded-xl border border-ok/40 bg-ok/5 px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <Users size={14} className="text-ok" /> {o.name}
                <Badge tone="ok">joined</Badge>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {countOf(o.id)
                  ? `${countOf(o.id)} team space${countOf(o.id) === 1 ? '' : 's'} ready: ${teamSpaces
                      .filter((sp) => sp.orgId === o.id)
                      .map((sp) => sp.name)
                      .join(', ')}`
                  : shared[o.id] === 0
                    ? 'This team has not shared its apps yet. Ask whoever set up Sinfonie for your team to share a space with you.'
                    : 'Setting up the team’s apps… this can take a minute the first time.'}
              </div>
            </div>
          ))}
          {(discovered ?? [])
            .filter((d) => !orgs.some((o) => o.id === d.id))
            .map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-xl border border-border bg-panel/40 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{d.name}</div>
                  <div className="text-[11px] text-muted">Your {d.domain} email matches this team.</div>
                </div>
                {d.requested ? (
                  <Badge tone="warn">waiting for an admin</Badge>
                ) : d.domainJoin === 'off' ? (
                  <span className="text-[11px] text-muted">Ask an admin for an invite link</span>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void run(`join:${d.id}`, () => api.invoke('cloud:joinOrg', d.id))}>
                    {d.domainJoin === 'open' ? 'Join' : 'Ask to join'}
                  </Button>
                )}
              </div>
            ))}
          {discovered && discovered.length === 0 && orgs.length === 0 && (
            <p className="text-[12px] text-muted">No team has claimed your email's domain yet. Ask whoever set up Sinfonie for your team for an invite link, then paste it under Settings → Plan.</p>
          )}
        </div>
      )}
    </div>
  )
}

function GuidedReady({ spaceId, onWorkspace, onDone }: { spaceId: string | null; onWorkspace: () => void; onDone: () => void }): React.JSX.Element {
  const { settings, spaces, repos } = useApp()
  const orgs = settings.cloud?.account?.orgs ?? []
  const teamSpaces = spaces.filter((sp) => sp.orgId && orgs.some((o) => o.id === sp.orgId))
  const apps = repos.filter((r) => teamSpaces.some((sp) => sp.id === r.spaceId))
  const claude = settings.claudeAccounts.some((a) => a.loggedIn)
  const rows = [
    { ok: claude, text: claude ? 'Signed in to Claude' : 'Not signed in to Claude yet' },
    { ok: orgs.length > 0, text: orgs.length ? `In the team: ${orgs.map((o) => o.name).join(', ')}` : 'Not in a team yet' },
    { ok: apps.length > 0, text: apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} ready: ${apps.map((r) => r.name).join(', ')}` : 'The team’s apps are still being set up' }
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
      <p className="mx-auto mt-4 max-w-[460px] text-[13px] text-muted">A task is one thing you want built or changed. Describe it, watch the preview, send it for review.</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={onWorkspace} disabled={!spaceId}>
          Start your first task
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  )
}
