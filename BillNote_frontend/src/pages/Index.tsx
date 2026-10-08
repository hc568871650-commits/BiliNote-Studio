import { Outlet, useLocation } from 'react-router-dom'
import { HomePage } from '@/pages/HomePage/Home'

const Index = () => {
  const location = useLocation()
  const working = location.pathname === '/'
  return (
    <>
      <div style={{ display: working ? 'block' : 'none' }} aria-hidden={!working}><HomePage /></div>
      <Outlet />
    </>
  )
}
export default Index
