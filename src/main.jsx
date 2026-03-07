import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Overlay from './Overlay.jsx';

// Load the overlay page if the URL path is /overlay, otherwise load the main app
const isOverlay = window.location.pathname === '/overlay';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isOverlay ? <Overlay /> : <App />}
  </StrictMode>
);