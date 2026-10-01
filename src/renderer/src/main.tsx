import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { RootErrorBoundary, reportRenderError } from './components/RootErrorBoundary'

// Render errors reach the crash report with the component stack, so an error like React #185
// (an update loop) names the component instead of only the minified message.
ReactDOM.createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => reportRenderError('uncaught', error, info.componentStack),
  onCaughtError: (error, info) => reportRenderError('caught', error, info.componentStack)
}).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)

// Development only: flag expert words that reach the screen in guided mode.
if (import.meta.env.DEV) void import('./lib/guidedLint').then((m) => m.startGuidedLint())
