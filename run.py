"""실행 진입점: `python run.py` 또는 빌드된 cmmAuto.exe.

[--host 0.0.0.0] [--port 8000] [--no-browser]
"""
from __future__ import annotations

import argparse
import threading
import time
import webbrowser

import uvicorn

# uvicorn.run에 문자열("app.main:app") 대신 앱 객체를 직접 넘기기 위한 명시적 import.
# PyInstaller의 정적 분석이 app 패키지를 찾아 번들에 포함하도록 하는 목적도 겸한다.
import app.main as app_main


def _open_browser_later(url: str, delay: float = 1.5) -> None:
    def _job() -> None:
        time.sleep(delay)
        webbrowser.open(url)

    threading.Thread(target=_job, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="cmmAuto 차트 뷰어 서버")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="시작 시 브라우저 자동 실행 안 함")
    args = parser.parse_args()

    if not args.no_browser:
        display_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
        _open_browser_later(f"http://{display_host}:{args.port}/")

    uvicorn.run(app_main.app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
