$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$navy = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 18, 32))
$blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

$outer = New-RoundedPath 28 28 968 968 210
$g.FillPath($navy, $outer)
$inner = New-RoundedPath 168 168 688 688 150
$g.FillPath($blue, $inner)

$g.FillRectangle($white, 330, 300, 84, 424)
$g.FillRectangle($white, 610, 300, 84, 424)
$g.FillRectangle($white, 330, 470, 364, 84)

$g.Dispose()
$bmp.Save((Join-Path $PSScriptRoot "icon-1024.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$src = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot "icon-1024.png"))
$small = New-Object System.Drawing.Bitmap 256, 256
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.DrawImage($src, 0, 0, 256, 256)
$g2.Dispose()
$small.Save((Join-Path $PSScriptRoot "icon-256.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$src.Dispose()

Write-Output "icons written"
