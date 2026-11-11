# Draws the app icon: a dark rounded square with a white "g". Writes build/icon.png, build/icon.ico
# and electron/icon.png. Run it again only if the design changes; the outputs are committed.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.TextRenderingHint = 'AntiAliasGridFit'
$graphics.Clear([System.Drawing.Color]::Transparent)

$radius = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
$path.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
$path.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()
$graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#161616'))), $path)

$font = New-Object System.Drawing.Font 'Consolas', 150, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = 'Center'
$format.LineAlignment = 'Center'
$graphics.DrawString('g', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, -8, $size, $size), $format)
$graphics.Dispose()

New-Item -ItemType Directory -Force (Join-Path $root 'build') | Out-Null
$png = Join-Path $root 'build\icon.png'
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Copy-Item $png (Join-Path $root 'electron\icon.png') -Force

# An .ico can hold a PNG image directly (Windows Vista and later).
$bytes = [System.IO.File]::ReadAllBytes($png)
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22)
$writer.Write($bytes)
[System.IO.File]::WriteAllBytes((Join-Path $root 'build\icon.ico'), $stream.ToArray())
Write-Output 'icon written'
