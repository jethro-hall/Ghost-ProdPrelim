export enum ProjectPhase {
  EXISTING = 'Existing',
  NEW_WORK = 'New Work',
  OPTIONAL = 'Optional Later'
}

export enum EndpointMethod {
  GET = 'GET',
  POST = 'POST'
}

export interface EndpointDef {
  path: string;
  method: EndpointMethod;
  description: string;
  phase: ProjectPhase;
  inputs: string[];
  outputs: string[];
}

export interface Requirement {
  category: string;
  items: string[];
}

export interface AgentWorkflowStep {
  step: number;
  action: string;
  details: string;
}
