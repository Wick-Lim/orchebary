import './assets/main.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// No StrictMode: xterm instances are imperative, registry-owned resources;
// double-invoked effects buy nothing here and complicate attach/detach.
createRoot(document.getElementById('root')!).render(<App />)
