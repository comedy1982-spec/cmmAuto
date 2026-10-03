@echo off
REM cmmAuto 차트 뷰어 서버 실행 스크립트 (Windows 전용, 소스 그대로 실행)
REM 사용법: 프로젝트 폴더에서 run.bat 더블클릭, 또는 run.bat --port 9000 처럼 인자 전달

setlocal

where python >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=python"
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON=py"
    ) else (
        echo Python이 설치되어 있지 않거나 PATH에 등록되어 있지 않습니다.
        echo https://www.python.org/downloads/ 에서 Python 3.11 또는 3.12를 설치한 뒤,
        echo 설치 화면 하단의 "Add python.exe to PATH"를 반드시 체크해 주세요.
        pause
        exit /b 1
    )
)

echo [1/2] 의존성 확인 중...
%PYTHON% -m pip install -q -r requirements.txt
if errorlevel 1 goto :error

echo.
echo [2/2] cmmAuto 서버 실행 중... 브라우저가 자동으로 열립니다.
echo       서버를 멈추려면 이 창에서 Ctrl+C를 누르세요.
echo.
%PYTHON% run.py %*
goto :end

:error
echo.
echo 의존성 설치 중 오류가 발생했습니다. 위 로그를 확인해 주세요.
pause
exit /b 1

:end
echo.
echo 서버가 종료되었습니다.
pause
endlocal
