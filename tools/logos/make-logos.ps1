# 144x144 PNG logo generator for WeChat mini program registration
# owner: blue bg + white house cradled by hands (寓意守护业主的家)
# staff: teal bg + white clipboard (低矮夹子) + lines + check (工单 theme)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$outDir = $PSScriptRoot

function Add-RoundedRect {
    param([System.Drawing.Drawing2D.GraphicsPath]$Path, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$R)
    $d = $R * 2
    $Path.AddArc($X,           $Y,           $d, $d, 180, 90)
    $Path.AddArc($X + $W - $d, $Y,           $d, $d, 270, 90)
    $Path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0,   90)
    $Path.AddArc($X,           $Y + $H - $d, $d, $d, 90,  90)
    $Path.CloseFigure()
}

function Save-Logo {
    param(
        [string]$OutPath,
        [int]$Br, [int]$Bg, [int]$Bb,
        [string]$Kind
    )

    $size = 144
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $bgColor = [System.Drawing.Color]::FromArgb(255, $Br, $Bg, $Bb)
    $bgBrush = New-Object System.Drawing.SolidBrush -ArgumentList $bgColor
    $whiteBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::White)

    # rounded square background, corner radius 28
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect -Path $bgPath -X 0 -Y 0 -W 144 -H 144 -R 28
    $g.FillPath($bgBrush, $bgPath)
    $bgPath.Dispose()

    if ($Kind -eq 'owner') {
        # house body (smaller, sits in the cup formed by the hands)
        # roof triangle
        $roof = New-Object System.Drawing.Drawing2D.GraphicsPath
        $roof.AddLine(72, 24, 32, 56)
        $roof.AddLine(32, 56, 112, 56)
        $roof.CloseFigure()
        $g.FillPath($whiteBrush, $roof)
        $roof.Dispose()

        # house body
        $g.FillRectangle($whiteBrush, 44, 52, 56, 30)
        # door cutout
        $g.FillRectangle($bgBrush, 66, 66, 12, 16)
        # two small windows
        $g.FillRectangle($bgBrush, 51, 60, 8, 6)
        $g.FillRectangle($bgBrush, 85, 60, 8, 6)

        # cradling hands: TWO clearly separate palm shapes meeting at bottom center,
        # each with a thumb bump on the outer rim
        # narrower bowl: bbox (20, 64, 104, 60)
        $cup = New-Object System.Drawing.Drawing2D.GraphicsPath
        $cup.AddArc(20, 64, 104, 60, 0, 180)
        # current at (20, 94), draw top with V-notch
        $cup.AddLine(20, 94, 60, 94)
        $cup.AddLine(60, 94, 72, 106)  # dip
        $cup.AddLine(72, 106, 84, 94)
        $cup.AddLine(84, 94, 124, 94)
        $cup.CloseFigure()
        $g.FillPath($whiteBrush, $cup)
        $cup.Dispose()

        # left thumb (small ellipse on left rim, peeking up like a thumb)
        $g.FillEllipse($whiteBrush, 10, 78, 22, 22)
        # right thumb
        $g.FillEllipse($whiteBrush, 112, 78, 22, 22)

        # narrow gap (bg) under house base to separate house from hands visually
        $g.FillRectangle($bgBrush, 44, 82, 56, 4)
    }
    else {
        # clipboard paper (rounded rect)
        $paper = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-RoundedRect -Path $paper -X 36 -Y 38 -W 72 -H 80 -R 8
        $g.FillPath($whiteBrush, $paper)
        $paper.Dispose()

        # short clip on top (only protrudes 6px, no longer battery-like)
        $clip = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-RoundedRect -Path $clip -X 60 -Y 32 -W 24 -H 10 -R 3
        $g.FillPath($whiteBrush, $clip)
        $clip.Dispose()

        # three lines on paper (bg color)
        $g.FillRectangle($bgBrush, 50, 58, 44, 6)
        $g.FillRectangle($bgBrush, 50, 74, 44, 6)
        $g.FillRectangle($bgBrush, 50, 90, 30, 6)

        # check mark (warm orange #FB923C)
        $checkColor = [System.Drawing.Color]::FromArgb(255, 251, 146, 60)
        $checkPen = New-Object System.Drawing.Pen -ArgumentList $checkColor, ([single]6)
        $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawLine($checkPen, 82, 100, 90, 108)
        $g.DrawLine($checkPen, 90, 108, 104, 90)
        $checkPen.Dispose()
    }

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $bgBrush.Dispose()
    $whiteBrush.Dispose()
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "  generated: $OutPath"
}

Write-Host "rendering logos to $outDir ..."
# owner: friendly blue #2563EB
Save-Logo -OutPath (Join-Path $outDir 'logo-owner.png') -Br 37 -Bg 99 -Bb 235 -Kind 'owner'
# staff: deep teal #0F766E
Save-Logo -OutPath (Join-Path $outDir 'logo-staff.png') -Br 15 -Bg 118 -Bb 110 -Kind 'staff'
Write-Host "done."
