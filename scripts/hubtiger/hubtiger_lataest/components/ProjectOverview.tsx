import React from 'react';
import { ProjectPhase, EndpointMethod, EndpointDef, Requirement, AgentWorkflowStep } from '../types.ts';
import { LayoutDashboard, CheckCircle, AlertTriangle, Network, ShieldAlert, Clock, Folder, FileCode, Server, Layers } from 'lucide-react';

const endpoints: EndpointDef[] = [
  {
    path: '/jobs/search',
    method: EndpointMethod.POST,
    description: 'Smart-lookup by firstName, lastName, email, or phone.',
    phase: ProjectPhase.NEW_WORK,
    inputs: ['firstName?', 'lastName?', 'email?', 'phone?', 'allStores'],
    outputs: ['Match Array with ID & JobCardNo']
  },
  {
    path: '/jobs/{id}',
    method: EndpointMethod.GET,
    description: 'Retrieve AI-optimized job card details (Notes, Status, Parts).',
    phase: ProjectPhase.NEW_WORK,
    inputs: ['id (internal ID)'],
    outputs: ['Job Context Object']
  },
  {
    path: '/jobs/{id}/messages',
    method: EndpointMethod.GET,
    description: 'Fetch comms history to avoid repeating info to customer.',
    phase: ProjectPhase.EXISTING,
    inputs: ['page', 'limit'],
    outputs: ['Message List']
  },
  {
    path: '/jobs',
    method: EndpointMethod.POST,
    description: 'Create/Book a new job card from voice details.',
    phase: ProjectPhase.NEW_WORK,
    inputs: ['partnerId', 'storeId', 'customerObj', 'bikeObj', 'serviceType'],
    outputs: ['Internal ID', 'JobCardNo']
  },
  {
    path: '/jobs/{id}/notes',
    method: EndpointMethod.POST,
    description: 'Add call logs or mechanic instructions.',
    phase: ProjectPhase.NEW_WORK,
    inputs: ['internalNote?', 'externalNote?'],
    outputs: ['Success']
  },
  {
    path: '/jobs/{id}/notify',
    method: EndpointMethod.POST,
    description: 'Trigger email/notification to workshop staff.',
    phase: ProjectPhase.NEW_WORK,
    inputs: ['to', 'subject', 'message'],
    outputs: ['Success', 'SES Provider ID']
  }
];

const constraints: Requirement[] = [
  {
    category: 'AI Security',
    items: [
      'X-Internal-Key validation on every request',
      'No PII (Personal Identifiable Info) in proxy logs',
      'Rate limiting to prevent bot scraping',
      'Strict input sanitization for ElevenLabs strings'
    ]
  },
  {
    category: 'Voice Logic',
    items: [
      'Timezone: Australia/Brisbane (Fixed)',
      'Currency: AUD formatting',
      'Date Translation: "2023-11-01" -> "Wednesday the 1st of Nov"',
      'Status mapping for natural speech (e.g., "Awaiting Parts")'
    ]
  }
];

const workflow: AgentWorkflowStep[] = [
  { step: 1, action: 'Identify', details: 'POST /jobs/search with phone or email.' },
  { step: 2, action: 'Contextualize', details: 'GET /jobs/{id} + /messages to understand state.' },
  { step: 3, action: 'Communicate', details: 'Synthesize notes into a status update.' },
  { step: 4, action: 'Document', details: 'POST /notes to log the summary of the call.' }
];

export const ProjectOverview: React.FC = () => {
  return (
    <div className="space-y-8 p-6 pb-20 max-w-7xl mx-auto">
      {/* Header Section */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 shadow-lg">
        <div className="flex items-center gap-3 mb-4">
          <LayoutDashboard className="w-8 h-8 text-indigo-400" />
          <h1 className="text-3xl font-bold text-white">RideAI Hubtiger API Proxy</h1>
        </div>
        <p className="text-slate-300 text-lg leading-relaxed">
          The Proxy serves as the translation layer between the <strong>ElevenLabs Voice Agent</strong> and the <strong>Hubtiger Backend</strong>.
          It ensures the Agent has high-quality "Contextual Data" (mechanic notes, part status, history) to provide human-like customer service.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* Endpoints Table */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden">
          <div className="p-4 bg-slate-700/50 border-b border-slate-700 flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <Network className="w-5 h-5 text-emerald-400" />
              API Toolset for Voice Agent
            </h2>
            <span className="text-xs font-mono bg-slate-900 px-2 py-1 rounded text-slate-400">agents.rideai.com.au</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-slate-700">
                {endpoints.map((ep, idx) => (
                  <tr key={idx} className="hover:bg-slate-700/30 transition-colors">
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-[10px] font-bold ${
                        ep.method === EndpointMethod.GET ? 'bg-blue-900 text-blue-300' : 'bg-emerald-900 text-emerald-300'
                      }`}>
                        {ep.method}
                      </span>
                    </td>
                    <td className="p-4 font-mono text-slate-300 text-xs">{ep.path}</td>
                    <td className="p-4 text-slate-300">{ep.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Architecture Tree */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-400" />
              Project Context
            </h2>
            <div className="bg-slate-950/50 rounded-lg p-4 font-mono text-sm text-slate-300 border border-slate-800">
              <div className="flex items-center gap-2 text-indigo-300 mb-2">
                <Folder className="w-4 h-4" />
                <span>RE_AI_Services/services/hubtiger_api/</span>
              </div>
              <div className="pl-6 space-y-2 border-l border-slate-800 ml-2">
                <div className="flex items-center gap-2">
                   <Folder className="w-4 h-4 text-slate-500" />
                   <span className="text-slate-400">proxy/</span>
                   <span className="text-xs text-emerald-500 bg-emerald-950/30 px-1.5 rounded">Runtime</span>
                </div>
                <div className="pl-6">
                   <div className="flex items-center gap-2">
                      <Server className="w-3 h-3 text-blue-400" />
                      <span className="text-blue-300 font-bold">server.js</span>
                      <span className="text-slate-500 italic ml-1">// Tool Handler</span>
                   </div>
                </div>
              </div>
            </div>
          </div>

          {/* Workflow */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-400" />
              Agent Logic Stepper
            </h2>
            <div className="space-y-4">
              {workflow.map((step) => (
                <div key={step.step} className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] font-bold shrink-0">{step.step}</div>
                  <div>
                    <h3 className="text-sm font-bold text-white uppercase">{step.action}</h3>
                    <p className="text-xs text-slate-400">{step.details}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Constraints */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-rose-400" />
              Core Safety
            </h2>
            <div className="grid grid-cols-1 gap-4">
              {constraints.map((req, idx) => (
                <div key={idx} className="bg-slate-900/50 rounded-lg p-3">
                  <h3 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-tighter">{req.category}</h3>
                  <ul className="space-y-1">
                    {req.items.map((item, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-slate-300">
                        <CheckCircle className="w-3 h-3 text-emerald-500" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};