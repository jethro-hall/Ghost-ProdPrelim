import React from 'react';
import { Terminal, Copy, CheckCircle, Info, Zap, AlertTriangle } from 'lucide-react';

export const DeploymentGuide: React.FC = () => {
  const scriptContent = `# Run this from the project root:
chmod +x update_server.sh
./update_server.sh`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(scriptContent);
    alert('Command copied to clipboard!');
  };

  return (
    <div className="p-6 max-w-4xl mx-auto mt-12 mb-20">
      <div className="flex items-center gap-3 mb-6">
        <Terminal className="w-6 h-6 text-indigo-400" />
        <h2 className="text-2xl font-bold text-white">DevOps & Control</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main Script Card */}
        <div className="md:col-span-2 bg-slate-800 rounded-xl border border-slate-700 shadow-xl overflow-hidden">
          <div className="p-4 bg-slate-900/50 border-b border-slate-700 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-bold text-slate-300 uppercase tracking-wider">Update Script</span>
            </div>
            <button 
              onClick={copyToClipboard}
              className="text-slate-400 hover:text-white transition-colors"
              title="Copy Command"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <div className="p-6">
            <p className="text-sm text-slate-400 mb-4">
              We've created a <code>update_server.sh</code> script to handle port collisions (EADDRINUSE) and dependency management automatically.
            </p>
            <div className="bg-slate-950 rounded-lg p-4 font-mono text-sm text-indigo-300 border border-slate-900">
              <div className="text-slate-600"># To update and restart server:</div>
              <div className="mt-1">
                <span className="text-emerald-500">chmod</span> +x update_server.sh<br />
                <span className="text-emerald-500">./</span>update_server.sh
              </div>
            </div>
          </div>
        </div>

        {/* Quick Tips */}
        <div className="space-y-4">
          <div className="bg-indigo-900/20 border border-indigo-500/30 rounded-xl p-4">
            <h4 className="text-xs font-bold text-indigo-300 uppercase mb-2 flex items-center gap-1">
              <Info className="w-3 h-3" /> Monitor Logs
            </h4>
            <code className="text-[10px] block bg-slate-950 p-2 rounded text-slate-400">
              tail -f proxy_logs.txt
            </code>
          </div>
          
          <div className="bg-rose-900/20 border border-rose-500/30 rounded-xl p-4">
            <h4 className="text-xs font-bold text-rose-300 uppercase mb-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Port Conflict?
            </h4>
            <p className="text-[10px] text-slate-400">
              If the script fails, manually clear port 8095:
            </p>
            <code className="text-[10px] block bg-slate-950 p-2 rounded text-slate-400 mt-2">
              fuser -k 8095/tcp
            </code>
          </div>

          <div className="bg-emerald-900/20 border border-emerald-500/30 rounded-xl p-4">
            <h4 className="text-xs font-bold text-emerald-300 uppercase mb-2 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" /> Check Uptime
            </h4>
            <code className="text-[10px] block bg-slate-950 p-2 rounded text-slate-400">
              ps aux | grep node
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};