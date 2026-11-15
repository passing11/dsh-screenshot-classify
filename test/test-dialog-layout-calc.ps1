<#
  dsh-screenshot-capture · 弹窗布局(Get-DialogLayout)的单元测试

  为什么要有这个文件:
    布局算法抽成纯函数,可以脱离真实弹窗直接断言,不用等窗口真的弹出来。

  契约走过一次反转,这里记清楚,免得后人又改回去:
    0.4.7 ~ 0.5.1:预览框**贴合图片宽高比**。好处是 Zoom 模式不留边,坏处是
      窗口被拉高时多出来的高度只能塞给注释框,图片本身一点都不变大 ——
      用户的原话是「图片的显示区域自适应是全部窗口」。
    0.5.2 起:预览框**铺满可用区域**(宽 = 窗宽 - 2*pad,高 = 可用高度 -
      固定 60 的注释框)。比例对不上时四周留背景边;那些边在放大之后正好
      被图填满,所以不是浪费,是先把画布给足。

  验什么:
    1. 预览框宽 == 窗宽 - 2*pad,高 == 可用高度 - 60(注释框固定 60)
    2. 各种窗口尺寸下,控件都在窗内、互不重叠、纵向顺序正确
    3. 窗口变高 → 预览框跟着变高(这才是这条需求的本体)
    4. 极端比例(超宽 / 超窄)与最小窗口不产生负数或越界

  用法: powershell -NoProfile -ExecutionPolicy Bypass -File test\test-dialog-layout-calc.ps1
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

Invoke-Expression (Get-FnSource $src 'Get-DialogLayout')

$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}

$Pad = 8; $Gap = 6; $BtnW = 88; $BtnH = 32; $ChkH = 24; $NoteH = 60

# 预览图与注释框之外的全部纵向开销,写成守恒式而不是一个魔法数字:
#   上边距 + 图与注释框的间距 + 勾选行 + 按钮行 + 下边距,两个间距各算一个 Gap。
# 换皮肤前这里写的是「gap + 10」(勾选行到按钮行硬编码 10);皮肤化之后两处
# 间距统一走 Gap,所以断言跟着换成守恒式 —— 数字变了,契约没变:
# 窗口高度 = 上边距 + 预览高 + 边距 + 注释高 + Gap + 勾选高 + Gap + 按钮高 + 边距。
$ChromeH = $Pad * 3 + $Gap * 2 + $ChkH + $BtnH

function Layout([int]$cw, [int]$ch, [int]$iw, [int]$ih) {
  return Get-DialogLayout -ClientW $cw -ClientH $ch -ImageW $iw -ImageH $ih `
    -Pad $Pad -Gap $Gap -BtnW $BtnW -BtnH $BtnH
}

# 断言一套布局自洽:铺满、越界、重叠、顺序。
# $label 只用于报错信息;失败由 Check 汇总。
function Test-Invariants([string]$label, $L, [int]$cw, [int]$ch) {
  Check "$label 预览框铺满窗宽" ($L.picW -eq ($cw - $Pad * 2)) "实际 $($L.picW) vs 期望 $($cw - $Pad * 2)"
  Check "$label 注释框固定 $NoteH 高" ($L.noteH -eq $NoteH) "实际 $($L.noteH)"
  Check "$label 预览图不越右边界" (($L.picX + $L.picW) -le $cw) "右 $($L.picX + $L.picW) > $cw"
  Check "$label 预览图不越下边界" (($L.picY + $L.picH) -le $ch) "下 $($L.picY + $L.picH) > $ch"
  Check "$label 预览图不出左/上边界" (($L.picX -ge 0) -and ($L.picY -ge 0)) "位置 $($L.picX),$($L.picY)"
  Check "$label 注释框不越界" ((($L.noteX + $L.noteW) -le $cw) -and (($L.noteY + $L.noteH) -le $ch)) "右 $($L.noteX + $L.noteW) 下 $($L.noteY + $L.noteH)"
  Check "$label 注释框宽度 = 窗宽 - 2*pad" ($L.noteW -eq ($cw - $Pad * 2)) "注释 $($L.noteW) vs 期望 $($cw - $Pad * 2)"
  Check "$label 预览图高度不低于下限" ($L.picH -ge 40) "实际 $($L.picH)"

  # 纵向顺序:预览 → 注释 → 勾选 → 按钮行,相邻不重叠
  Check "$label 预览在注释之上" (($L.picY + $L.picH) -le $L.noteY) "预览底 $($L.picY + $L.picH) vs 注释顶 $($L.noteY)"
  Check "$label 注释在勾选之上" (($L.noteY + $L.noteH) -le $L.chkY) "注释底 $($L.noteY + $L.noteH) vs 勾选顶 $($L.chkY)"
  Check "$label 勾选在按钮之上" (($L.chkY + $ChkH) -le $L.rowY) "勾选底 $($L.chkY + $ChkH) vs 按钮顶 $($L.rowY)"
  Check "$label 按钮行完整落在窗内" (($L.rowY + $BtnH) -le $ch) "按钮底 $($L.rowY + $BtnH) > 窗高 $ch"
  Check "$label 按钮行宽度够放两个按钮" (($L.rowX + $BtnW * 2 + $Gap) -le $cw) "需要 $($Pad + $BtnW * 2 + $Gap) 宽,窗只有 $cw"
}

# ---- ① 典型 16:9 截图,窗口宽度刚好 --------------------------------
$L = Layout 336 336 1920 1080
Test-Invariants '16:9/336x336' $L 336 336
# chrome = 8*3 + 6*2 + 24 + 32 = 92; avail = 336 - 92 = 244; picH = 244 - 60 = 184
Check '16:9 预览高度 = 可用高度 - 注释框' ($L.picH -eq (336 - $ChromeH - $NoteH)) "实际 $($L.picH) vs 期望 $(336 - $ChromeH - $NoteH)"

# ---- ② 同样 16:9,窗口被拉高 → 多出来的高度给预览框(本需求本体) -----
$L2 = Layout 336 600 1920 1080
Test-Invariants '16:9 高窗' $L2 336 600
Check '高窗时预览宽度不变(仍铺满)' ($L2.picW -eq 320) "实际 $($L2.picW)"
# avail = 600 - 92 = 508; picH = 508 - 60 = 448
Check '高窗时预览框跟着变高' ($L2.picH -eq (600 - $ChromeH - $NoteH)) "实际 $($L2.picH) vs 期望 $(600 - $ChromeH - $NoteH)"
Check '高窗时预览框比矮窗高' ($L2.picH -gt $L.picH) "矮窗 $($L.picH) 高窗 $($L2.picH)"
Check '高窗时注释框不抢高度' ($L2.noteH -eq 60) "实际 $($L2.noteH)"

# ---- ③ 竖长截图(400x900)在宽窗里:框仍铺满,图自己居中留边 --------
$L = Layout 600 400 400 900
Test-Invariants '竖图/宽窗' $L 600 400
Check '竖图也铺满窗宽' ($L.picW -eq 584) "实际 $($L.picW)"

# ---- ④ 超宽图(3000x200)在窄窗里 ----------------------------------
$L = Layout 336 400 3000 200
Test-Invariants '超宽图' $L 336 400

# ---- ⑤ 超窄图(100x2000)------------------------------------------
$L = Layout 336 400 100 2000
Test-Invariants '超窄图' $L 336 400

# ---- ⑥ 最小窗口(220x240)不该算出负数 ----------------------------
$L = Layout 220 240 1920 1080
Test-Invariants '最小窗口' $L 220 240
Check '最小窗口下预览尺寸为正' (($L.picW -gt 0) -and ($L.picH -gt 0)) "实际 $($L.picW)x$($L.picH)"

# ---- ⑦ 大窗口(1111x1111 固定尺寸)--------------------------------
$L = Layout 1111 1111 1920 1080
Test-Invariants '大窗/16:9' $L 1111 1111
Check '大窗下预览铺满窗宽' ($L.picW -eq (1111 - $Pad * 2)) "实际 $($L.picW)"

# ---- ⑧ 图片尺寸为 0 也不炸(防御性)--------------------------------
$L = Layout 336 336 0 0
Check '图片尺寸为 0 时布局仍可用' (($null -ne $L) -and ($L.picW -gt 0) -and ($L.picH -gt 0)) "pic $($L.picW)x$($L.picH)"

# ---- ⑨ 源码层:PictureBox 必须是 Zoom(等比缩放),不能是 StretchImage ----
$body = Get-FnSource $src 'Show-CaptureDialog'
Check '预览框用 Zoom 模式(等比缩放不糊)' ($body.Contains('[System.Windows.Forms.PictureBoxSizeMode]::Zoom')) '缺 Zoom 模式'
Check '没有用 StretchImage 拉伸变形' (-not ($body.Contains('StretchImage'))) '出现 StretchImage,图片会被拉变形'

if ($fail -eq 0) { '[dialog-layout-calc] 全部通过' } else { "[dialog-layout-calc] 失败 $fail 项"; exit 1 }
