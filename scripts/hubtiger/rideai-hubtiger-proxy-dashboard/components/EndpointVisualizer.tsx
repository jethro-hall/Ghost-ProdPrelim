import React, { useState } from 'react';
import { AlertTriangle, Search, FileText, MessageSquare, BellRing, ClipboardEdit } from 'lucide-react';

type TabType = 'search' | 'details' | 'create' | 'note' | 'notify';

export const EndpointVisualizer: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('search');

  const tabs: { id: TabType; label: string; icon: React.ReactNode; method: string; path: string }[] = [
    { id: 'search', label: 'Customer Search', icon: <Search className="w-4 h-4" />, method: 'POST', path: '/jobs/search' },
    { id: 'details', label: 'Job Details', icon: <FileText className="w-4 h-4" />, method: 'GET', path: '/jobs/{id}' },
    { id: 'create', label: 'Create Job', icon: <ClipboardEdit className="w-4 h-4" />, method: 'POST', path: '/jobs' },
    { id: 'note', label: 'Add Notes', icon: <MessageSquare className="w-4 h-4" />, method: 'POST', path: '/jobs/{id}/notes' },
    { id: 'notify', label: 'Notifications', icon: <BellRing className="w-4 h-4" />, method: 'POST', path: '/jobs/{id}/notify' },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-xl overflow-hidden">
        {/* Tab Navigation */}
        <div className="border-b border-slate-700 bg-slate-900/50 overflow-x-auto">
          <div className="flex whitespace-nowrap">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-6 py-4 text-sm font-medium transition-all border-b-2 ${
                  activeTab === tab.id 
                    ? 'bg-slate-800 text-indigo-400 border-indigo-500' 
                    : 'text-slate-400 hover:text-slate-200 border-transparent hover:bg-slate-800/50'
                }`}
              >
                {tab.icon}
                <div className="flex flex-col items-start">
                  <span className="text-[10px] uppercase opacity-50 font-bold">{tab.method}</span>
                  <span>{tab.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Request Side */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider">ElevenLabs Tool Payload</h3>
              <span className="text-xs font-mono text-slate-500">{tabs.find(t => t.id === activeTab)?.path}</span>
            </div>
            <div className="bg-slate-950 rounded-lg p-4 font-mono text-xs text-blue-300 border border-slate-800 overflow-x-auto min-h-[300px]">
              {activeTab === 'search' && (
<pre>{`{
  // Agent gathers these from conversation
  "firstName": "Cameron",
  "lastName": "Smith", 
  "email": "cam@example.com.au",
  "phone": "0400123456",
  "allStores": true
}`}</pre>
              )}
              {activeTab === 'details' && (
<pre>{`// GET Request
// Querying by the 'id' returned from search
{
  "id": 3820311,
  "includeMessages": true
}`}</pre>
              )}
              {activeTab === 'create' && (
<pre>{`{
  "partnerId": "uuid-v4-here",
  "storeId": "S102",
  "scheduledDate": "2023-11-01T08:30:00+10:00",
  "customer": {
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "0411222333"
  },
  "bike": { "make": "Giant", "model": "Defy" },
  "serviceType": "Bronze Service"
}`}</pre>
              )}
              {activeTab === 'note' && (
<pre>{`{
  "internalNote": "Customer checking in via AI Voice",
  "externalNote": "Confirmed parts are in stock."
}`}</pre>
              )}
              {activeTab === 'notify' && (
<pre>{`{
  "to": "workshop@rideai.com.au",
  "subject": "Urgent Callback Requested",
  "message": "Customer Cam Smith is on the phone asking about Job #031."
}`}</pre>
              )}
            </div>
          </div>

          {/* Response Side */}
          <div>
            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-3">Proxy Response (AI Context)</h3>
            <div className="bg-slate-950 rounded-lg p-4 font-mono text-xs text-emerald-300 border border-slate-800 overflow-x-auto min-h-[300px]">
              {activeTab === 'search' && (
<pre>{`{
  "ok": true,
  "matches": [
    {
      "id": 3820311,
      "jobCardNo": "031091",
      "customerName": "Cameron Smith",
      "bike": "Specialized Tarmac",
      "status": "In Progress",
      "lastUpdated": "2023-10-26T14:00:00+10:00"
    }
  ],
  "count": 1
}`}</pre>
              )}
              {activeTab === 'details' && (
<pre>{`{
  "ok": true,
  "data": {
    "id": 3820311,
    "status": "Awaiting Parts",
    "technician": "Dave",
    "estimatedReady": "2023-10-30",
    "totalCost": 145.50,
    "mechanicNotes": "Waiting on Shimano chainring. Frame cleaned.",
    "isReadyForCollection": false,
    "recentMessages": [
      { "from": "Store", "text": "Parts ordered", "date": "..." }
    ]
  }
}`}</pre>
              )}
              {/* Default successes for others */}
              {(activeTab !== 'search' && activeTab !== 'details') && (
<pre>{`{
  "ok": true,
  "data": {
    "status": "success",
    "timestamp": "2023-10-27T10:00:00+10:00"
  }
}`}</pre>
              )}
            </div>
          </div>
        </div>
        
        <div className="bg-indigo-900/20 p-4 border-t border-indigo-900/30">
            <div className="flex gap-3">
                <AlertTriangle className="w-5 h-5 text-indigo-400 shrink-0" />
                <div className="text-sm text-indigo-200">
                    <strong>Integration Strategy:</strong> For ElevenLabs, the <code>/jobs/search</code> response is critical. 
                    If multiple matches are found, the Agent should ask: <i>"I see two jobs, one for a Giant Defy and one for a Trek Domane, which one are you calling about?"</i>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};