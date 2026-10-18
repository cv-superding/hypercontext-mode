$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][W2]::SetProcessDPIAware()
$exe = Join-Path $PSScriptRoot "HyperContext-Setup.exe"
$p = Start-Process -FilePath $exe -PassThru
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  $p.Refresh()
  if ($p.MainWindowHandle -ne 0) { break }
}
$h = [IntPtr]$p.MainWindowHandle
$wshell = New-Object -ComObject WScript.Shell
[void]$wshell.AppActivate($p.Id)
Start-Sleep -Seconds 1
$r = New-Object W2+RECT
[void][W2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [W2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) {
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hh))
  $g2.Dispose()
}
$bmp.Save((Join-Path $PSScriptRoot "window.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Stop-Process -Id $p.Id -Force
Write-Output ("saved=" + (Join-Path $PSScriptRoot "window.png") + " printwindow=" + $ok + " size=" + $w + "x" + $hh)
