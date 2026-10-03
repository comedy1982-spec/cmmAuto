@echo off
REM cmmAuto.exe 빌드 스크립트 (Windows 전용)
REM 사용법: 프로젝트 폴더에서 build.bat 더블클릭 또는 실행

setlocal

echo [1/3] 빌드 도구 설치 중...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt -r requirements-build.txt
if errorlevel 1 goto :error

echo.
echo [2/3] 이전 빌드 결과 정리 중...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo.
echo [3/3] PyInstaller로 exe 빌드 중... (몇 분 걸릴 수 있습니다)
python -m PyInstaller cmmauto.spec
if errorlevel 1 goto :error

echo.
echo ================================================
echo  빌드 완료: dist\cmmAuto.exe
echo  실행하면 config.json / data 폴더가 exe와 같은
echo  위치에 자동으로 만들어집니다.
echo ================================================
goto :end

:error
echo.
echo 빌드 중 오류가 발생했습니다. 위 로그를 확인해 주세요.
exit /b 1

:end
endlocal
