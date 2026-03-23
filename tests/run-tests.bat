@echo off
echo ================================================
echo  Toody Automated Test Suite
echo ================================================
echo.
cd /d "%~dp0.."
npx playwright test --reporter=list
echo.
echo ================================================
echo  Tests complete. Run "npx playwright show-report"
echo  to open the full HTML report in your browser.
echo ================================================
pause
