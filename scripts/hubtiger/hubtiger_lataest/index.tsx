import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

console.log('🚀 [RideAI] Booting Dashboard...');

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error("❌ [RideAI] FATAL: Root element not found.");
} else {
  try {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    console.log('✅ [RideAI] Dashboard active.');
    // Signal to the index.html watchdog that we have successfully started
    window.dispatchEvent(new Event('react-ready'));
  } catch (err) {
    console.error('❌ [RideAI] Mounting Error:', err);
  }
}