@echo off
echo Switching to Production Environment...

REM Copy production environment variables to .env
if exist ".env.prod" (
    copy /Y .env.prod .env
    echo Environment set to Production.
) else (
    echo .env.prod not found. Please create it first.
    exit /b 1
)

echo Done.
