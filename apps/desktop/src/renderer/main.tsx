import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/bricolage-grotesque/800.css'
import '@studio/ui/tokens.css'
import './app.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installAppZoom } from './appZoom'
import './drafts'

// Before anything else listens: its keys work while typing too, and win over the page's own.
installAppZoom()
// The system, for what differs by it in the CSS (a Mac's traffic lights in the title bar).
document.documentElement.dataset.platform = window.studio.platform
createRoot(document.getElementById('root')!).render(<App />)
