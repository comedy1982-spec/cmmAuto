"""실행 환경별 경로 해석.

일반 `python run.py` 실행과 PyInstaller로 얼린 단일 exe 실행을 모두 지원한다.

- BASE_DIR: config.json / data/ 처럼 사용자가 편집·보존해야 하는 파일의 위치.
  exe로 얼린 경우 exe가 있는 폴더, 아니면 저장소 루트.
- BUNDLE_DIR: 정적 웹 자산처럼 읽기 전용으로 함께 배포되는 리소스의 위치.
  exe로 얼린 경우 PyInstaller가 압축을 풀어둔 임시 폴더(sys._MEIPASS), 아니면 저장소 루트.
"""
from __future__ import annotations

import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))

if FROZEN:
    BASE_DIR = Path(sys.executable).resolve().parent
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    BUNDLE_DIR = BASE_DIR
