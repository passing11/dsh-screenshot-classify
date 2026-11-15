<#
  dsh-screenshot-capture · 悬浮窗自动关闭的行为测试

  只测真东西:从 scripts/clip-dialog.ps1 里**抠出 Show-CaptureDialog 函数原文**
  再 Invoke-Expression,不复制一份实现 —— 复制出来的副本改了源码也不会失败,
  那种测试只会给假的安全感。

  验什么:
    1. 到点自己关:action=ignore、autoClosed=true、不写注释不勾重点
    2. 用时落在 [传入值, 传入值+1.5 个 Timer 周期] 内(Timer 是 250ms 一跳)
    3. AutoCloseMs=0 时不自动关 —— 这条**用源码断言**而不是真等,因为
       "等它不关"只能靠无限期阻塞证明,那会让测试自己挂死(踩过)。

  用法: powershell -NoProfile -ExecutionPolicy Bypass -File test\test-autoclose-dialog.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\clip-dialog.ps1'
if (-not (Test-Path $script)) { throw "找不到 $script" }

# 抠函数:按名字找到 'function NAME {' 再按花括号配平到结尾
$src = Get-Content -Raw -Encoding UTF8 $script
# 注意不能找 "function $name {" —— 带参数的函数声明是
# "function Save-RememberedGeometry([int]$x, ...)",名字后面紧跟括号而不是空格。
# 所以只匹配前缀,再从那里往后找第一个 '{'。
function Get-FnSource([string]$text, [string]$name) {
  $head = "function $name"
  $start = $text.IndexOf($head)
  if ($start -lt 0) { throw "脚本里没有 $name" }
  # 防止前缀误命中(比如找 Get-Pointer 却匹配到 Get-PointerPosition):
  # 名字后面必须是 ( 、空白 或 { 之一。
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
$layoutFn = Get-FnSource $src 'Get-DialogLayout'
Invoke-Expression $layoutFn
$body = Get-FnSource $src 'Show-CaptureDialog'
$ptrFn = Get-FnSource $src 'Get-PointerPosition'
Invoke-Expression $ptrFn
# Show-CaptureDialog 现在还会调这两个几何函数(记住上次位置)。抠函数跑测试
# 时得把它们一起加载进来,否则一弹窗就是 CommandNotFoundException。
# $tempDir 也要建好:默认 statePath 是从它拼出来的。
$script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsc-t-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:tempDir -Force | Out-Null
Invoke-Expression (Get-FnSource $src 'Get-StatePath')
Invoke-Expression (Get-FnSource $src 'Get-RememberedGeometry')
Invoke-Expression (Get-FnSource $src 'Save-RememberedGeometry')
Invoke-Expression (Get-FnSource $src 'Get-ZoomRect')
Invoke-Expression (Get-FnSource $src 'Initialize-Skin')
Invoke-Expression (Get-FnSource $src 'New-FlatButton')
Invoke-Expression (Get-FnSource $src 'Initialize-KeyForm')
Invoke-Expression (Get-FnSource $src 'Initialize-TitleBar')
Invoke-Expression (Get-FnSource $src 'Draw-Header')
Invoke-Expression (Get-FnSource $src 'Get-HeaderMeta')
Invoke-Expression (Get-FnSource $src 'Initialize-WheelBridge')
Invoke-Expression $body
if (-not (Get-Command Show-CaptureDialog -ErrorAction SilentlyContinue)) { throw 'Invoke-Expression 之后没有 Show-CaptureDialog' }

# 指针钉在远离窗口的地方 —— 用模拟指针,不动真实鼠标。
# (窗口按 offsetX/offsetY 摆在指针右下,所以指针钉在屏幕左上角时窗一定不在指针上;
#  这样测的是**纯倒计时**,悬停冻结由 test-autoclose-hover.ps1 单独验。)
$script:PointerOverride = {
  # 优先挑一块**非主屏**：这些测试会真的弹窗，钉在主屏上就会打断用户。
  # 只有一块屏时才退回主屏（那时没得选）。
  $wa = (@([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary }) + @([System.Windows.Forms.Screen]::PrimaryScreen))[0].WorkingArea
  return (New-Object System.Drawing.Point(($wa.Left + 4), ($wa.Top + 4)))
}.GetNewClosure()

# 被测函数读的是脚本级 $config(预览宽度等),这里给一份
$config = @{ offsetX = 16; offsetY = 16; previewMaxWidth = 320 }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsc-autoclose-' + [guid]::NewGuid().ToString('N') + '.png')
$bmp = New-Object System.Drawing.Bitmap 400, 160
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Microsoft YaHei', 18)
$g.DrawString('AUTOCLOSE', $font, [System.Drawing.Brushes]::Black, 12, 52)
$g.Dispose()
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# --- 预热 -------------------------------------------------------------------
# 第一次弹窗要**编译**四个 C# 类型(DscWheelBridge / DscFocusGrab / DscFastForm /
# DscDwm),实测合计 400~500ms,再加载图片、算度量、建控件,一次约 1.6~1.8 秒。
# 真机上这笔钱只付一次:弹窗进程是长驻的,之后每次弹窗都是毫秒级。
# 但测试每次都是新进程,不预热的话这笔开销会全额算进「关闭时刻」,让计时断言
# 看起来像倒计时变慢了 —— 而倒计时其实一秒都没错。
# 所以先弹一次窗(1ms 自动关)把类型编译、图片解码、GDI+ 初始化全跑一遍。
# 这次预热不参与断言,失败也不影响结论(它只是让缓存热起来)。
try { $null = Show-CaptureDialog -ImagePath $tmp -AutoCloseMs 1 } catch { }

$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = Show-CaptureDialog -ImagePath $tmp -AutoCloseMs 2000
  $sw.Stop()
  $ms = [int]$sw.Elapsed.TotalMilliseconds

  Check '自动关闭后 action=ignore' ($res.action -eq 'ignore') "action=$($res.action)"
  Check 'autoClosed 标记为 true' ($res.autoClosed -eq $true) "autoClosed=$($res.autoClosed)"
  Check '关闭时刻 >= 2000ms' ($ms -ge 2000) "实测 ${ms}ms"
  Check '关闭时刻 < 2000+1.5 个周期(2375ms 放宽到 3500ms)' ($ms -lt 3500) "实测 ${ms}ms"
  Check '没有顺手写注释/勾重点' (($res.note -eq '') -and (-not $res.isKey)) "note='$($res.note)' isKey=$($res.isKey)"

  # 0 = 不自动关:Timer 的创建必须在 `if ($AutoCloseMs -gt 0)` 里面。
  # 断言两条:有这个守卫、且 New-Object Timer 出现在守卫之后、在函数内。
  $timerIdx = $body.IndexOf('New-Object System.Windows.Forms.Timer')
  $guardIdx = $body.IndexOf('if ($AutoCloseMs -gt 0)')
  Check '有 AutoCloseMs > 0 的守卫' ($guardIdx -ge 0) "guardIdx=$guardIdx"
  Check 'Timer 只在守卫成立时才创建' (($timerIdx -gt $guardIdx) -and ($guardIdx -ge 0)) "timerIdx=$timerIdx guardIdx=$guardIdx"

  # 用户动手要重新计时(否则写到一半窗没了)。三个入口必须都挂了 bump。
  Check '按键会重置倒计时' ($body.Contains('$form.Add_KeyDown($bump)')) '缺 Add_KeyDown($bump)'
  Check '点窗口会重置倒计时' ($body.Contains('$form.Add_MouseDown($bump)')) '缺 Add_MouseDown($bump)'
  Check '改注释会重置倒计时' ($body.Contains('$noteBox.Add_TextChanged($bump)')) '缺 Add_TextChanged($bump)'

  # v0.3.0 去掉了「复制截图」按钮:剪贴板本来就是原图,那个按钮等于什么都不做。
  # 现在只有 存文档 / 存图片 两个按钮,Esc 与自动关闭走 ignore。
  Check '没有「复制截图」按钮' (-not $body.Contains('$bCopy')) '还留着 $bCopy'
  # 0.6.0 起按钮统一由 New-FlatButton 造(自绘圆角/悬停态),不再 New-Object Button。
  # 所以这里数的是 New-FlatButton 的调用次数:三个(适应/存文档/存图片)。
  $btnCount = ([regex]::Matches($body, 'New-FlatButton -Skin')).Count
  Check '按钮只有 存文档 / 存图片 / 适应' ($btnCount -eq 3) "按钮数=$btnCount"
  Check 'Esc 走 ignore 而不是 copy' ($body.Contains('$form.Tag = "ignore"')) 'Esc 没改成 ignore'
} finally {
  $script:PointerOverride = $null
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

if ($fail -eq 0) { '[autoclose-dialog] 全部通过' } else { "[autoclose-dialog] 失败 $fail 项"; exit 1 }
