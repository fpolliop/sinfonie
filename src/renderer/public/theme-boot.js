// Runs before the app's stylesheet paints: the last theme drawn (lib/useTheme.ts saves it), so a light start never
// flashes dark. Kept tiny and dependency-free; the app takes over once settings load.
try {
  var t = localStorage.getItem('sinfonie.theme')
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t)
    document.documentElement.style.colorScheme = t
    document.documentElement.style.background = t === 'light' ? '#f6f5f2' : '#0f1115'
  }
} catch (e) {
  /* storage unavailable */
}
