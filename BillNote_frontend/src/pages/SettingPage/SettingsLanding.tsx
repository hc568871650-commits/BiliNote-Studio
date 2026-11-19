import { Navigate } from 'react-router-dom'

export default function SettingsLanding() {
  let destination = '/settings/general'
  try {
    const saved = sessionStorage.getItem('bilinote-last-setting')
    if (saved === '/settings/purposes') destination = '/settings/model'
    else if (saved && /^\/settings\/(general|appearance|model|transcriber|download|monitor|about)(\/[a-zA-Z0-9_-]+)?$/.test(saved)) destination = saved
  } catch { /* Use default section. */ }
  return <Navigate to={destination} replace />
}
