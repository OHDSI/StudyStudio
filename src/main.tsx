import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installNetworkGuard } from '@/lib/security/networkGuard'
import App from './App'
import './index.css'

if (import.meta.env.PROD) installNetworkGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
