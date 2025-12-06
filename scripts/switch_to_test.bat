@echo off
echo Switching to Test Environment...

REM Copy test environment variables to .env
if exist ".env.test" (
    copy /Y .env.test .env
    echo Environment set to Test.
) else (
    echo .env.test not found. Please create it first.
    exit /b 1
)

REM Optional: Restart backend if running via PM2 or similar
REM pm2 restart vesting-backend

echo Done.
