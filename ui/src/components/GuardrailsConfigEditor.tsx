import { useId } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationMode, RuntimeProfileGuardrailsConfig } from "../api";

type Props = {
  value: RuntimeProfileGuardrailsConfig;
  onChange: (next: RuntimeProfileGuardrailsConfig) => void;
};

const MD_PREVIEW_CLASS =
  "ghost-scroll max-h-[min(320px,40vh)] overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-[0.72rem] text-slate-800 " +
  "[&_h1]:mb-2 [&_h1]:text-[0.95rem] [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-[0.85rem] [&_h2]:font-semibold [&_h3]:font-semibold " +
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 " +
  "[&_p]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:italic " +
  "[&_code]:rounded [&_code]:bg-slate-200/80 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.68rem] " +
  "[&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-900 [&_pre]:p-2 [&_pre]:text-slate-100 [&_pre]:text-[0.65rem] " +
  "[&_a]:text-ghost-orange [&_a]:underline [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1";

function MarkdownPreview({ markdown }: { markdown: string }) {
  const body = markdown.trim() ? markdown : "_Empty_";
  return (
    <div className={MD_PREVIEW_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}

function MarkdownSplitField({
  label,
  hint,
  value,
  onChange,
  minHeightClass,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  minHeightClass: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="text-[0.74rem] font-medium text-slate-600">{label}</div>
      {hint ? <p className="text-[0.65rem] text-slate-500">{hint}</p> : null}
      <div className="grid gap-2 lg:grid-cols-2">
        <label className="block min-w-0" htmlFor={id}>
          <div className="mb-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-slate-400">Edit</div>
          <textarea
            id={id}
            className={`ghost-textarea w-full bg-white ${minHeightClass}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
        </label>
        <div>
          <div className="mb-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-slate-400">Preview</div>
          <MarkdownPreview markdown={value} />
        </div>
      </div>
    </div>
  );
}

export default function GuardrailsConfigEditor({ value, onChange }: Props) {
  function patch(partial: Partial<RuntimeProfileGuardrailsConfig>) {
    onChange({ ...value, ...partial });
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-[0.68rem] text-slate-600">
        <span className="font-semibold text-slate-700">Grounding mode</span> is fixed to{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono text-[0.65rem]">retrieved_only</code> (schema).
      </div>

      <MarkdownSplitField
        label="System prompt"
        value={value.system_prompt}
        onChange={(system_prompt) => patch({ system_prompt })}
        minHeightClass="min-h-[200px] lg:min-h-[280px]"
      />

      <MarkdownSplitField
        label="Insufficient context behavior"
        value={value.insufficient_context_behavior}
        onChange={(insufficient_context_behavior) => patch({ insufficient_context_behavior })}
        minHeightClass="min-h-[96px]"
      />

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-[0.74rem] font-medium text-slate-600">
          Conversation mode
          <select
            className="ghost-select mt-1 w-full bg-white"
            value={value.conversation_mode}
            onChange={(e) => patch({ conversation_mode: e.target.value as ConversationMode })}
          >
            <option value="quick">quick</option>
            <option value="board">board</option>
            <option value="working_session">working_session</option>
          </select>
        </label>
        <label className="block text-[0.74rem] font-medium text-slate-600">
          Policy mode
          <select
            className="ghost-select mt-1 w-full bg-white"
            value={value.policy_mode}
            onChange={(e) =>
              patch({
                policy_mode: e.target.value as RuntimeProfileGuardrailsConfig["policy_mode"],
              })
            }
          >
            <option value="admin_approval_required">admin_approval_required</option>
            <option value="locked">locked</option>
            <option value="open">open</option>
          </select>
        </label>
      </div>

      <MarkdownSplitField
        label="Owner-operator questionnaire template"
        value={value.owner_operator_questionnaire ?? ""}
        onChange={(owner_operator_questionnaire) => patch({ owner_operator_questionnaire })}
        minHeightClass="min-h-[160px]"
        placeholder="Plain-English owner/operator guidance template"
      />

      <MarkdownSplitField
        label="Owner-operator compact guidance"
        hint="Derived-style compact rules; editable here for operator fixes."
        value={value.owner_operator_questionnaire_compact ?? ""}
        onChange={(owner_operator_questionnaire_compact) => patch({ owner_operator_questionnaire_compact })}
        minHeightClass="min-h-[120px]"
      />

      <MarkdownSplitField
        label="Board document format contract"
        value={value.board_document_format_contract ?? ""}
        onChange={(board_document_format_contract) => patch({ board_document_format_contract })}
        minHeightClass="min-h-[130px]"
        placeholder="Board document section contract shown to the model"
      />

      <MarkdownSplitField
        label="Financial report format contract"
        value={value.financial_report_format_contract ?? ""}
        onChange={(financial_report_format_contract) => patch({ financial_report_format_contract })}
        minHeightClass="min-h-[120px]"
        placeholder="Financial report section contract shown to the model"
      />

      <label className="block text-[0.74rem] font-medium text-slate-600">
        Doc finalize required sections (comma-separated)
        <input
          className="ghost-input mt-1 w-full bg-white"
          value={(value.docx_finalize_required_sections ?? []).join(", ")}
          onChange={(e) =>
            patch({
              docx_finalize_required_sections: e.target.value
                .split(",")
                .map((part) => part.trim().toLowerCase())
                .filter(Boolean),
            })
          }
          placeholder="facts, inferences, assumptions, risks, actions"
        />
      </label>
    </div>
  );
}
