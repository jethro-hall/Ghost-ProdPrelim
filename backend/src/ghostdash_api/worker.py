"""Deprecated worker entrypoint; delegates to workflow runtime service."""

from .workflow_runtime import run

__all__ = ["run"]
