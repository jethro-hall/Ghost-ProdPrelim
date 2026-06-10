/** HubTiger booking workflow steps for operator simulation panel (mirrors ElevenLabs nodes). */

export type BookingWorkflowStepId =
  | "availability"
  | "create_booking"
  | "slot"
  | "customer_collect"
  | "customer_search"
  | "customer_confirm"
  | "bike_list"
  | "bike_confirm"
  | "service"
  | "submit"
  | "done";

export type HubTigerSimOperation =
  | "availability_lookup"
  | "booking_create"
  | "booking_slot_hold"
  | "booking_customer_search"
  | "booking_customer_confirm"
  | "booking_bike_list"
  | "booking_bike_confirm"
  | "booking_service_set"
  | "booking_submit";

export type BookingWorkflowStep = {
  id: BookingWorkflowStepId;
  nodeLabel: string;
  elevenLabsNode: string;
  toolImport?: string;
  hubtigerOperation?: HubTigerSimOperation;
  conversationOnly?: boolean;
  promptFile: string;
  checklist: string[];
};

/** Two-tool path: availability + booking_create (tested production JSONs). */
export const TWO_TOOL_BOOKING_STEPS: BookingWorkflowStep[] = [
  {
    id: "availability",
    nodeLabel: "1 — Availability",
    elevenLabsNode: "booking_availability",
    toolImport: "hubtiger_booking_availability.json",
    hubtigerOperation: "availability_lookup",
    promptFile: "NODE_SIMPLE_01_availability.md",
    checklist: [
      "Tool: hubtiger_booking_availability_readonly",
      "Save ServiceDate + TechnicianID from recommended_slot",
      "Offer ≤3 slots Mon–Sat 8:30am–5:00pm",
    ],
  },
  {
    id: "create_booking",
    nodeLabel: "2 — Create booking",
    elevenLabsNode: "booking_create",
    toolImport: "hubtiger_booking_create.json",
    hubtigerOperation: "booking_create",
    promptFile: "NODE_SIMPLE_03_create.md",
    checklist: [
      "All customer fields + ServiceDate + TechnicianID",
      "service_full or service_plus",
      "needs_workshop_callback for non-standard work",
      "Only say booked in if booking_confirmed true",
    ],
  },
];

export const BOOKING_WORKFLOW_STEPS: BookingWorkflowStep[] = [
  {
    id: "availability",
    nodeLabel: "0 — Availability",
    elevenLabsNode: "booking_availability",
    toolImport: "hubtiger_booking_availability.json",
    hubtigerOperation: "availability_lookup",
    promptFile: "NODE_00_availability.md",
    checklist: [
      "Tool: hubtiger_booking_availability_readonly only",
      "Collect store (brisbane / southport / burleigh)",
      "Offer ≤3 slots Mon–Sat 8:30am–5:00pm",
    ],
  },
  {
    id: "slot",
    nodeLabel: "1a — Slot hold",
    elevenLabsNode: "booking_slot",
    toolImport: "hubtiger_booking_slot.json",
    hubtigerOperation: "booking_slot_hold",
    promptFile: "NODE_01a_slot.md",
    checklist: [
      "Pass ServiceDate + TechnicianID from chosen slot",
      "Set slot_from_availability: true",
      "Save booking_session_id to workflow variable",
    ],
  },
  {
    id: "customer_collect",
    nodeLabel: "1b — Collect customer",
    elevenLabsNode: "booking_customer_collect",
    conversationOnly: true,
    promptFile: "NODE_01b_collect_customer.md",
    checklist: ["No tool — collect first name, last name, mobile", "One question at a time if caller is frustrated"],
  },
  {
    id: "customer_search",
    nodeLabel: "1b — Customer search",
    elevenLabsNode: "booking_customer_search",
    toolImport: "hubtiger_booking_customer_search.json",
    hubtigerOperation: "booking_customer_search",
    promptFile: "NODE_01b_customer_search.md",
    checklist: ["Include booking_session_id", "Speak voice_line only"],
  },
  {
    id: "customer_confirm",
    nodeLabel: "1b — Customer confirm",
    elevenLabsNode: "booking_customer_confirm",
    toolImport: "hubtiger_booking_customer_confirm.json",
    hubtigerOperation: "booking_customer_confirm",
    promptFile: "NODE_01b_customer_confirm.md",
    checklist: ["customer_id OR create_new: true", "Wait for customer_confirmed: true"],
  },
  {
    id: "bike_list",
    nodeLabel: "2a — Bike list",
    elevenLabsNode: "booking_bike_list",
    toolImport: "hubtiger_booking_bike_list.json",
    hubtigerOperation: "booking_bike_list",
    promptFile: "NODE_02a_bike_list.md",
    checklist: ["booking_session_id only"],
  },
  {
    id: "bike_confirm",
    nodeLabel: "2b — Bike confirm",
    elevenLabsNode: "booking_bike_confirm",
    toolImport: "hubtiger_booking_bike_confirm.json",
    hubtigerOperation: "booking_bike_confirm",
    promptFile: "NODE_02b_bike_confirm.md",
    checklist: ["bike_id OR create_new + vehicle_model"],
  },
  {
    id: "service",
    nodeLabel: "3a — Service + issue",
    elevenLabsNode: "booking_service",
    toolImport: "hubtiger_booking_service_set.json",
    hubtigerOperation: "booking_service_set",
    promptFile: "NODE_03a_service.md",
    checklist: ["service_full or service_plus", "issue_description required", "needs_workshop_callback for non-standard"],
  },
  {
    id: "submit",
    nodeLabel: "3b — Submit booking",
    elevenLabsNode: "booking_submit",
    toolImport: "hubtiger_booking_submit.json",
    hubtigerOperation: "booking_submit",
    promptFile: "NODE_03b_submit.md",
    checklist: ["booking_session_id only if 3a done", "Confirm booking_confirmed before saying booked in"],
  },
  {
    id: "done",
    nodeLabel: "Done",
    elevenLabsNode: "booking_complete",
    conversationOnly: true,
    promptFile: "NODE_done.md",
    checklist: ["No tools", "Thank customer briefly"],
  },
];

export const MAGIC_MIKE_OPENING_LINE =
  "Hey, Magic Mike here from Ride Electric. Are you looking to book a bike or scooter in for a service today?";

export function defaultPayloadForStep(
  stepId: BookingWorkflowStepId,
  ctx: {
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
  },
): Record<string, unknown> {
  const sid = ctx.bookingSessionId.trim();
  switch (stepId) {
    case "availability":
      return {
        store: ctx.store,
        start_date: new Date().toISOString().slice(0, 10),
        scheduling_goal: "earliest",
        limit: 3,
      };
    case "create_booking":
      return {
        store: ctx.store,
        first_name: ctx.firstName,
        last_name: ctx.lastName,
        mobile: ctx.mobile,
        vehicle_model: ctx.vehicleModel,
        issue_description: ctx.issueDescription,
        service_type: ctx.serviceType || "service_full",
        needs_workshop_callback: ctx.needsCallback,
        ServiceDate: ctx.serviceDate,
        TechnicianID: Number(ctx.technicianId) || undefined,
      };
    case "slot":
      return {
        store: ctx.store,
        booking_session_id: sid || undefined,
        ServiceDate: ctx.serviceDate,
        TechnicianID: Number(ctx.technicianId) || undefined,
        slot_from_availability: true,
      };
    case "customer_search":
      return {
        store: ctx.store,
        booking_session_id: sid,
        first_name: ctx.firstName,
        last_name: ctx.lastName,
        mobile: ctx.mobile,
      };
    case "customer_confirm":
      return {
        booking_session_id: sid,
        ...(ctx.createCustomer ? { create_new: true } : { customer_id: Number(ctx.customerId) || undefined }),
      };
    case "bike_list":
      return { booking_session_id: sid };
    case "bike_confirm":
      return {
        booking_session_id: sid,
        ...(ctx.createBike
          ? { create_new: true, vehicle_model: ctx.vehicleModel }
          : { bike_id: Number(ctx.bikeId) || undefined }),
      };
    case "service":
      return {
        booking_session_id: sid,
        service_type: ctx.serviceType || "service_full",
        issue_description: ctx.issueDescription,
        needs_workshop_callback: ctx.needsCallback,
      };
    case "submit":
      return { booking_session_id: sid };
    default:
      return {};
  }
}
