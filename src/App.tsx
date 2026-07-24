import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import AppLayout from '@/components/AppLayout'
import { RequireAdmin, RequireAuth } from '@/components/guards'
import Admin from '@/routes/Admin'
import Calculadora from '@/routes/Calculadora'
import Fechas from '@/routes/Fechas'
import FechaDetail from '@/routes/FechaDetail'
import Leaderboard from '@/routes/Leaderboard'
import Live from '@/routes/Live'
import Login from '@/routes/Login'
import Profile from '@/routes/Profile'
import Seasons from '@/routes/Seasons'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />

        {/* Authenticated (session + bound player) → themed shell + tab nav */}
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Leaderboard />} />
            <Route path="/temporadas" element={<Seasons />} />
            <Route path="/temporadas/:seasonId" element={<Leaderboard />} />
            <Route path="/fechas" element={<Fechas />} />
            <Route path="/fechas/:id" element={<FechaDetail />} />
            <Route path="/vivo" element={<Live />} />
            <Route path="/calculadora" element={<Calculadora />} />
            <Route path="/perfil" element={<Profile />} />

            {/* Admin-only */}
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<Admin />} />
            </Route>

            {/* Unknown authed path → Liga home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
