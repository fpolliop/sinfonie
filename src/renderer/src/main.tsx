import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { installCrashReporting, report } from './lib/crash'

// Errors that escape React — thrown from an IPC callback or a promise, where React #185 (an update
// loop) lands — are reported by the page itself, with its stack and screen.
installCrashReporting()

// Render errors reach the crash report with the component stack, so an error like React #185
// names the component instead of only the minified message.
ReactDOM.createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => report('render', error, info.componentStack),
  onCaughtError: (error, info) => report('render', error, info.componentStack)
}).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)

// Development only: flag expert words that reach the screen in guided mode.
if (import.meta.env.DEV) void import('./lib/guidedLint').then((m) => m.startGuidedLint())
