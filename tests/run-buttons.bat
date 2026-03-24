@echo off
echo Checking all buttons...
npx playwright test tests/buttons.spec.js --reporter=line
if %ERRORLEVEL% NEQ 0 (
  echo BUTTON TEST FAILED - Fix before deploying
  pause
  exit /b 1
)
echo All buttons responsive - safe to deploy
pause
