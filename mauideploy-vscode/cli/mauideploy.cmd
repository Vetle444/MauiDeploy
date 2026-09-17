@echo off
setlocal
if not defined MAUIDEPLOY_NODE exit /b 1
if not defined MAUIDEPLOY_CLI exit /b 1
set ELECTRON_RUN_AS_NODE=1
"%MAUIDEPLOY_NODE%" "%MAUIDEPLOY_CLI%" %*