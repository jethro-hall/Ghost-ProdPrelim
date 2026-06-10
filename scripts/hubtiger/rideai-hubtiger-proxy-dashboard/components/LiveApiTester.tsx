import React, { useState, useEffect } from 'react';
import { Play, Database, Search, User, Bike, AlertCircle, Link, Key } from 'lucide-react';

export const LiveApiTester: React.FC = () => {
  const [proxyUrl, setProxyUrl] = useState('http://agents.rideai.com.au:8095');
  const [internalKey, setInternalKey] = useState('ride-ai-secret-2024');
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // Check if server is reachable on load or when URL changes
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch(proxyUrl);
        if (res.ok) setServerStatus('online');
        else setServerStatus('offline');
      } catch {
        setServerStatus('offline');
      }
    };
    checkStatus();
  }, [proxyUrl]);

  const handleSearch = async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);
    try {
      const response = await fetch(`${proxyUrl}/jobs/search`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Internal-Key': internalKey 
        },
        body: JSON.stringify({ phone: query })
      });
      
      const data = await response.json();
      if (data.ok) {
        setResults(data.matches);
      } else {
        setError(data.error || 'The Proxy rejected the request. Check your Internal Key.');
      }
    } catch (err) {
      setError(`Connection failed. Make sure the proxy is running at ${proxyUrl} and CORS is enabled.`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto bg-slate-800 rounded-xl border border-slate-700 shadow-xl mt-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-emerald-400" />
            Live API Test Bench
          </h2>
          <p className="text-xs text-slate-400 mt-1">Test your actual server connection and Hubtiger search logic.</p>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
          serverStatus === 'online' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-500/30' : 
          serverStatus === 'offline' ? 'bg-rose-900/30 text-rose-400 border border-rose-500/30' : 'bg-slate-700 text-slate-400'
        }`}>
          <span className={`w-2 h-2 rounded-full ${serverStatus === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`}></span>
          {serverStatus}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1">
            <Link className="w-3 h-3" /> Proxy Server URL
          </label>
          <input 
            type="text" 
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-indigo-300 focus:border-indigo-500 outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1">
            <Key className="w-3 h-3" /> X-Internal-Key (Secret)
          </label>
          <input 
            type="password" 
            value={internalKey}
            onChange={(e) => setInternalKey(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-indigo-300 focus:border-indigo-500 outline-none"
          />
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input 
            type="text" 
            placeholder="Search by Phone, Email, or Name..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
        </div>
        <button 
          onClick={handleSearch}
          disabled={isLoading || !query}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-bold flex items-center gap-2 transition-all shadow-lg"
        >
          {isLoading ? 'Searching...' : <><Play className="w-4 h-4" /> Test API</>}
        </button>
      </div>

      {error && (
        <div className="bg-rose-900/20 border border-rose-900/50 p-4 rounded-lg flex gap-3 text-rose-300 text-sm mb-6 animate-in fade-in slide-in-from-top-1">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <div>
            <p className="font-bold">Test Failed</p>
            <p className="opacity-80">{error}</p>
          </div>
        </div>
      )}

      {results && (
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center justify-between">
            <span>Matches Found ({results.length})</span>
            {results.length > 0 && <span className="text-emerald-500 font-mono">200 OK</span>}
          </h3>
          {results.length === 0 ? (
            <div className="text-center py-8 text-slate-500 italic bg-slate-950/50 rounded-lg border border-dashed border-slate-700">
              No customers found matching "{query}".
            </div>
          ) : (
            results.map((job: any) => (
              <div key={job.id} className="bg-slate-950 border border-slate-800 p-4 rounded-lg flex items-center justify-between hover:border-slate-500 transition-all cursor-pointer group">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-900/30">
                    <User className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-bold text-white group-hover:text-indigo-300 transition-colors">{job.customerName}</div>
                    <div className="text-xs text-slate-400 flex items-center gap-2">
                      <Bike className="w-3 h-3" /> {job.bike} • <span className="font-mono text-[10px] bg-slate-900 px-1.5 py-0.5 rounded">#{job.jobCardNo}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-xs font-bold uppercase tracking-tighter ${
                    job.status.toLowerCase().includes('progress') ? 'text-amber-400' : 'text-emerald-400'
                  }`}>
                    {job.status}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">ID: {job.id}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
