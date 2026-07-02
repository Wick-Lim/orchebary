import './assets/main.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// xterm measures glyph metrics at Terminal construction — make sure the
// bundled Nerd Font is ready before anything renders a terminal.
// No StrictMode: xterm instances are imperative, registry-owned resources.
void document.fonts
  .load('13px "JetBrainsMono Nerd Font"')
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById('root')!).render(<App />)
  })
