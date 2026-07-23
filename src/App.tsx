import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { RequireAdmin, RequireAuth } from '@/components/guards'
import Admin from '@/routes/Admin'
import Home from '@/routes/Home'
import Login from '@/routes/Login'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />

        {/* Authenticated (session + bound player) */}
        <Route element={<RequireAuth />}>
          <Route path="/" element={<Home />} />

          {/* Admin-only */}
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<Admin />} />
          </Route>

          {/* Unknown authed path → home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
