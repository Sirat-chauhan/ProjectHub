@echo off
:: Change directory to where the batch script is located
cd /d "%~dp0"

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [INFO] Administrator rights detected.
) else (
    echo ==========================================================
    echo ERROR: You must run this script as an Administrator!
    echo.
    echo Please right-click this file (install.bat) and select 
    echo "Run as Administrator".
    echo ==========================================================
    pause
    exit /b
)

:: Set paths relative to batch directory
set "SRC=%~dp0vector_temp"
set "DST=C:\Program Files\PostgreSQL\16"

echo Source path is: %SRC%
echo Destination path is: %DST%

:: Check if source exists, if not download it
if not exist "%SRC%" (
    echo [INFO] Downloading and extracting pgvector precompiled files...
    python -c "import urllib.request, zipfile, os; urllib.request.urlretrieve('https://github.com/andreiramani/pgvector_pgsql_windows/releases/download/0.8.2_16.1/vector.v0.8.2-pg16.zip', 'vector_pg16.zip'); zipfile.ZipFile('vector_pg16.zip', 'r').extractall('vector_temp'); os.remove('vector_pg16.zip')"
)

if not exist "%SRC%" (
    echo ERROR: Failed to download or extract pgvector files.
    pause
    exit /b
)

echo [INFO] Copying vector.dll to %DST%\lib...
copy /Y "%SRC%\lib\vector.dll" "%DST%\lib\"
if %errorLevel% neq 0 (
    echo ERROR: Failed to copy vector.dll. Make sure PostgreSQL is not running or file is locked.
    pause
    exit /b
)

echo [INFO] Copying extension files to %DST%\share\extension...
xcopy /E /Y /I "%SRC%\share\extension" "%DST%\share\extension"
if %errorLevel% neq 0 (
    echo ERROR: Failed to copy extension files.
    pause
    exit /b
)

echo [INFO] Copying header files to %DST%\include\server\extension\vector...
xcopy /E /Y /I "%SRC%\include\server\extension\vector" "%DST%\include\server\extension\vector"
if %errorLevel% neq 0 (
    echo WARNING: Failed to copy header files, but this is usually optional.
)

echo [INFO] Cleaning up temp files...
rmdir /S /Q "%SRC%"

echo.
echo ==========================================================
echo SUCCESS! pgvector has been successfully installed to PostgreSQL.
echo ==========================================================
pause
