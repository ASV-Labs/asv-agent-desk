import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// The terminal effect owns an external PTY process. React StrictMode's
// development-only setup/cleanup/setup cycle would create it twice.
createRoot(document.getElementById('root')!).render(<App />)
