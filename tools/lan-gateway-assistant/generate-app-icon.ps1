$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$resourceDir = Join-Path $PSScriptRoot "Resources"
$output = Join-Path $resourceDir "AppIcon.ico"
New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null

function New-RoundedRectanglePath([System.Drawing.RectangleF] $rect, [float] $radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $arc = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $diameter, $diameter)
    $path.AddArc($arc, 180, 90)
    $arc.X = $rect.Right - $diameter; $path.AddArc($arc, 270, 90)
    $arc.Y = $rect.Bottom - $diameter; $path.AddArc($arc, 0, 90)
    $arc.X = $rect.Left; $path.AddArc($arc, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconPng([int] $size) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scale = $size / 256.0
    $backgroundRect = New-Object System.Drawing.RectangleF -ArgumentList ([float](12*$scale)), ([float](12*$scale)), ([float](232*$scale)), ([float](232*$scale))
    $backgroundPath = New-RoundedRectanglePath $backgroundRect ([float](54*$scale))
    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF -ArgumentList ([float](30*$scale)), ([float](25*$scale))),
        (New-Object System.Drawing.PointF -ArgumentList ([float](226*$scale)), ([float](230*$scale))),
        ([System.Drawing.Color]::FromArgb(49, 95, 157)),
        ([System.Drawing.Color]::FromArgb(10, 143, 120)))
    $graphics.FillPath($gradient, $backgroundPath)

    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [Math]::Max(2, 14 * $scale))
    $whitePen.StartCap = $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $cloud = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cloud.AddBezier(80*$scale,157*$scale,55*$scale,158*$scale,35*$scale,145*$scale,38*$scale,120*$scale)
    $cloud.AddBezier(38*$scale,120*$scale,38*$scale,103*$scale,50*$scale,90*$scale,68*$scale,89*$scale)
    $cloud.AddBezier(68*$scale,89*$scale,76*$scale,62*$scale,99*$scale,45*$scale,126*$scale,46*$scale)
    $cloud.AddBezier(126*$scale,46*$scale,155*$scale,46*$scale,180*$scale,66*$scale,185*$scale,93*$scale)
    $cloud.AddBezier(185*$scale,93*$scale,206*$scale,96*$scale,221*$scale,113*$scale,219*$scale,132*$scale)
    $cloud.AddBezier(219*$scale,132*$scale,217*$scale,153*$scale,197*$scale,169*$scale,176*$scale,168*$scale)
    $graphics.DrawPath($whitePen, $cloud)

    $connectorRect = New-Object System.Drawing.RectangleF -ArgumentList ([float](74*$scale)), ([float](129*$scale)), ([float](108*$scale)), ([float](54*$scale))
    $connectorPath = New-RoundedRectanglePath $connectorRect ([float](16*$scale))
    $graphics.FillPath([System.Drawing.Brushes]::White, $connectorPath)
    $graphics.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(49,95,157))), 94*$scale, 146*$scale, 20*$scale, 20*$scale)
    $graphics.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(10,143,120))), 142*$scale, 146*$scale, 20*$scale, 20*$scale)
    $linkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(23,59,104), [Math]::Max(2, 10*$scale))
    $linkPen.StartCap = $linkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($linkPen, 114*$scale, 156*$scale, 142*$scale, 156*$scale)

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Dispose(); $linkPen.Dispose(); $whitePen.Dispose(); $cloud.Dispose(); $connectorPath.Dispose(); $gradient.Dispose(); $backgroundPath.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    return ,$bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @($sizes | ForEach-Object { New-IconPng $_ })
[System.IO.File]::WriteAllBytes((Join-Path $resourceDir "AppIcon.png"), $images[$images.Count - 1])
$headerSize = 6 + (16 * $sizes.Count)
$offset = $headerSize
$stream = [System.IO.File]::Create($output)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension); $writer.Write([Byte]0); $writer.Write([Byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$images[$i].Length); $writer.Write([UInt32]$offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write($image) }
$writer.Dispose(); $stream.Dispose()
Write-Host "已生成：$output" -ForegroundColor Green
