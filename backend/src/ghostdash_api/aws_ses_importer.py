from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zipfile import ZipFile

AWS_SES_TOOL_ID = "aws_ses"
AWS_SES_PROVIDER = "aws"
AWS_SES_GATEWAY = "native"


@dataclass(frozen=True)
class ImportedSesOperation:
    operation: str
    source_resource: str
    source_operation: str
    aws_action: str
    risk_class: str


_N8N_TO_GHOST_OPERATION: dict[tuple[str, str], str] = {
    ("customVerificationEmail", "create"): "create_custom_verification_email_template",
    ("customVerificationEmail", "delete"): "delete_custom_verification_email_template",
    ("customVerificationEmail", "get"): "get_custom_verification_email_template",
    ("customVerificationEmail", "getAll"): "list_custom_verification_email_templates",
    ("customVerificationEmail", "send"): "send_custom_verification_email",
    ("customVerificationEmail", "update"): "update_custom_verification_email_template",
    ("email", "send"): "send_email",
    ("email", "sendTemplate"): "send_templated_email",
    ("template", "create"): "create_template",
    ("template", "delete"): "delete_template",
    ("template", "get"): "get_template",
    ("template", "getAll"): "list_templates",
    ("template", "update"): "update_template",
}

_OPERATION_TO_ACTION: dict[str, str] = {
    "create_custom_verification_email_template": "CreateCustomVerificationEmailTemplate",
    "delete_custom_verification_email_template": "DeleteCustomVerificationEmailTemplate",
    "get_custom_verification_email_template": "GetCustomVerificationEmailTemplate",
    "list_custom_verification_email_templates": "ListCustomVerificationEmailTemplates",
    "send_custom_verification_email": "SendCustomVerificationEmail",
    "update_custom_verification_email_template": "UpdateCustomVerificationEmailTemplate",
    "send_email": "SendEmail",
    "send_templated_email": "SendTemplatedEmail",
    "create_template": "CreateTemplate",
    "delete_template": "DeleteTemplate",
    "get_template": "GetTemplate",
    "list_templates": "ListTemplates",
    "update_template": "UpdateTemplate",
}

AWS_SES_OPERATIONS = tuple(_OPERATION_TO_ACTION.keys())


def _read_zip_text(zip_path: str | Path, suffix: str) -> str:
    with ZipFile(zip_path) as archive:
        matches = [name for name in archive.namelist() if name.endswith(suffix)]
        if not matches:
            raise ValueError(f"Archive is missing {suffix}")
        return archive.read(matches[0]).decode("utf-8")


def _source_operations_from_node(node_js: str) -> set[tuple[str, str]]:
    operations: set[tuple[str, str]] = set()
    resource: str | None = None
    for line in node_js.splitlines():
        stripped = line.strip()
        resource_match = re.match(r"if \(resource === '([^']+)'\)", stripped)
        if resource_match:
            resource = resource_match.group(1)
            continue
        op_match = re.match(r"if \(operation === '([^']+)'\)", stripped)
        if op_match and resource:
            operations.add((resource, op_match.group(1)))
    return operations


def build_aws_ses_manifest(zip_path: str | Path) -> dict[str, Any]:
    """Extract GhostDASH-native AWS SES operations from n8n's compiled node dist."""
    node_js = _read_zip_text(zip_path, "Aws/SES/AwsSes.node.js")
    source_operations = _source_operations_from_node(node_js)
    imported: list[ImportedSesOperation] = []
    missing: list[str] = []
    for source_key, operation in sorted(_N8N_TO_GHOST_OPERATION.items(), key=lambda item: item[1]):
        if source_key not in source_operations:
            missing.append(f"{source_key[0]}.{source_key[1]}")
            continue
        imported.append(
            ImportedSesOperation(
                operation=operation,
                source_resource=source_key[0],
                source_operation=source_key[1],
                aws_action=_OPERATION_TO_ACTION[operation],
                risk_class="write" if operation.startswith(("send_", "create_", "update_", "delete_")) else "read",
            )
        )
    if missing:
        raise ValueError(f"AWS SES node archive missing expected operations: {', '.join(missing)}")

    return {
        "tool_id": AWS_SES_TOOL_ID,
        "provider": AWS_SES_PROVIDER,
        "gateway": AWS_SES_GATEWAY,
        "source": "n8n-nodes-base/dist/nodes/Aws/SES",
        "operations": [
            {
                "operation": item.operation,
                "source_resource": item.source_resource,
                "source_operation": item.source_operation,
                "aws_action": item.aws_action,
                "risk_class": item.risk_class,
            }
            for item in imported
        ],
    }
