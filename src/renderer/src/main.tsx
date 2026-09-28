import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Development only: flag expert words that reach the screen in guided mode.
if (import.meta.env.DEV) void import('./lib/guidedLint').then((m) => m.startGuidedLint())
