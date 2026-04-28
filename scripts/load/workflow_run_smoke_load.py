from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib import request
from urllib.error import URLError

def _single_request(url: str) -> tuple[bool, float]:
    started = time.perf_counter()
    try:
        with request.urlopen(url, timeout=30.0) as response:
            ok = int(getattr(response, "status", 500)) < 500
    except (TimeoutError, URLError):
        ok = False
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return ok, elapsed_ms


def run_load(base_url: str, concurrency: int, iterations: int) -> None:
    url = f"{base_url.rstrip('/')}/api/workflows/runs?surface=ghost_chatui"
    with ThreadPoolExecutor(max_workers=max(concurrency, 1)) as pool:
        for index in range(iterations):
            futures = [pool.submit(_single_request, url) for _ in range(concurrency)]
            results = [future.result() for future in as_completed(futures)]
            success_count = sum(1 for ok, _ in results if ok)
            p95_latency = sorted(ms for _ok, ms in results)[int(max(len(results) - 1, 0) * 0.95)]
            print(
                f"iteration={index + 1} concurrency={concurrency} "
                f"success={success_count}/{len(results)} p95_ms={p95_latency:.1f}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke load test for workflow run listing endpoint.")
    parser.add_argument("--base-url", default="http://localhost:80", help="Control API base URL")
    parser.add_argument("--concurrency", type=int, default=8, help="Concurrent requests per iteration")
    parser.add_argument("--iterations", type=int, default=5, help="Number of iterations")
    args = parser.parse_args()
    run_load(args.base_url, args.concurrency, args.iterations)


if __name__ == "__main__":
    main()

