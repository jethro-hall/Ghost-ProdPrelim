import React, { useState } from 'react';
import { User, Search, FileText, CheckCircle2, MessageCircle, ArrowRight } from 'lucide-react';

export const ScenarioTester: React.FC = () => {
  const [step, setStep] = useState(0);

  const scenario = [
    {
      title: "Identity Lookup",
      desc: "Agent asks: 'Can I get your name and phone number?'",
      action: "Call POST /jobs/search",
      icon: <Search className="w-5 h-5" />,
      output: "Matched: Cameron Smith (Job #031091)"
    },
    {
      title: "Context Retrieval",
      desc: "Agent checks the specific status and technician notes.",
      action: "Call GET /jobs/3820311",
      icon: <FileText className="w-5 h-5" />,
      output: "Status: Awaiting Parts (Shimano Chainring)"
    },
    {
      title: "Conversation",
      desc: "Agent explains the delay and checks if parts are ordered.",
      action: "Analyze mechanicNotes & Message History",
      icon: <MessageCircle className="w-5 h-5" />,
      output: "Agent says: 'We're just waiting on a chainring, should be ready Monday.'"
    },
    {
      title: "Action Execution",
      desc: "Customer asks for a text when it's done.",
      action: "Call POST /jobs/3820311/notes",
      icon: <CheckCircle2 className="w-5 h-5" />,
      output: "Success: Internal Note Added"
    }
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto mt-12">
      <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
        <User className="w-6 h-6 text-indigo-400" />
        AI Agent Reasoning Flow
      </h2>
      
      <div className="space-y-4">
        {scenario.map((s, idx) => (
          <div 
            key={idx} 
            className={`transition-all duration-500 flex items-start gap-4 p-4 rounded-xl border ${
              step >= idx ? 'bg-slate-800 border-indigo-500/50 opacity-100' : 'bg-slate-900/50 border-slate-800 opacity-40'
            }`}
          >
            <div className={`p-2 rounded-lg ${step >= idx ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-600'}`}>
              {s.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h3 className={`font-bold ${step >= idx ? 'text-white' : 'text-slate-500'}`}>{s.title}</h3>
                {step === idx && <span className="text-[10px] bg-indigo-500 text-white px-2 py-0.5 rounded-full animate-pulse">ACTIVE</span>}
              </div>
              <p className="text-sm text-slate-400 mb-2">{s.desc}</p>
              {step >= idx && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className="text-indigo-400 font-mono font-bold bg-indigo-950/50 px-2 py-1 rounded">{s.action}</span>
                  <ArrowRight className="w-3 h-3 text-slate-600" />
                  <span className="text-emerald-400 font-medium italic">{s.output}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex justify-center">
        <button 
          onClick={() => setStep((s) => (s + 1) % scenario.length)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-full font-bold shadow-lg transition-all active:scale-95"
        >
          {step === scenario.length - 1 ? 'Reset Simulation' : 'Next Reasoning Step'}
        </button>
      </div>
    </div>
  );
};