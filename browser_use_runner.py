import asyncio
import json
import os
import sys
import contextlib
from pathlib import Path

# Avoid Windows console encoding issues from upstream emoji logs.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Reduce noisy logging/telemetry from browser-use in this runner.
os.environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")


def _read_request() -> dict:
    """
    Reads a JSON request from stdin (preferred) or from argv[1].
    """
    # IMPORTANT: read bytes and decode as UTF-8 to avoid Windows console encodings
    # producing surrogate characters (which pydantic rejects as invalid unicode).
    data = ""
    try:
        raw = sys.stdin.buffer.read()
        if raw:
            try:
                data = raw.decode("utf-8")
            except UnicodeDecodeError:
                # Best-effort fallback: replace invalid bytes
                data = raw.decode("utf-8", errors="replace")
    except Exception:
        data = ""

    data = (data or "").strip()
    if data:
        return json.loads(data)

    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])

    return {}


def _ensure_dir(p: str) -> str:
    Path(p).mkdir(parents=True, exist_ok=True)
    return p


def _make_llm(provider: str, model: str, temperature: float | None, base_url: str | None):
    provider = (provider or "openai").strip().lower()

    if provider == "anthropic":
        from browser_use import ChatAnthropic

        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        return ChatAnthropic(
            model=model or "claude-3-5-sonnet-20240620",
            api_key=api_key,
            temperature=temperature,
            base_url=base_url or os.getenv("ANTHROPIC_BASE_URL") or None,
        )

    # default: openai
    from browser_use import ChatOpenAI

    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return ChatOpenAI(
        model=model or "gpt-4o",
        api_key=api_key,
        temperature=temperature if temperature is not None else 0.2,
        base_url=base_url or os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_ENDPOINT") or None,
    )


async def _run(req: dict) -> dict:
    task = (req.get("task") or "").strip()
    if not task:
        raise RuntimeError("Missing 'task'")

    provider = (req.get("llm_provider") or os.getenv("BROWSER_USE_LLM_PROVIDER") or "openai").strip().lower()
    model = (req.get("llm_model") or os.getenv("BROWSER_USE_LLM_MODEL") or "").strip()
    temperature = req.get("temperature", None)
    base_url = (req.get("base_url") or "").strip() or None
    max_steps = int(req.get("max_steps") or 25)
    headless = bool(req.get("headless", True))
    use_vision = bool(req.get("use_vision", False))
    screenshot = bool(req.get("screenshot", False))
    screenshot_full_page = bool(req.get("screenshot_full_page", False))
    executable_path = (req.get("executable_path") or "").strip() or None
    user_data_dir = (req.get("user_data_dir") or "").strip() or None

    output_dir = _ensure_dir(req.get("output_dir") or str(Path.cwd() / "data" / "browser_use"))
    screenshot_path = str(Path(output_dir) / "last.png")

    from browser_use import Agent
    from browser_use.browser.session import BrowserSession

    llm = _make_llm(provider=provider, model=model, temperature=temperature, base_url=base_url)
    browser_session = BrowserSession(
        headless=headless,
        downloads_path=output_dir,
        executable_path=executable_path,
        user_data_dir=user_data_dir,
    )

    # Redirect any noisy prints from browser-use to stderr so stdout remains JSON-only.
    with contextlib.redirect_stdout(sys.stderr):
        await browser_session.start()

        try:
            agent = Agent(
                task=task,
                llm=llm,
                browser_session=browser_session,
                use_vision=use_vision,
            )

            history = await agent.run(max_steps=max_steps)

            final_result = history.final_result()
            errors = history.errors()

            errors_list = []
            if isinstance(errors, list):
                errors_list = errors
            elif errors:
                errors_list = [errors]

            has_errors = any(e not in (None, "", []) for e in errors_list)

            # Provide a simple string error for callers.
            # browser-use can return complex objects; normalize to strings.
            err_strings: list[str] = []
            for e in errors_list:
                if e in (None, "", []):
                    continue
                try:
                    err_strings.append(e if isinstance(e, str) else str(e))
                except Exception:
                    err_strings.append(repr(e))
            error_summary = "; ".join([s for s in err_strings if s]) if err_strings else None
            if not error_summary and final_result is None:
                error_summary = "No final_result returned by agent."

            result = {
                "success": not has_errors and final_result is not None,
                "final_result": final_result if isinstance(final_result, (str, int, float, bool)) or final_result is None else str(final_result),
                "errors": errors if isinstance(errors, (str, int, float, bool, list, dict)) or errors is None else str(errors),
                "error": error_summary,
            }

            if screenshot:
                try:
                    await browser_session.take_screenshot(
                        path=screenshot_path,
                        full_page=screenshot_full_page,
                        format="png",
                    )
                    result["screenshot_path"] = screenshot_path
                except Exception as e:
                    result["screenshot_error"] = str(e)

            return result
        finally:
            # Always close/kill the session to avoid orphaned browsers.
            try:
                await browser_session.kill()
            except Exception:
                pass


def main() -> None:
    try:
        req = _read_request()
        out = asyncio.run(_run(req))
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        sys.stdout.write(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

