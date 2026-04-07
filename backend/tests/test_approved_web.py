from __future__ import annotations

from ghostdash_api.approved_web import normalize_allowed_urls, should_use_approved_web_context


def test_normalize_allowed_urls_filters_invalid_entries_and_limits_to_two() -> None:
    urls = [
        " https://example.com ",
        "ftp://ignored.example.com",
        "https://example.com",
        "http://second.example.com/path",
        "https://third.example.com",
    ]

    normalized = normalize_allowed_urls(urls)

    assert normalized == [
        "https://example.com",
        "http://second.example.com/path",
    ]


def test_should_use_approved_web_context_requires_explicit_signal_or_domain_match() -> None:
    allowed_urls = ["https://example.com"]

    assert (
        should_use_approved_web_context(
            message="Check the website for the latest pricing on this source.",
            allowed_urls=allowed_urls,
            force_use=False,
        )
        is True
    )
    assert (
        should_use_approved_web_context(
            message="Can you compare this with example.com before answering?",
            allowed_urls=allowed_urls,
            force_use=False,
        )
        is True
    )
    assert (
        should_use_approved_web_context(
            message="Give me pricing strategy advice for this business.",
            allowed_urls=allowed_urls,
            force_use=False,
        )
        is False
    )


def test_should_use_approved_web_context_honors_force_only_when_sources_exist() -> None:
    assert (
        should_use_approved_web_context(
            message="Use the approved web sources now.",
            allowed_urls=["https://example.com"],
            force_use=True,
        )
        is True
    )
    assert (
        should_use_approved_web_context(
            message="Use the approved web sources now.",
            allowed_urls=[],
            force_use=True,
        )
        is False
    )
