
import React from 'react';
import { ProjectOverview } from './components/ProjectOverview';
import { EndpointVisualizer } from './components/EndpointVisualizer';
import { ScenarioTester } from './components/ScenarioTester';
import { LiveApiTester } from './components/LiveApiTester';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 selection:bg-indigo-500 selection:text-white pb-20">
      {/* Navigation Bar */}
      <nav className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold">R</div>
            <span className="font-semibold text-white tracking-tight">RideAI <span className="text-slate-500 font-normal">/ Proxy Hub</span></span>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium text-slate-400">
            <span className="text-emerald-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Proxy Service Ready
            </span>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="py-8">
        <ProjectOverview />
        
        <div className="max-w-7xl mx-auto px-6 mt-12 mb-4">
          <h2 className="text-2xl font-bold text-white mb-2">ElevenLabs Integration Context</h2>
          <p className="text-slate-400">Visualization of the JSON contracts and reasoning required for the Voice AI to function.</p>
        </div>
        
        <EndpointVisualizer />

        <LiveApiTester />

        <ScenarioTester />
        
        <footer className="max-w-7xl mx-auto px-6 py-12 text-center text-slate-500 text-sm">
          <p>Confidential • RideAI Internal Tools • Location: <code>/services/hubtiger_api/proxy</code></p>
        </footer>
      </main>
    </div>
  );
}
