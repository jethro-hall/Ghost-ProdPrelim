import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));
const artifactsDir = process.env.DOCX_ARTIFACTS_DIR || "/tmp/docx-artifacts";
fs.mkdirSync(artifactsDir, { recursive: true });
app.use("/docx-artifacts", express.static(artifactsDir));

function resolvePublicArtifactBase(req) {
  const configured = String(process.env.DOCX_PUBLIC_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const host = String(req.get("x-forwarded-host") || req.get("host") || "localhost:8080");
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http");
  return `${proto}://${host}`;
}

function sanitizeTemplateId(templateId) {
  const trimmed = String(templateId || "").trim();
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeArtifactFiles({ operation, token, messageContext, templateId }) {
  const safeTemplateId = sanitizeTemplateId(templateId || "unspecified-template");
  const summary = String(messageContext || "").trim() || "No message context supplied.";
  const summaryBlock = summary.slice(0, 12000);
  const markdownBody = [
    `# ${operation === "finalize" ? "Finalized" : "Preview"} Document`,
    "",
    `- Template: ${safeTemplateId}`,
    `- Generated at: ${new Date().toISOString()}`,
    "",
    "## Content",
    summaryBlock,
    "",
  ].join("\n");
  const htmlBody = `<!doctype html><html><head><meta charset=\"utf-8\" /><title>Doc Preview</title></head><body><pre>${markdownBody
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</pre></body></html>`;
  const htmlFilename = `${token}.html`;
  const docxFilename = `${token}.docx`;
  const jsonFilename = `${token}.json`;
  fs.writeFileSync(path.join(artifactsDir, htmlFilename), htmlBody, "utf8");
  fs.writeFileSync(path.join(artifactsDir, docxFilename), markdownBody, "utf8");
  fs.writeFileSync(
    path.join(artifactsDir, jsonFilename),
    JSON.stringify({ token, operation, template_id: safeTemplateId, generated_at: new Date().toISOString(), content: summaryBlock }, null, 2),
    "utf8",
  );
  return { htmlFilename, docxFilename, jsonFilename };
}

function buildArtifacts(req, { operation, messageContext, templateId }) {
  const token = crypto.randomUUID();
  const { htmlFilename, docxFilename, jsonFilename } = writeArtifactFiles({
    operation,
    token,
    messageContext,
    templateId,
  });
  const base = resolvePublicArtifactBase(req);
  const htmlUri = `${base}/docx-artifacts/${htmlFilename}`;
  const docxUri = `${base}/docx-artifacts/${docxFilename}`;
  const jsonUri = `${base}/docx-artifacts/${jsonFilename}`;
  const artifacts = [
    { kind: "html", uri: htmlUri, label: operation === "finalize" ? "Final HTML" : "Preview HTML" },
    { kind: "docx", uri: docxUri, label: operation === "finalize" ? "Final DOCX" : "Preview DOCX" },
    { kind: "html", uri: jsonUri, label: "Structured JSON Export" },
  ];
  return [
    ...artifacts,
  ];
}

function validatePayload(body, operation) {
  const diagnostics = [];
  const templateId = String(body?.template_id || "").trim();
  if (operation === "finalize" && !templateId) {
    diagnostics.push({
      code: "template_missing",
      message: "template_id is required for finalize requests.",
      field: "template_id",
    });
  }
  if (!String(body?.message_context || "").trim()) {
    diagnostics.push({
      code: "binding_invalid",
      message: "message_context is empty; generated document may be incomplete.",
      field: "message_context",
    });
  }
  return diagnostics;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/inspect/template", (req, res) => {
  const templateId = String(req.body?.template_id || "").trim();
  if (!templateId) {
    res.status(400).json({
      diagnostics: [
        {
          code: "template_missing",
          message: "template_id is required.",
          field: "template_id",
        },
      ],
    });
    return;
  }
  res.json({
    template_id: templateId,
    tags: ["title", "summary", "actions", "risks", "owner", "due_date"],
    diagnostics: [],
  });
});

app.post("/render/preview", (req, res) => {
  const diagnostics = validatePayload(req.body, "preview");
  res.json({
    status: diagnostics.length > 0 ? "validation_error" : "ok",
    artifacts: buildArtifacts(req, {
      operation: "preview",
      messageContext: req.body?.message_context,
      templateId: req.body?.template_id,
    }),
    diagnostics,
  });
});

app.post("/render/finalize", (req, res) => {
  const diagnostics = validatePayload(req.body, "finalize");
  if (diagnostics.some((item) => item.code === "template_missing")) {
    res.status(400).json({
      status: "validation_error",
      artifacts: [],
      diagnostics,
    });
    return;
  }
  res.json({
    status: "ok",
    artifacts: buildArtifacts(req, {
      operation: "finalize",
      messageContext: req.body?.message_context,
      templateId: req.body?.template_id,
    }),
    diagnostics,
  });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`docx-templater listening on ${port}`);
});
