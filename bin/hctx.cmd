@echo off
setlocal
if exist "%~dp0..\.tools\node\node.exe" (
  "%~dp0..\.tools\node\node.exe" "%~dp0hctx.mjs" %*
) else (
  node "%~dp0hctx.mjs" %*
)
