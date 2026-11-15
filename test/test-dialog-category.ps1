<#
  dsh-screenshot-capture · 弹窗「类目下拉」回传的回归测试

  验什么:
    用户在弹窗里选了一个具体类目(比如「学习资料」),这个选择必须真的
    从 Show-CaptureDialog 返回出来 —— 它会经 choice 事件传给 Node 侧,
    由 core.mjs 的 decideCategory 用来跳过规则判定。

  为什么单独一个测试文件:
    这个 bug 只有**真点一次下拉**才看得见。2026-11-15 实测发现返回的
    category 永远是空串,原因在最后一行判断:

        if ($catBox.Visible -and $catBox.SelectedIndex -gt 0) { ... }

    $catBox.Visible 是**有效可见性** —— 它把自己和所有父容器的状态一起算。
    ShowDialog() 一返回,窗体就隐藏了,于是这个属性恒为 $false,用户选的
    类目被静默丢弃。

    纯读控件属性的测试抓不到它:那些测试在 Timer 里读控件时窗体还是可见的,
    $catBox.Visible 照样是 $true,断言全部通过 —— 而真实使用场景里窗体
    早就关了。所以这里必须让 ShowDialog 真的返回,再检查返回值。

  做法:
    抠出 Show-CaptureDialog 及其依赖函数,用 Timer 在窗内选中类目并点
    「存文档」,然后读返回值。

  用法: powershell -NoProfile -ExecutionPolicy Bypass -STA -File test\test-dialog-category.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\clip-dialog.ps1'
if (-not (Test-Path $scriptPath)) { throw "找不到 $scriptPath" }

$src = Get-Content -Raw -Encoding UTF8 $scriptPath
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

$script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsc-cat-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:tempDir -Force | Out-Null
$script:logPath = Join-Path $script:tempDir 'events.log'
$script:configPath = Join-Path $script:tempDir 'watcher-config.json'

foreach ($fn in @('Get-DialogLayout', 'Get-ZoomRect', 'Get-PointerPosition', 'Get-StatePath',
                  'Get-RememberedGeometry', 'Save-RememberedGeometry', 'Initialize-WheelBridge',
                  'Write-Event', 'Initialize-Skin', 'Draw-Header', 'Get-HeaderMeta',
                  'New-FlatButton', 'Initialize-KeyForm', 'Initialize-TitleBar')) {
  Invoke-Expression (Get-FnSource $src $fn)
}
$body = Get-FnSource $src 'Show-CaptureDialog'
Invoke-Expression $body

$script:PointerOverride = {
  # 优先挑一块**非主屏**：这些测试会真的弹窗，钉在主屏上就会打断用户。
  # 只有一块屏时才退回主屏（那时没得选）。
  $wa = (@([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary }) + @([System.Windows.Forms.Screen]::PrimaryScreen))[0].WorkingArea
  return (New-Object System.Drawing.Point(($wa.Left + 4), ($wa.Top + 4)))
}.GetNewClosure()

$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}

# 截图分类 = 0x622A 0x56FE 0x5206 0x7C7B
$dlgTitle = [string]([char]0x622A + [char]0x56FE + [char]0x5206 + [char]0x7C7B)

$cats = @('聊天记录', '梗图表情包', '学习资料', '时政新闻')
$tmp = Join-Path $script:tempDir 'sample.png'
$bmp = New-Object System.Drawing.Bitmap 400, 300
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(250, 250, 252))
$g.Dispose()
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 跑一次弹窗:选指定类目 -> 点「存文档」-> 返回结果。
function Run-Pick([string]$wantCategory, [bool]$classifyOn) {
  $script:config = @{
    offsetX = 60; offsetY = 60; previewMaxWidth = 320
    classifyEnabled = $classifyOn
    categories = $cats
  }
  $clock = @{ done = $false; picked = ''; err = ''; items = 0 }
  $t = New-Object System.Windows.Forms.Timer
  $t.Interval = 900
  $t.Add_Tick({
    if ($clock.done) { return }
    $clock.done = $true
    $t.Stop()
    try {
      $f = @([System.Windows.Forms.Application]::OpenForms | Where-Object { $_.Text -eq $dlgTitle }) | Select-Object -First 1
      if (-not $f) { $clock.err = 'no form'; return }
      $combo = $null; $docBtn = $null
      foreach ($c in $f.Controls) {
        if ($c -is [System.Windows.Forms.ComboBox]) { $combo = $c }
        if ($c -is [System.Windows.Forms.Button] -and $c.Text -eq '存文档') { $docBtn = $c }
      }
      if ($combo) {
        $clock.items = $combo.Items.Count
        $items = @(); foreach ($it in $combo.Items) { $items += [string]$it }
        $idx = [Array]::IndexOf($items, $wantCategory)
        if ($idx -ge 0) { $combo.SelectedIndex = $idx; $clock.picked = [string]$combo.SelectedItem }
      }
      [System.Windows.Forms.Application]::DoEvents()
      if ($docBtn) { $docBtn.PerformClick() } else { $clock.err = 'no doc button'; $f.Close() }
    } catch { $clock.err = "$_" }
  })

  $watchdog = New-Object System.Windows.Forms.Timer
  $watchdog.Interval = 15000
  $watchdog.Add_Tick({
    $watchdog.Stop()
    foreach ($w in @([System.Windows.Forms.Application]::OpenForms)) { try { $w.Close() } catch { } }
  })

  $res = $null
  try {
    $t.Start(); $watchdog.Start()
    $res = Show-CaptureDialog -ImagePath $tmp -AutoCloseMs 0
  } finally {
    $t.Dispose(); $watchdog.Dispose()
    $script:PointerOverride = $null
  }
  return @{ result = $res; picked = $clock.picked; items = $clock.items; err = $clock.err }
}

# --- 1. 选了具体类目,必须原样回传 -------------------------------------------
$r1 = Run-Pick '学习资料' $true
Check '选了类目能拿到返回对象' ($null -ne $r1.result) "err=$($r1.err)"
if ($r1.result) {
  Check '选中「学习资料」后被带出来了' ($r1.picked -eq '学习资料') "实际选中 [$($r1.picked)]"
  Check '返回的 category 是「学习资料」' ($r1.result.category -eq '学习资料') "实际 [$($r1.result.category)]"
  Check '返回的 action 是 doc' ($r1.result.action -eq 'doc') "实际 [$($r1.result.action)]"
}
Check '下拉项数 = 自动 + 4 个类目' ($r1.items -eq 5) "实际 $($r1.items)"

# --- 2. 默认停在「自动」,必须回传空串(交给宿主按 OCR 判) --------------------
# 这条防的是「把默认项也当类目传出去」——那样所有截图都会被硬判成第一个类目。
$r2 = Run-Pick '__不选__' $true
Check '不选类目时能拿到返回对象' ($null -ne $r2.result) "err=$($r2.err)"
if ($r2.result) {
  Check '默认「自动」时 category 是空串' ($r2.result.category -eq '') "实际 [$($r2.result.category)]"
}

# --- 3. 分类关掉时下拉不存在,也必须是空串 -----------------------------------
$r3 = Run-Pick '学习资料' $false
Check '分类关掉时能拿到返回对象' ($null -ne $r3.result) "err=$($r3.err)"
if ($r3.result) {
  Check '分类关掉时 category 是空串' ($r3.result.category -eq '') "实际 [$($r3.result.category)]"
}
Check '分类关掉时下拉没有选项' ($r3.items -eq 0) "实际 $($r3.items)"

# --- 4. 源码层:不能用 $catBox.Visible 判断「分类开没开」 --------------------
# 这是本 bug 的根因。写死这条断言,免得以后有人"顺手"改回去 —— 改回去之后
# 上面 1 号用例会失败,但只改这一个文件的人可能看不到那个测试。
Check '不用 $catBox.Visible 判断分类开关' (-not $body.Contains('if ($catBox.Visible -and')) '又用回了有效可见性'
Check '用独立标志 $catEnabled 判断' ($body.Contains('if ($catEnabled -and')) '缺 $catEnabled 判断'

if ($fail -eq 0) { '[dialog-category] 全部通过' } else { "[dialog-category] 失败 $fail 项"; exit 1 }
