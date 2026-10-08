import Provider from '@/components/Form/modelForm/Provider.tsx'
import { Navigate, Outlet, useLocation } from 'react-router-dom'

const Model = () => {
  const { pathname } = useLocation()
  if (pathname.replace(/\/$/, '') === '/settings/model/groq') return <Navigate to="/settings/transcriber" replace />
  return (
    <>{pathname.replace(/\/$/, '') === '/settings/model' ? <Provider /> : <Outlet />}</>
  )
}
export default Model
