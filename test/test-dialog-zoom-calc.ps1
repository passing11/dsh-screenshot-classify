<#
  dsh-screenshot-capture · 预览缩放(Get-ZoomRect)的单元测试

  为什么要有这个文件:
    0.5.0 给弹窗加了滚轮缩放。「缩放到第 n 级时图片该画在框里的哪个矩形」
    是一段纯算术(取整、居中、边界钳制),靠"弹个窗滚滚看"验证不了边界情况,
    也验证不了"指针指着哪儿就放大哪儿"这条。抽成纯函数就能直接断言。

  0.5.3 起语义变了 —— 这是本文件最要紧的一条:
    Zoom = 1 不再是"整张图装进框"(contain),而是"整张图**铺满**框"(cover)。
    理由:用户要的是「图片显示区域布满整个预览空间」。contain 在框比图胖
    (或瘦)时一定留白,再大的窗口也只有中间一条看得见图 —— 那正是被否掉的
    观感。cover 保证框被填满,代价是比例不一致时有一边被裁掉,用滚轮缩小
    (Zoom < 1)到 contain 才看得到全图。

  验什么:
    1. Zoom = 1 恒等于 cover:图盖满框、至少一边正好贴边、不变形、居中
    2. Zoom > 1 时按比例继续放大,倍数对得上
    3. Zoom < 1 时能缩到 contain(整张装进框),但不会再小
    4. 图没有溢出时 pan 恒被钳成 0;溢出时 pan 在溢出范围内有效
    5. 框比图胖 / 瘦 / 同比例 三种情况都真的填满(cover 分支正确)
    6. 缩放锚点算术(applyZoom 的 pan 补偿)保持锚点下的图不动

  用法: powershell -NoProfile -ExecutionPolicy Bypass -File test\test-dialog-zoom-calc.ps1
#>
$ErrorActionPreference = 'Stop'

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

Invoke-Expression (Get-FnSource $src 'Get-ZoomRect')

$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}

# 直接调 Get-ZoomRect(几个用例都写全参数,读起来更直白)
function Rect([int]$bw, [int]$bh, [int]$iw, [int]$ih, [double]$zoom, [double]$px, [double]$py) {
  return Get-ZoomRect -BoxW $bw -BoxH $bh -ImgW $iw -ImgH $ih -Zoom $zoom -PanX $px -PanY $py
}

# cover 语义下的"最小可缩放倍数"(= contain/cover)。测试里要拿它验下限。
function MinZoom([int]$bw, [int]$bh, [int]$iw, [int]$ih) {
  $sx = [double]$bw / [double]$iw
  $sy = [double]$bh / [double]$ih
  return ([Math]::Min($sx, $sy) / [Math]::Max($sx, $sy))
}

# ---- ① 同比例:Zoom=1 恰好铺满,不裁切不变形 --------------------------------
$R = Rect 320 180 1920 1080 1.0 0 0
Check '16:9 框 + 16:9 图 Zoom=1 铺满宽度' ($R.w -eq 320) "实际 $($R.w)"
Check '16:9 框 + 16:9 图 Zoom=1 铺满高度' ($R.h -eq 180) "实际 $($R.h)"
Check '16:9 铺满时左上角归零' (($R.x -eq 0) -and ($R.y -eq 0)) "位置 $($R.x),$($R.y)"
Check 'Zoom=1 的 scale 就是 cover' ([Math]::Abs($R.scale - (320.0 / 1920.0)) -lt 1e-9) "scale $($R.scale)"

# ---- ② 框比图胖(方框装宽图):图按更松的一边铺满,横向溢出被裁 --------------
# 400x400 的框装 1920x1080:sx=0.2083 sy=0.3704 → cover 取 0.3704 → 图 711x400。
# 宽度 711 > 400,所以**框被填满**、左右各裁掉一块(不是留上下灰边)。
$R = Rect 400 400 1920 1080 1.0 0 0
Check '方框装宽图 Zoom=1 高度铺满' ($R.h -eq 400) "实际 $($R.h)"
Check '方框装宽图 Zoom=1 宽度溢出(被裁)' ($R.w -eq 711) "实际 $($R.w)"
Check '方框装宽图 确实盖满整个框宽' ($R.w -ge 400) "只有 $($R.w) 宽"
Check '方框装宽图水平居中(左右裁掉一样多)' ($R.x -eq [int][Math]::Round((400 - 711) / 2.0)) "实际 x $($R.x)"
Check '方框装宽图垂直不动' ($R.y -eq 0) "实际 y $($R.y)"

# 400x400 的框装 1080x1920(竖图)→ cover = max(0.3704,0.2083) = 0.3704 → 400x711,上下被裁
$R = Rect 400 400 1080 1920 1.0 0 0
Check '方框装竖图 Zoom=1 宽度铺满' ($R.w -eq 400) "实际 $($R.w)"
Check '方框装竖图 Zoom=1 高度溢出(被裁)' ($R.h -eq 711) "实际 $($R.h)"
Check '方框装竖图 确实盖满整个框高' ($R.h -ge 400) "只有 $($R.h) 高"
Check '方框装竖图垂直居中(上下裁掉一样多)' ($R.y -eq [int][Math]::Round((400 - 711) / 2.0)) "实际 y $($R.y)"

# ---- ③ Zoom > 1:按倍数放大 ------------------------------------------------
$R1 = Rect 320 180 1920 1080 1.0 0 0
$R2 = Rect 320 180 1920 1080 2.0 0 0
Check 'Zoom=2 宽度翻倍' ($R2.w -eq ($R1.w * 2)) "1x=$($R1.w) 2x=$($R2.w)"
Check 'Zoom=2 高度翻倍' ($R2.h -eq ($R1.h * 2)) "1x=$($R1.h) 2x=$($R2.h)"
Check 'Zoom=2 居中(负偏移对称)' (($R2.x + $R2.w / 2) -eq [int]($R1.w / 2)) "图中心 x=$($R2.x + $R2.w / 2.0)"

# ---- ④ Zoom < 1:能缩到 contain,但不会更小 --------------------------------
# 方框装宽图,minZoom = 0.2083/0.3704 = 0.5625 → 缩到它就是 400x225(整张装进框)
$mz = MinZoom 400 400 1920 1080
Check '方框装宽图的 minZoom = 0.5625' ([Math]::Abs($mz - 0.5625) -lt 1e-9) "实际 $mz"
$R = Rect 400 400 1920 1080 $mz 0 0
Check '缩到 minZoom 正好整张装进框(宽)' ($R.w -eq 400) "实际 $($R.w)"
Check '缩到 minZoom 正好整张装进框(高)' ($R.h -eq 225) "实际 $($R.h)"
Check '缩到 minZoom 垂直居中(上下留边)' ($R.y -eq [int][Math]::Round((400 - 225) / 2.0)) "实际 y $($R.y)"

# 再往下滚(zoom=0.1)被钳回 minZoom,不会缩成一个小点
$Rlo = Rect 400 400 1920 1080 0.1 0 0
Check 'Zoom 低于 minZoom 被钳回(不许比整张装进框更小)' (($Rlo.w -eq 400) -and ($Rlo.h -eq 225)) "w=$($Rlo.w) h=$($Rlo.h)"

# 同比例时 minZoom = 1,所以"缩到看全图"和"铺满"是同一个状态
$R = Rect 320 180 1920 1080 0.5 0 0
Check '同比例时 Zoom<1 被当成 1(铺满即装得下)' (($R.w -eq 320) -and ($R.h -eq 180)) "w=$($R.w) h=$($R.h)"

# ---- ⑤ Zoom=1 时 pan 一律被钳成 0(图没溢出就不许挪) --------------------
# 但 cover 下通常有一边是溢出的,所以要挑"正好同比例"的框来验"没溢出"。
$R = Rect 320 180 1920 1080 1.0 50 50
Check '同比例 Zoom=1 panX 被钳成 0' ($R.panX -eq 0) "实际 $($R.panX)"
Check '同比例 Zoom=1 panY 被钳成 0' ($R.panY -eq 0) "实际 $($R.panY)"
Check '同比例 Zoom=1 大 pan 也不越界' (($R.x -eq 0) -and ($R.y -eq 0)) "位置 $($R.x),$($R.y)"

# 缩到 contain 之后图完全在框内,pain 也必须归零(否则会把图拖出框一角)
$R = Rect 400 400 1920 1080 $mz 99 99
Check '缩到 contain 后 panX 被钳成 0' ($R.panX -eq 0) "实际 $($R.panX)"
Check '缩到 contain 后 panY 被钳成 0' ($R.panY -eq 0) "实际 $($R.panY)"

# ---- ⑥ Zoom > 1 时 pan 有效,且钳在溢出范围内 ----------------------------
# 320 宽的框、同比例图、Zoom=2 → 图 640 宽,水平溢出 (640-320)/2 = 160
$R = Rect 320 180 1920 1080 2.0 100 0
Check '放大后 panX 原样生效' ($R.panX -eq 100) "实际 $($R.panX)"
Check '放大后 panX 位移到了 x' ($R.x -eq ((-160) + 100)) "实际 x $($R.x)"

$R = Rect 320 180 1920 1080 2.0 1000 0
Check 'panX 超上限被钳到边界' ($R.panX -eq 160) "实际 $($R.panX)"
# panX = +maxX 是"把图往右推到尽头",也就是在看图片的**右**半边 ——
# 这时图的左缘刚好贴住框的左缘(x=0),图右半部分被框裁掉。
Check '推到右尽头时图左缘贴框左缘' ($R.x -eq 0) "实际 x $($R.x)"

$R = Rect 320 180 1920 1080 2.0 (-1000) 0
Check 'panX 超下限被钳到边界' ($R.panX -eq (-160)) "实际 $($R.panX)"
# panX = -maxX 是反方向:把图往左推到尽头,这时看的是图片的**左**半边,
# 图的右缘刚好贴住框的右缘(x = -320 + 640 = 320)。
Check '推到左尽头时图右缘贴框右缘' (($R.x + $R.w) -eq 320) "右缘 $($R.x + $R.w)"

# ---- ⑦ 极端比例:无论如何都要把框盖满,且尺寸为正 ------------------------
foreach ($case in @(
    @{ bw = 320; bh = 180; iw = 20000; ih = 200; z = 1.0; label = '超宽条' },
    @{ bw = 320; bh = 400; iw = 200; ih = 20000; z = 1.0; label = '超窄条' },
    @{ bw = 40; bh = 40; iw = 1920; ih = 1080; z = 12.0; label = '小框 12 倍' })) {
  $R = Rect $case.bw $case.bh $case.iw $case.ih $case.z 0 0
  Check "$($case.label) 尺寸为正" (($R.w -ge 1) -and ($R.h -ge 1)) "w=$($R.w) h=$($R.h)"
  # cover 的硬保证:两个方向都不小于框
  Check "$($case.label) 两个方向都盖满" (($R.w -ge $case.bw) -and ($R.h -ge $case.bh)) "w=$($R.w) h=$($R.h)"
}

# ---- ⑧ 锚点缩放:指针指着哪儿就放大哪儿 -----------------------------
# 这段算术在 Show-CaptureDialog 的 $applyZoom 里(不是纯函数),这里把它
# 照抄一遍做等价验证:同一个公式算出新 pan,锚点下的图内容应留在原处。
function Apply-Pan([double]$pan, [double]$anchor, [double]$ratio) {
  return ($pan - $anchor) * $ratio + $anchor
}
# 框 320 宽,指针在 x=240(相对中心的偏移 +80)
$boxW = 320
$anchorOff = 240 - ($boxW / 2.0)   # = +80
$ratio = 2.0
# 中心为 0 时放大 2 倍:锚点处原像素的相对位置 80*2 = 160 → 需要 pan -40?
# 推导:放大后要看到锚点附近的同一像素,pan 应满足 80*ratio + pan = 80
#       → pan = 80 - 80*ratio = 80 - 160 = -80
$newPan = Apply-Pan 0 $anchorOff $ratio
Check '锚点在右侧时放大后 pan 向左偏' ($newPan -eq (-80)) "实际 $($newPan)"
Check '锚点位置在放大后保持不变' (($anchorOff * $ratio + $newPan) -eq $anchorOff) "锚点漂移 $($anchorOff * $ratio + $newPan - $anchorOff)"

# 再放大一次(锚点同样在 +80),pan 继续按同一公式补偿
$ratio2 = 2.0
$newPan2 = Apply-Pan $newPan $anchorOff $ratio2
Check '连续放大两次 pan 仍可逆' (($newPan2 -eq (-240))) "实际 $($newPan2)"

# ---- ⑨ 源码层:确认默认态真的是 cover 而不是 fit ------------------------
# 这三条挡的是"改回去"和"手滑把 Max/Min 写反"——数值断言能过、但整体观感
# 又变回留白的那种回归。
Check '源码里 cover 用 Max' ($src.Contains('$cover = [Math]::Max($scaleX, $scaleY)')) '没找到 $cover = [Math]::Max(...)'
Check '源码里 contain 用 Min' ($src.Contains('$contain = [Math]::Min($scaleX, $scaleY)')) '没找到 $contain = [Math]::Min(...)'
Check '缩放基准是 cover 乘缩放倍数' ($src.Contains('$scale = $cover * [Math]::Max($minZoom, [double]$Zoom)')) '没找到 $scale = $cover * ...'

if ($script:fail -eq 0) {
  '[dialog-zoom-calc] 全部通过'
} else {
  "[dialog-zoom-calc] 失败 $($script:fail) 项"
  exit 1
}
