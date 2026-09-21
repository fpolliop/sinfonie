/**
 * Sinfonie's implementations of the view catalog, for json-render. They follow the app's look
 * (panel, border, muted, accent) so a generated view reads as part of the app.
 */
import React from 'react'
import clsx from 'clsx'
import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'
import { defineRegistry, type ComponentRenderProps } from '@json-render/react'
import {
  Activity, AlertTriangle, ArrowRight, Bell, Check, Clock, Database, ExternalLink, Eye, Folder, Gauge, GitBranch, GitMerge, GitPullRequest,
  Kanban, LayoutDashboard, MessageSquare, Play, Plus, RefreshCw, Sun, Ticket, Upload, Wand2, Wrench, X, type LucideIcon
} from 'lucide-react'
import { COMPONENTS } from '@shared/views/catalog'

export const ICONS: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard, sun: Sun, 'git-branch': GitBranch, 'git-pull-request': GitPullRequest, 'git-merge': GitMerge, kanban: Kanban, ticket: Ticket, bell: Bell,
  'alert-triangle': AlertTriangle, check: Check, x: X, play: Play, upload: Upload, 'refresh-cw': RefreshCw, 'external-link': ExternalLink, wand: Wand2, wrench: Wrench,
  'message-square': MessageSquare, folder: Folder, eye: Eye, gauge: Gauge, clock: Clock, plus: Plus, 'arrow-right': ArrowRight, database: Database, activity: Activity
}
export function ViewIcon({ name, size = 13, className }: { name?: string; size?: number; className?: string }): React.JSX.Element | null {
  const I = name ? ICONS[name] : undefined
  return I ? <I size={size} className={className} /> : null
}

const TONE_TEXT: Record<string, string> = { default: 'text-text', muted: 'text-muted', accent: 'text-accent', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' }
const TONE_BADGE: Record<string, string> = {
  default: 'bg-panel-2 text-text',
  muted: 'bg-panel-2 text-muted',
  accent: 'bg-accent/15 text-accent',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger'
}
const TONE_BORDER: Record<string, string> = { default: 'border-border', muted: 'border-border', accent: 'border-accent/40', ok: 'border-ok/40', warn: 'border-warn/40', danger: 'border-danger/40' }
const GAP: Record<string, string> = { none: 'gap-0', xs: 'gap-1', sm: 'gap-2', md: 'gap-3', lg: 'gap-5' }

const STATUS: Record<string, { cls: string; label: string }> = {
  success: { cls: 'bg-ok', label: 'Passing' },
  failure: { cls: 'bg-danger', label: 'Failing' },
  error: { cls: 'bg-danger', label: 'Error' },
  pending: { cls: 'bg-warn', label: 'Pending' },
  running: { cls: 'bg-accent animate-pulse', label: 'Running' },
  waiting: { cls: 'bg-warn animate-pulse', label: 'Waiting for you' }
}
export function StatusDot({ status, className }: { status?: string; className?: string }): React.JSX.Element {
  const s = status ? STATUS[status] : undefined
  return <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', s?.cls ?? 'bg-border', className)} title={s?.label} />
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** Only the components; actions come from the host's handlers (they depend on the view's context). */
const componentCatalog = defineCatalog(schema, { components: COMPONENTS, actions: {} })

export const { registry } = defineRegistry(componentCatalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={clsx(
          'flex min-w-0',
          props.direction === 'row' ? 'flex-row' : 'flex-col',
          GAP[props.gap ?? 'sm'],
          props.wrap && 'flex-wrap',
          props.align === 'center' ? 'items-center' : props.align === 'end' ? 'items-end' : props.align === 'start' ? 'items-start' : props.direction === 'row' ? 'items-stretch' : '',
          props.justify === 'between' ? 'justify-between' : props.justify === 'center' ? 'justify-center' : props.justify === 'end' ? 'justify-end' : ''
        )}
      >
        {children}
      </div>
    ),
    Grid: ({ props, children }) => (
      <div className={clsx('grid min-w-0', GAP[props.gap ?? 'md'])} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, max(260px, calc((100% - ${(props.columns - 1) * 12}px) / ${props.columns}))), 1fr))` }}>
        {children}
      </div>
    ),
    Card: ({ props, children }) => (
      <section className={clsx('flex min-w-0 flex-col rounded-lg border bg-panel', TONE_BORDER[props.tone ?? 'default'])} style={props.span ? { gridColumn: `span ${props.span} / span ${props.span}` } : undefined}>
        {(props.title || props.subtitle) && (
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <ViewIcon name={props.icon} className={TONE_TEXT[props.tone && props.tone !== 'default' ? props.tone : 'accent']} />
            <div className="min-w-0">
              {props.title && <div className="truncate text-[12.5px] font-semibold">{props.title}</div>}
              {props.subtitle && <div className="truncate text-[11px] text-muted">{props.subtitle}</div>}
            </div>
          </header>
        )}
        <div className="flex min-w-0 flex-col gap-2 p-3">{children}</div>
      </section>
    ),
    Heading: ({ props }) => {
      const cls = props.level === 3 ? 'text-[13px] font-semibold' : props.level === 2 ? 'text-[15px] font-semibold' : 'text-[19px] font-semibold tracking-tight'
      return <div className={clsx('min-w-0 truncate', cls)}>{str(props.text)}</div>
    },
    Text: ({ props }) => (
      <p
        className={clsx(
          'min-w-0',
          TONE_TEXT[props.tone ?? 'default'],
          props.size === 'xs' ? 'text-[11px]' : props.size === 'sm' ? 'text-[12px]' : props.size === 'lg' ? 'text-[15px]' : 'text-[13px]',
          props.mono && 'font-mono',
          props.truncate && 'truncate'
        )}
      >
        {str(props.text)}
      </p>
    ),
    Badge: ({ props }) => <span className={clsx('inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-px text-[10.5px] font-medium', TONE_BADGE[props.tone ?? 'default'])}>{str(props.label)}</span>,
    Status: ({ props }) => (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <StatusDot status={str(props.status)} />
        {props.label ?? STATUS[str(props.status)]?.label ?? ''}
      </span>
    ),
    Metric: ({ props }) => (
      <div className="flex min-w-0 flex-col">
        <span className="text-[11px] uppercase tracking-wide text-muted">{props.label}</span>
        <span className={clsx('text-[24px] font-semibold tabular-nums leading-tight', TONE_TEXT[props.tone ?? 'default'])}>{str(props.value)}</span>
        {props.hint && <span className="text-[11px] text-muted">{props.hint}</span>}
      </div>
    ),
    Meter: ({ props }) => {
      const v = Math.max(0, Math.min(100, Number(props.value) || 0))
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="truncate">{str(props.label)}</span>
            <span className="shrink-0 tabular-nums text-muted">{Math.round(v)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
            <div className={clsx('h-full rounded-full', v >= 95 ? 'bg-danger' : v >= 80 ? 'bg-warn' : 'bg-accent')} style={{ width: `${v}%` }} />
          </div>
          {props.hint && <span className="text-[11px] text-muted">{props.hint}</span>}
        </div>
      )
    },
    List: ({ props, children }) => {
      const none = React.Children.count(children) === 0
      if (props.count === undefined && none) return <div className="py-3 text-center text-[12px] text-muted">Loading…</div>
      if (props.count === 0 || none) return <div className="py-3 text-center text-[12px] text-muted">{props.emptyText ?? 'Nothing here.'}</div>
      return <div className={clsx('flex min-w-0 flex-col', props.divided ? 'divide-y divide-border' : 'gap-0.5')}>{children}</div>
    },
    ListItem: ({ props, children, on }) => {
      const press = on('press')
      return (
        <div
          role={press.bound ? 'button' : undefined}
          tabIndex={press.bound ? 0 : undefined}
          onClick={press.bound ? () => press.emit() : undefined}
          onKeyDown={press.bound ? (e) => e.key === 'Enter' && press.emit() : undefined}
          className={clsx('group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5', press.bound && 'cursor-pointer hover:bg-panel-2')}
        >
          {props.status !== undefined ? <StatusDot status={str(props.status)} /> : <ViewIcon name={props.icon} className="shrink-0 text-muted" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px]">{str(props.title)}</div>
            {props.subtitle && <div className="truncate text-[11px] text-muted">{str(props.subtitle)}</div>}
          </div>
          {props.meta && <span className="shrink-0 text-[11px] text-muted">{str(props.meta)}</span>}
          {children && (
            <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {children}
            </div>
          )}
        </div>
      )
    },
    Column: ({ props, children }) => (
      <div className="flex min-w-[210px] flex-1 flex-col rounded-lg border border-border bg-panel/60">
        <div className={clsx('flex items-center justify-between border-b border-border px-3 py-2 text-[12px] font-semibold', TONE_TEXT[props.tone ?? 'default'])}>
          <span>{props.title}</span>
          {props.count !== undefined && <span className="rounded-full bg-panel-2 px-1.5 text-[10.5px] tabular-nums text-muted">{props.count}</span>}
        </div>
        <div className="flex min-h-[60px] flex-col gap-2 p-2">{children}</div>
      </div>
    ),
    Tile: ({ props, children, on }) => {
      const press = on('press')
      return (
        <div
          role={press.bound ? 'button' : undefined}
          onClick={press.bound ? () => press.emit() : undefined}
          className={clsx('flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-panel p-2.5', press.bound && 'cursor-pointer hover:border-accent/50')}
        >
          <div className="flex items-start gap-2">
            {props.status !== undefined && <StatusDot status={str(props.status)} className="mt-1" />}
            <div className="min-w-0 flex-1 text-[12.5px] leading-snug">{str(props.title)}</div>
          </div>
          {(props.subtitle || props.meta) && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
              <span className="truncate font-mono">{str(props.subtitle)}</span>
              <span className="truncate">{str(props.meta)}</span>
            </div>
          )}
          {children && (
            <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {children}
            </div>
          )}
        </div>
      )
    },
    Button: ({ props, emit }) => (
      <button
        onClick={(e) => {
          e.stopPropagation()
          emit('press')
        }}
        className={clsx(
          'no-drag inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors',
          props.size === 'sm' ? 'px-2 py-0.5 text-[11.5px]' : 'px-3 py-1.5 text-[12.5px]',
          props.variant === 'primary' ? 'bg-accent-2 text-white hover:bg-accent' : props.variant === 'danger' ? 'bg-danger/15 text-danger hover:bg-danger/25' : props.variant === 'ghost' ? 'text-muted hover:bg-panel-2 hover:text-text' : 'bg-panel-2 text-text hover:bg-border'
        )}
      >
        <ViewIcon name={props.icon} size={12} />
        {str(props.label)}
      </button>
    ),
    Divider: () => <hr className="border-0 border-t border-border" />,
    Empty: ({ props }) => (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
        <ViewIcon name={props.icon} size={20} className="text-muted" />
        <div className="text-[13px] font-medium">{props.text}</div>
        {props.hint && <div className="max-w-md text-[12px] text-muted">{props.hint}</div>}
      </div>
    )
  }
})

/** An element whose type this build does not know (a newer catalog, or a hand-edited spec). */
export function UnknownElement({ element }: ComponentRenderProps): React.JSX.Element {
  return <div className="rounded-md border border-dashed border-warn/50 px-3 py-2 text-[12px] text-warn">This part ({element.type}) needs an update. Ask Maestro to fix the view.</div>
}
