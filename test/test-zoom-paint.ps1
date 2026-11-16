<#
  dsh-screenshot-capture · 「滚轮缩放 + 适应按钮」的像素级实测(进程内)

  和 test-dialog-zoom-calc.ps1 的区别:那个只验 Get-ZoomRect 的算术;
  这个验**整条链路真的通了** —— 真弹窗、真消息、真绘制,最后读画出来的像素。

  为什么非要读像素:
    「滚轮没反应」有两种完全不同的原因 —— ①消息没送到消息过滤器
    ②消息送到了但没重画(Paint 没接上 / Invalidate 没调)。只验「窗口还活着」
    区分不了这两种,只有看像素才知道。

  为什么不 spawn 真进程(像 test-live-resize.ps1 那样):
    那条路要先往剪贴板塞图;在有进程占着剪贴板的环境里 OpenClipboard 会一直失败。
    进程内直接 Show-CaptureDialog -ImagePath 就绕开了剪贴板。

  测法:
    造一张左半红、右半蓝的图(2:1)。自动尺寸下预览框恰好也是 2:1,所以
    「铺满」(cover)和「装进去」(contain)在这个框里是同一个东西 —— 滚轮
    那几条断言验的是消息链路,不是语义。
      · Zoom=1 → 框里 95% 宽处 = 蓝
      · 在框**左缘**往上滚 5 格(1.15^5 ≈ 2 倍) → 锚点钉在左缘,框里只剩图左半 = 红
      · 点「适应」 → 回到 1 倍 → 又是蓝

    然后把窗**拉成竖的**(420x640),这时框比图高得多,cover 和 contain 就
    彻底分开了 —— 这是唯一能真正证明"图铺满了框"的断言:
      · cover:图被放大到盖满,靠近**顶边**的采样点仍是蓝
      · contain:图缩到整张装进框,上下留背景,同一采样点变成背景色
    (只验 95% 宽那条不够:cover 和 contain 在那儿都可能是蓝。)

  用法: powershell -NoProfile -ExecutionPolicy Bypass -File test\test-zoom-paint.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\clip-dialog.ps1'
if (-not (Test-Path $script)) { throw "找不到 $script" }
$src = Get-Content -Raw -Encoding UTF8 $script

function Get-FnSource([string]$text, [string]$name) {
  $head = "function $name"
  $start = $text.IndexOf($head)
  if ($start -lt 0) { throw "脚本里没有 $name" }
  $after = $text[$start + $head.Length]
  if ($after -ne '(' -and -not [char]::IsWhiteSpace($after) -and $after -ne '{') {
    throw "脚本里没有 $name(只匹配到前缀)"
  }
  $depth = 0
  $i = $text.IndexOf('{', $start)
  for (; $i -lt $text.Length; $i++) {
    if ($text[$i] -eq '{') { $depth++ }
    elseif ($text[$i] -eq '}') { $depth--; if ($depth -eq 0) { break } }
  }
  return $text.Substring($start, $i - $start + 1)
}

# 依赖:布局、指针、状态文件、缩放算术、消息桥,以及弹窗本体
Invoke-Expression (Get-FnSource $src 'Get-DialogLayout')
Invoke-Expression (Get-FnSource $src 'Get-ZoomRect')
Invoke-Expression (Get-FnSource $src 'Initialize-WheelBridge')
Invoke-Expression (Get-FnSource $src 'Get-PointerPosition')
Invoke-Expression (Get-FnSource $src 'Get-StatePath')
Invoke-Expression (Get-FnSource $src 'Get-RememberedGeometry')
Invoke-Expression (Get-FnSource $src 'Save-RememberedGeometry')
# 皮肤化之后 Show-CaptureDialog 又多了这几个调用(主题配色、头部信息条、扁平按钮、
# 键盘窗体、标题栏染色)。只抠 Show-CaptureDialog 而漏掉它们,弹窗一构造就报
# "Initialize-Skin 不是 cmdlet" —— 白名单没跟上源码,不是被测代码有问题。
# 顺序按依赖走:皮肤先定义,画头部和造按钮都吃它。
Invoke-Expression (Get-FnSource $src 'Initialize-Skin')
Invoke-Expression (Get-FnSource $src 'Draw-Header')
Invoke-Expression (Get-FnSource $src 'Get-HeaderMeta')
Invoke-Expression (Get-FnSource $src 'New-FlatButton')
Invoke-Expression (Get-FnSource $src 'Initialize-KeyForm')
Invoke-Expression (Get-FnSource $src 'Initialize-TitleBar')
Invoke-Expression (Get-FnSource $src 'Show-CaptureDialog')
Invoke-Expression (Get-FnSource $src 'Set-DialogImage')

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PaintProbe {
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}
function Test-Reddish($c) { return (($c.R -gt 150) -and ($c.G -lt 110) -and ($c.B -lt 110)) }
function Test-Blueish($c) { return (($c.B -gt 150) -and ($c.R -lt 110) -and ($c.G -lt 110)) }

# 把控件当前画出来的内容抓成位图 —— DrawToBitmap 走 WM_PRINT,
# UserPaint 控件里就是"再跑一遍 OnPaint",拿到的是真像素而不是我们推算的值。
function Get-PicSample($pic) {
  return Get-PicSampleAt $pic 0.95 0.5
}

# 按**相对位置**取一个像素:fx/fy 是 0..1 的比例。fy 取 0.02 时是"贴着框
# 顶边往下一点点" —— cover 下那里一定有图,contain 下那里一定是背景。
function Get-PicSampleAt($pic, [double]$fx, [double]$fy) {
  $bmp = New-Object System.Drawing.Bitmap $pic.Width, $pic.Height
  try {
    $pic.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle 0, 0, $pic.Width, $pic.Height))
    $x = [int](($pic.Width - 1) * $fx)
    $y = [int](($pic.Height - 1) * $fy)
    return $bmp.GetPixel($x, $y)
  } finally {
    $bmp.Dispose()
  }
}

$dlgTitle = [string]([char]0x622A + [char]0x56FE + [char]0x5206 + [char]0x7C7B)  # 截图分类
$btnFitText = [string]([char]0x9002 + [char]0x5E94)                                # 适应
$WM_MOUSEWHEEL = 0x020A

# 左半红、右半蓝的 2:1 图
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsc-zoom-' + [guid]::NewGuid().ToString('N') + '.png')
$bmp = New-Object System.Drawing.Bitmap 600, 300
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $bRed = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0, 0))
  $bBlue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 0, 255))
  $g.FillRectangle($bRed, 0, 0, 300, 300)
  $g.FillRectangle($bBlue, 300, 0, 300, 300)
  $bRed.Dispose(); $bBlue.Dispose()
} finally { $g.Dispose() }
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 弹窗读的是**脚本级** $config(不是参数,见 clip-dialog.ps1:94);测试只抠了函数、
# 没跑脚本顶层,所以这里得把缺的键补齐,否则弹窗里读 $config.positionMode 会得到 $null。
$config = @{
  pollIntervalMs = 200; cooldownMs = 2000
  positionMode = 'cursor'; fixedX = 0; fixedY = 0
  offsetX = 60; offsetY = 60
  previewMaxWidth = 360; width = 0; height = 0
  dupWindowMs = 6000; autoCloseSec = 0; statePath = ''
  # 主题显式写死 c1:Initialize-Skin 拿到空串会**静默**退回 c1,断言照样过,
  # 但那样"测的是哪套主题"就靠猜了。写死才能保证配色断言的前提是确定的。
  theme = 'c1'
}

# 指针模拟到屏幕左上角,窗口摆它右下,互不干扰(同 test-dialog-layout.ps1)
$script:PointerOverride = {
  # 优先挑一块**非主屏**：这些测试会真的弹窗，钉在主屏上就会打断用户。
  # 只有一块屏时才退回主屏（那时没得选）。
  $wa = (@([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary }) + @([System.Windows.Forms.Screen]::PrimaryScreen))[0].WorkingArea
  return (New-Object System.Drawing.Point(($wa.Left + 4), ($wa.Top + 4)))
}.GetNewClosure()

# 在弹窗还活着时把要验的事全做完,然后关窗。
$clock = @{ done = $false; results = @{} }
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 900
$t.Add_Tick({
  if ($clock.done) { return }
  $clock.done = $true
  $t.Stop()
  try {
    $f = @([System.Windows.Forms.Application]::OpenForms | Where-Object { $_.Text -eq $dlgTitle }) | Select-Object -First 1
    if (-not $f) { $clock.results.err = 'OpenForms 里没有「截图入库」'; return }

    $pic = @($f.Controls | Where-Object { $_.GetType().Name -eq 'PictureBox' })[0]
    $btnFit = @($f.Controls | Where-Object { $_.GetType().Name -eq 'Button' -and $_.Text -eq $btnFitText })[0]
    if (-not $pic) { $clock.results.err = '窗体里没有 PictureBox'; return }

    $clock.results.picW = $pic.Width
    $clock.results.picH = $pic.Height
    $clock.results.hasFitBtn = ($null -ne $btnFit)

    # ---- ① Zoom=1:95% 宽处应当是蓝 ----
    $c1 = Get-PicSample $pic
    $clock.results.c1 = "$($c1.R),$($c1.G),$($c1.B)"
    $clock.results.c1Blue = (Test-Blueish $c1)

    # ---- ② 在框左缘滚 5 格放大 ----
    $r = New-Object PaintProbe+RECT
    [void][PaintProbe]::GetWindowRect($pic.Handle, [ref]$r)
    $wx = $r.Left + 4
    $wy = [int](($r.Top + $r.Bottom) / 2)
    $lParam = ($wy -shl 16) -bor ($wx -band 0xFFFF)
    for ($i = 0; $i -lt 5; $i++) {
      [void][PaintProbe]::PostMessageW($pic.Handle, $WM_MOUSEWHEEL, [IntPtr](120 -shl 16), [IntPtr]$lParam)
      # 消息要真的被泵到才会进 Application 的消息过滤器 —— 所以得让 DoEvents 转几圈
      for ($k = 0; $k -lt 6; $k++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
      }
    }

    $c2 = Get-PicSample $pic
    $clock.results.c2 = "$($c2.R),$($c2.G),$($c2.B)"
    $clock.results.c2Red = (Test-Reddish $c2)

    # ---- ③ 点「适应」回到 1 倍 ----
    if ($btnFit) {
      $btnFit.PerformClick()
      for ($k = 0; $k -lt 8; $k++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
      }
      $c3 = Get-PicSample $pic
      $clock.results.c3 = "$($c3.R),$($c3.G),$($c3.B)"
      $clock.results.c3Blue = (Test-Blueish $c3)
    }

    # ---- ④ 再滚 5 格,然后双击预览图 —— 应当也回到 1 倍 ----
    for ($i = 0; $i -lt 5; $i++) {
      [void][PaintProbe]::PostMessageW($pic.Handle, $WM_MOUSEWHEEL, [IntPtr](120 -shl 16), [IntPtr]$lParam)
      for ($k = 0; $k -lt 6; $k++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
      }
    }
    $c4a = Get-PicSample $pic
    $clock.results.c4a = "$($c4a.R),$($c4a.G),$($c4a.B)"
    $clock.results.c4aRed = (Test-Reddish $c4a)

    # 双击 = 两次 MouseDown/Up 再双击消息。这里直接触发控件的 DoubleClick 事件,
    # 因为要验的是"处理器挂上了没有",不是 Win32 双击判定。
    $pic.GetType().GetMethod('OnDoubleClick', [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic).Invoke($pic, @([EventArgs]::Empty))
    for ($k = 0; $k -lt 8; $k++) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 20
    }
    $c4b = Get-PicSample $pic
    $clock.results.c4b = "$($c4b.R),$($c4b.G),$($c4b.B)"
    $clock.results.c4bBlue = (Test-Blueish $c4b)

    # ---- ⑤ 把窗拉成竖的:「铺满」和「装进去」在这里才分得开 --------------
    # 上面的框恰好 2:1(和图片同比例),cover 和 contain 是同一个结果,所以
    # 那几条验的是消息链路。把框拉高到远超图片比例之后:
    #   cover  → 图被放大到盖满,顶边附近当然是图(蓝)
    #   contain→ 图缩在中间,顶边附近是预览框的背景色
    # 这条是"图片有没有真的铺满预览空间"的唯一像素级证据。
    $clock.results.zoomBeforeTall = $null
    $f.ClientSize = New-Object System.Drawing.Size(376, 640)
    for ($k = 0; $k -lt 12; $k++) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 25
    }
    $clock.results.picWTall = $pic.Width
    $clock.results.picHTall = $pic.Height
    $clock.results.clientTall = "$($f.ClientSize.Width)x$($f.ClientSize.Height)"
    $top = Get-PicSampleAt $pic 0.95 0.02
    $mid = Get-PicSampleAt $pic 0.95 0.5
    $clock.results.topTall = "$($top.R),$($top.G),$($top.B)"
    $clock.results.midTall = "$($mid.R),$($mid.G),$($mid.B)"
    $clock.results.topTallIsImage = ((Test-Blueish $top) -or (Test-Reddish $top))
    $clock.results.topTallSameAsMid = ([Math]::Abs($top.R - $mid.R) -lt 30 -and
                                       [Math]::Abs($top.G - $mid.G) -lt 30 -and
                                       [Math]::Abs($top.B - $mid.B) -lt 30)

    $clock.results.alive = $f.Visible
  } catch {
    $clock.results.err = $_.Exception.Message
  } finally {
    $f2 = @([System.Windows.Forms.Application]::OpenForms | Where-Object { $_.Text -eq $dlgTitle }) | Select-Object -First 1
    if ($f2) { try { $f2.Close() } catch { } }
  }
})

# 兜底:万一 Timer 没跑成,15 秒后强制关掉所有窗体,别挂死
$watchdog = New-Object System.Windows.Forms.Timer
$watchdog.Interval = 15000
$watchdog.Add_Tick({
  $watchdog.Stop()
  foreach ($w in @([System.Windows.Forms.Application]::OpenForms)) { try { $w.Close() } catch { } }
})

try {
  $t.Start()
  $watchdog.Start()
  $null = Show-CaptureDialog -ImagePath $tmp -AutoCloseMs 0
} finally {
  $t.Dispose()
  $watchdog.Dispose()
  $script:PointerOverride = $null
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

$res = $clock.results
if ($res.err) { "FAIL 弹窗里执行出错 - $($res.err)"; exit 1 }

Check '抓到预览框并且尺寸合理' (($res.picW -ge 120) -and ($res.picH -ge 60)) "实际 $($res.picW)x$($res.picH)"
Check '窗口里有「适应」按钮' ([bool]$res.hasFitBtn) "没找到文本为 $btnFitText 的按钮"
Check 'Zoom=1 时 95% 宽处是蓝(整张图铺满框)' ([bool]$res.c1Blue) "RGB $($res.c1)"
Check '滚轮放大后 95% 宽处变红(锚点钉在左缘,只剩图左半)' ([bool]$res.c2Red) "RGB $($res.c2) —— 没变说明消息没送到或没重画"
Check '点「适应」后 95% 宽处又变回蓝' ([bool]$res.c3Blue) "RGB $($res.c3)"
Check '再滚 5 格又变红(说明不是只在第一次生效)' ([bool]$res.c4aRed) "RGB $($res.c4a)"
Check '双击预览图也回到适应' ([bool]$res.c4bBlue) "RGB $($res.c4b)"
Check '整轮下来窗口没崩' ([bool]$res.alive) '窗口不可见了'

# ---- 铺满 vs 装进去:把框拉高之后两者分道扬镳 ----------------------------
Check '拉高后预览框跟着长高' ($res.picHTall -gt $res.picH) "原来 $($res.picH),拉高后 $($res.picHTall)"
Check '拉高后贴近顶边的地方仍是图(说明图铺满了框,没有留背景边)' ([bool]$res.topTallIsImage) `
  "顶边采样 RGB $($res.topTall)（若是背景色说明图还是缩在中间）"
Check '拉高后顶边和中间是同一张图的不同部分' ([bool]$res.topTallSameAsMid) `
  "顶边 RGB $($res.topTall) / 中间 RGB $($res.midTall)"

# --- 换图重置缩放:直接单测 Set-DialogImage(弹窗内部的 $state 外面拿不到) ---
$st = [pscustomobject]@{ zoom = 4.0; panX = 120.0; panY = -80.0; path = ''; image = $null; refreshes = 0 }
$pb = New-Object System.Windows.Forms.PictureBox
$im1 = New-Object System.Drawing.Bitmap 40, 20
$im2 = New-Object System.Drawing.Bitmap 40, 20
try {
  Set-DialogImage -state $st -pic $pb -newImg $im1 -newPath 'a.png'
  Check '换图后 zoom 归 1' (($st.zoom -eq 1.0)) "实际 $($st.zoom)"
  Check '换图后 panX/panY 归 0' (($st.panX -eq 0.0) -and ($st.panY -eq 0.0)) "实际 $($st.panX)/$($st.panY)"
  Check '换图后 state.image 已是新图' ([object]::ReferenceEquals($st.image, $im1)) '还是旧图'
  Check '换图后 refreshes 计数 +1' ($st.refreshes -eq 1) "实际 $($st.refreshes)"
} finally {
  try { $pb.Image = $null } catch { }
  $pb.Dispose()
  try { $im2.Dispose() } catch { }
}

if ($fail -eq 0) { '[zoom-paint] 全部通过' } else { "[zoom-paint] 失败 $fail 项"; exit 1 }
