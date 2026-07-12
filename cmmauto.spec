# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 스펙 파일.

Windows에서 실행하면 단일 실행 파일 dist/cmmAuto.exe 가 생성된다:

    pip install -r requirements.txt -r requirements-build.txt
    pyinstaller cmmauto.spec

리눅스/맥에서 실행하면 그 OS용 실행 파일이 나온다 (PyInstaller는 크로스 컴파일을 지원하지
않으므로, Windows용 .exe가 필요하면 반드시 Windows에서 빌드해야 한다).
"""

from pathlib import Path

root = Path(SPECPATH)

# ccxt는 거래소별 모듈을 __init__.py에서 정적으로 import 하므로 PyInstaller가 대부분
# 자동으로 찾아내지만, eth 서명용으로 딸려오는 coincurve의 cffi 네이티브 백엔드는
# 런타임 로딩 방식 때문에 놓칠 수 있어 명시적으로 지정한다.
hiddenimports = [
    "coincurve",
    "coincurve._cffi_backend",
]

a = Analysis(
    ["run.py"],
    pathex=[str(root)],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

# 정적 웹 자산(HTML/CSS/JS, lightweight-charts 번들)을 app/static 아래 그대로 포함
static_tree = Tree(str(root / "app" / "static"), prefix="app/static")

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas + static_tree,
    [],
    name="cmmAuto",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
