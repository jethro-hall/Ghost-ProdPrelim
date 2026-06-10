import { useMemo, useState } from "react";
import { runHubTigerTest, type HubTigerTestOperation } from "../api";
import {
  defaultPayloadForStep,
  type BookingWorkflowStep,
  type BookingWorkflowStepId,
} from "../lib/bookingWorkflowSimulation";

export type BookingFlowContext = {
  store: string;
  bookingSessionId: string;
  serviceDate: string;
  technicianId: string;
  firstName: string;
  lastName: string;
  mobile: string;
  customerId: string;
  createCustomer: boolean;
  bikeId: string;
  createBike: boolean;
  vehicleModel: string;
  serviceType: string;
  issueDescription: string;
  needsCallback: boolean;
};

type Props = {
  steps: BookingWorkflowStep[];
  onVoiceLine?: (line: string) => void;
};

export default function HubTigerBookingFlowRunner({ steps, onVoiceLine }: Props) {
  const [workflowStep, setWorkflowStep] = useState<BookingWorkflowStepId>(steps[0]?.id ?? "availability");
  const [store, setStore] = useState("brisbane");
  const [bookingSessionId, setBookingSessionId] = useState("");
  const [serviceDate, setServiceDate] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [firstName, setFirstName] = useState("Jeff");
  const [lastName, setLastName] = useState("Hall");
  const [mobile, setMobile] = useState("0435185134");
  const [vehicleModel, setVehicleModel] = useState("Fatfish OG");
  const [serviceType, setServiceType] = useState("service_full");
  const [issueDescription, setIssueDescription] = useState("Squeaky brakes and safety check");
  const [needsCallback, setNeedsCallback] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const workflowCtx = useMemo(
    () => ({
      store,
      bookingSessionId,
      serviceDate,
      technicianId,
      firstName,
      lastName,
      mobile,
      customerId: "",
      createCustomer: false,
      bikeId: "",
      createBike: false,
      vehicleModel,
      serviceType,
      issueDescription,
      needsCallback,
    }),
    [
      store,
      bookingSessionId,
      serviceDate,
      technicianId,
      firstName,
      lastName,
      mobile,
      vehicleModel,
      serviceType,
      issueDescription,
      needsCallback,
    ],
  );

  const activeStepMeta = steps.find((s) => s.id === workflowStep);

  async function runWorkflowStep() {
    const meta = activeStepMeta;
    if (!meta?.hubtigerOperation) {
      const msg = `${meta?.nodeLabel ?? workflowStep}: conversation-only — no API call.`;
      setLastResult(msg);
      onVoiceLine?.(msg);
      return;
    }
    setWorkflowBusy(true);
    setWorkflowError(null);
    try {
      const payload = defaultPayloadForStep(workflowStep, workflowCtx);
      const result = await runHubTigerTest({
        operation: meta.hubtigerOperation as HubTigerTestOperation,
        payload,
      });
      const data = result.data ?? {};
      const voice =
        String(data.voice_line || data.assistant_prompt || result.message || "").trim() || "Step completed.";
      const nextSid = String(data.booking_session_id || bookingSessionId || "").trim();
      if (nextSid) setBookingSessionId(nextSid);
      if (data.ServiceDate) setServiceDate(String(data.ServiceDate));
      if (data.TechnicianID) setTechnicianId(String(data.TechnicianID));
      const rec = data.recommended_slot as Record<string, unknown> | undefined;
      if (rec?.ServiceDate) setServiceDate(String(rec.ServiceDate));
      if (rec?.TechnicianID) setTechnicianId(String(rec.TechnicianID));
      if (rec?.available_slot && !serviceDate) setServiceDate(String(rec.available_slot));
      setLastResult(voice);
      onVoiceLine?.(voice);
      const idx = steps.findIndex((s) => s.id === workflowStep);
      if (idx >= 0 && idx < steps.length - 1) {
        setWorkflowStep(steps[idx + 1].id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "HubTiger step failed.";
      setWorkflowError(msg);
      setLastResult(msg);
      onVoiceLine?.(msg);
    } finally {
      setWorkflowBusy(false);
    }
  }

  return (
    <div className="text-[0.76rem]">
      <label className="block">
        <span className="font-semibold text-slate-700">Step</span>
        <select
          value={workflowStep}
          onChange={(e) => setWorkflowStep(e.target.value as BookingWorkflowStepId)}
          className="glass-input mt-1 w-full rounded-md px-2 py-1.5"
        >
          {steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nodeLabel}
            </option>
          ))}
        </select>
      </label>
      {activeStepMeta && (
        <ul className="mt-2 list-inside list-disc space-y-1 text-slate-600">
          {activeStepMeta.checklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          Store
          <input value={store} onChange={(e) => setStore(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block col-span-2">
          ServiceDate
          <input value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1 font-mono text-[0.68rem]" />
        </label>
        <label className="block">
          TechnicianID
          <input value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block">
          booking_session_id
          <input
            value={bookingSessionId}
            onChange={(e) => setBookingSessionId(e.target.value)}
            className="glass-input mt-0.5 w-full rounded px-2 py-1 font-mono text-[0.68rem]"
          />
        </label>
        <label className="block">
          First name
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block">
          Last name
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block col-span-2">
          Mobile
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block col-span-2">
          vehicle_model
          <input value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1" />
        </label>
        <label className="block">
          service_type
          <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} className="glass-input mt-0.5 w-full rounded px-2 py-1">
            <option value="service_full">service_full</option>
            <option value="service_plus">service_plus</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1">
          <input type="checkbox" checked={needsCallback} onChange={(e) => setNeedsCallback(e.target.checked)} />
          needs_workshop_callback
        </label>
        <label className="block col-span-2">
          issue_description
          <textarea
            value={issueDescription}
            onChange={(e) => setIssueDescription(e.target.value)}
            rows={2}
            className="glass-input mt-0.5 w-full rounded px-2 py-1"
          />
        </label>
      </div>
      {workflowError && <p className="mt-2 text-rose-600">{workflowError}</p>}
      {lastResult && (
        <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-2 text-slate-800">{lastResult}</p>
      )}
      <button
        type="button"
        disabled={workflowBusy}
        onClick={() => void runWorkflowStep()}
        className="glass-button-primary mt-3 w-full rounded-md py-2 text-[0.78rem] font-semibold disabled:opacity-50"
      >
        {workflowBusy ? "Running…" : `Run ${activeStepMeta?.hubtigerOperation ?? "step"}`}
      </button>
    </div>
  );
}
