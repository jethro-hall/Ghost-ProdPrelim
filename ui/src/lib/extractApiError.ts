import axios from "axios";

export function extractApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      const message = String(record.message || "").trim();
      const code = String(record.error_code || "").trim();
      if (message && code) return `${message} (${code})`;
      if (message) return message;
    }
    const status = error.response?.status;
    if (status) return `${fallback} (HTTP ${status})`;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}
