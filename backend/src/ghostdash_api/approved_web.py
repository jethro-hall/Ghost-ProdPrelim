from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup


EXPLICIT_WEB_HINTS = (
    "website",
    "web",
    "site",
    "scrape",
    "check the site",
    "check the website",
    "visit",
    "look up",
    "lookup",
    "verify online",
    "current on",
    "latest on",
)

ODOO_ONLY_HINTS = (
    "using only odoo",
    "use only odoo",
    "odoo only",
    "only odoo",
)


def normalize_allowed_urls(urls: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for raw in urls or []:
        value = str(raw).strip()
        if not value:
            continue
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        if value not in normalized:
            normalized.append(value)
        if len(normalized) >= 2:
            break
    return normalized


def get_tool_config(tool_policy_config: dict, tool_id: str) -> dict | None:
    for tool in list(tool_policy_config.get("tools") or []):
        if str(tool.get("id")) == tool_id:
            return dict(tool)
    return None


def should_use_approved_web_context(
    *,
    message: str,
    allowed_urls: list[str],
    force_use: bool,
) -> bool:
    lowered = message.casefold()
    if any(hint in lowered for hint in ODOO_ONLY_HINTS):
        return False
    if force_use and allowed_urls:
        return True
    if any(hint in lowered for hint in EXPLICIT_WEB_HINTS):
        return bool(allowed_urls)
    if any(urlparse(url).netloc.casefold() in lowered for url in allowed_urls):
        return True
    # Keep web fetches explainable: use allowlisted sources only when
    # explicitly asked or when the user names one of the configured domains.
    return False


def _normalize_page_text(html: str) -> tuple[str | None, str]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True)[:200] if soup.title else None
    text = soup.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return title, text.strip()


def _extract_relevant_notes(text: str, message: str) -> list[str]:
    terms = {
        term
        for term in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{3,}", message.casefold())
        if term not in {"that", "with", "from", "this", "what", "when", "where", "which", "their"}
    }
    paragraphs = [paragraph.strip() for paragraph in text.split("\n\n") if len(paragraph.strip()) >= 60]
    if not paragraphs:
        paragraphs = [line.strip() for line in text.splitlines() if len(line.strip()) >= 60]
    scored: list[tuple[int, str]] = []
    for paragraph in paragraphs:
        lowered = paragraph.casefold()
        score = sum(1 for term in terms if term in lowered)
        if score > 0:
            scored.append((score, paragraph[:900]))
    if scored:
        scored.sort(key=lambda item: (-item[0], len(item[1])))
        return [paragraph for _, paragraph in scored[:3]]
    return [text[:1200]] if text else []


async def fetch_approved_web_context(
    *,
    message: str,
    allowed_urls: list[str],
) -> tuple[str, list[dict]]:
    context_sections: list[str] = []
    citations: list[dict] = []
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        for url in allowed_urls[:2]:
            title: str | None = None
            try:
                response = await client.get(url)
                response.raise_for_status()
                title, page_text = _normalize_page_text(response.text)
                notes = _extract_relevant_notes(page_text, message)
            except Exception as exc:
                notes = [f"Unable to fetch this approved source at answer time: {exc}"]
            context_sections.append(
                "\n".join(
                    section
                    for section in [
                        f"Approved source: {url}",
                        f"Title: {title}" if title else None,
                        "Relevant notes:",
                        *[f"- {note}" for note in notes],
                    ]
                    if section
                )
            )
            citations.append(
                {
                    "document_id": "",
                    "filename": title or urlparse(url).netloc,
                    "corpus": "approved_web",
                    "artifact_type": "approved_web_source",
                    "source_path": url,
                    "source_type": "approved_web",
                    "title": title or urlparse(url).netloc,
                }
            )
    return "\n\n".join(context_sections), citations
