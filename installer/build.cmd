@echo off
setlocal
pushd "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set GAC=%WINDIR%\Microsoft.NET\assembly
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319

if not exist "%CSC%" (
  echo ERROR: csc.exe not found. This builder needs .NET Framework 4.x.
  exit /b 1
)

"%CSC%" /nologo /codepage:65001 /target:winexe /platform:anycpu ^
  /out:"%~dp0HyperContext-Setup.exe" ^
  /win32manifest:"%~dp0app.manifest" ^
  /win32icon:"%~dp0icon.ico" ^
  /resource:"%~dp0HyperContextSetup.xaml",HyperContextSetup.xaml ^
  /r:"%FW%\System.dll" ^
  /r:"%GAC%\GAC_MSIL\System.Net.Http\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Net.Http.dll" ^
  /r:"%GAC%\GAC_MSIL\System.IO.Compression\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.dll" ^
  /r:"%GAC%\GAC_MSIL\System.IO.Compression.FileSystem\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.FileSystem.dll" ^
  /r:"%GAC%\GAC_MSIL\PresentationFramework\v4.0_4.0.0.0__31bf3856ad364e35\PresentationFramework.dll" ^
  /r:"%GAC%\GAC_64\PresentationCore\v4.0_4.0.0.0__31bf3856ad364e35\PresentationCore.dll" ^
  /r:"%GAC%\GAC_MSIL\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll" ^
  /r:"%GAC%\GAC_MSIL\System.Xaml\v4.0_4.0.0.0__b77a5c561934e089\System.Xaml.dll" ^
  "%~dp0HyperContextSetup.cs"

if errorlevel 1 (
  echo BUILD FAILED
  popd
  exit /b 1
)

echo.
echo Built: %~dp0HyperContext-Setup.exe
popd
endlocal
