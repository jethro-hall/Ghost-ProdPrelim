export type DocxOperation = "preview" | "finalize";

export type ChatDocxMode = {
  enabled: boolean;
  templateId: string;
  operation: DocxOperation;
  bindingOverrides: Record<string, unknown>;
};

export type DocxArtifact = {
  kind: "docx" | "pdf" | "html";
  uri: string;
  label?: string | null;
};

export type DocxDiagnostic = {
  code: string;
  message: string;
  field?: string | null;
};
