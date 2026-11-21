/** /home is the scaffold's default landing spot after sign-in; rooms is ours. */

import { Navigate } from 'react-router-dom'

export default function HomePage() {
  return <Navigate to="/rooms" replace />
}
