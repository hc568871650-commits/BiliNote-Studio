import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { HomePage } from '@/pages/HomePage/Home'

const Index = () => {
  const location = useLocation()
  const working = location.pathname === '/'
  const wasWorkingRef = useRef(working)
  const [enteringHome, setEnteringHome] = useState(false)

  useEffect(() => {
    const returnedToHome = !wasWorkingRef.current && working
    wasWorkingRef.current = working
    if (!returnedToHome) {
      if (!working) setEnteringHome(false)
      return
    }
    setEnteringHome(true)
    const timer = window.setTimeout(() => setEnteringHome(false), 260)
    return () => window.clearTimeout(timer)
  }, [working])

  return (
    <>
      <div
        className={enteringHome ? 'workspace-home-host is-entering' : 'workspace-home-host'}
        style={{ display: working ? 'block' : 'none' }}
        aria-hidden={!working}
      >
        <HomePage />
      </div>
      <Outlet />
    </>
  )
}
export default Index
