<#
  dsh-screenshot-capture · 剪贴板监听 + 系统级悬浮窗 (PowerShell 5.1, 零依赖)

  职责:
    1. 轮询剪贴板序列号(GetClipboardSequenceNumber),检测新图片(截图/Ctrl+C 图片)
    2. 检测到后:原图存到 $env:TEMP\dsh-capture\clip_<ts>.png
    3. 在鼠标当前位置弹出置顶小窗:图片预览 + 注释输入框 + 「重点」复选框
       + 【存文档】【存图片】
    4. 结果写入事件日志文件(每行一个 JSON),也尝试写 stdout

  协议(每行一个 JSON,写日志 + stdout):
    {"t":"ready"}
    {"t":"img","path":"...","seq":123}
    {"t":"choice","action":"doc|img|ignore","path":"...","note":"用户注释","isKey":true,"autoClosed":false}
    {"t":"err","msg":"..."}

  参数:
    -ConfigPath  JSON 配置文件(可选): pollIntervalMs / cooldownMs / offsetX / offsetY / previewMaxWidth
                 / dupWindowMs / autoCloseSec(悬浮窗自动关闭秒数,0 = 不自动关)
    -AutoAction  doc|img|ignore|none  自动选择,不弹窗(自动化测试用);none=只检测不处理
    -Once        只处理一次后退出
#>
param(
  [string]$ConfigPath = "",
  [string]$AutoAction = "",
  [switch]$Once
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinClip {
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
"@

# --- 滚轮消息桥 -------------------------------------------------------------
# PictureBox 不响应滚轮:MouseWheel 事件只在**控件自己**拿到焦点时才发,而
# 预览图点了也拿不到焦点(它不该抢走注释框的输入焦点)。所以滚轮必须从消息
# 层捞 —— IMessageFilter 在 Application 的泵里先于控件看到 WM_MOUSEWHEEL。
#
# 只转发落在预览框矩形内的滚轮:落在注释框上时用户是在滚注释,不该缩放图片。
#
# Feed() 是给测试开的口子:不注册到真实的消息泵,直接把构造出来的消息喂进
# PreFilterMessage,就能在没有真人滚鼠标的前提下验证整条链路。
# 之前那版测试直接挪真鼠标,既打断用户又被手抢走,时过时不通过。
#
# 编译包在函数里(而不是脚本顶层):弹窗测试只抠 Show-CaptureDialog 的源码
# 单独执行,顶层的 Add-Type 根本不会跑,不放进来测试就会 type not found。
# 同一个类型只能 Add-Type 一次(重复编译同名类型会报错),所以先探测再编译。
function Initialize-WheelBridge {
  if ('DscWheelBridge' -as [type]) { return }
  Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DscWheelBridge : IMessageFilter {
  // (screenX, screenY, delta) -> 是否已消费
  public Func<int, int, int, bool> Handler;
  public bool PreFilterMessage(ref Message m) {
    if (m.Msg != 0x020A) return false;   // WM_MOUSEWHEEL
    return Dispatch(m.WParam.ToInt64(), m.LParam.ToInt64());
  }
  public bool Feed(int msg, long wParam, long lParam) {
    Message m = Message.Create(IntPtr.Zero, msg, new IntPtr(wParam), new IntPtr(lParam));
    return PreFilterMessage(ref m);
  }
  bool Dispatch(long wParam, long lParam) {
    // lParam: 低 16 位 x、高 16 位 y(屏幕坐标,有符号 —— 副屏在左边时是负数)
    // wParam: 高 16 位是带符号的滚轮增量(向前 120,向后 -120)
    int x = (short)(lParam & 0xFFFF);
    int y = (short)((lParam >> 16) & 0xFFFF);
    int delta = (short)((wParam >> 16) & 0xFFFF);
    if (Handler == null) return false;
    return Handler(x, y, delta);
  }
}

// 抢前台。为什么需要它:
//   WM_MOUSEWHEEL 是发给**拥有键盘焦点的窗口**的,不是发给鼠标底下那个窗口。
//   弹窗是隐藏 spawn 出来的,用户那会儿通常正在 Chrome/编辑器里打字 —— Windows
//   的前台锁不允许后台进程抢前台,于是弹窗虽然 TopMost 可见,却收不到任何滚轮。
//   实测:焦点在别的窗口时滚轮事件 0 条;焦点给回弹窗立刻生效。
//   AttachThreadInput + BringWindowToTop + SetActiveWindow + SetFocus 那套组合拳
//   在本机实测抢不到(前台锁照样拦);唯一可靠的是先敲一下 ALT —— 系统认为
//   "用户正在输入",前台锁放开,随后的 SetForegroundWindow 就能成功。
//   ALT 是单独按下再抬起、不带任何字符,紧接着我们就把前台拿走,不会在别的程序
//   里留下痕迹,也不移动鼠标。
public class DscFocusGrab {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

  public static bool IsForeground(IntPtr hwnd) {
    return hwnd != IntPtr.Zero && GetForegroundWindow() == hwnd;
  }

  public static bool Grab(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    if (IsForeground(hwnd)) return true;

    // 第一步:AttachThreadInput 组合拳(不碰键盘,最干净)。多数情况下前台锁会拦。
    try {
      IntPtr fg = GetForegroundWindow();
      uint fgPid = 0;
      uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
      uint myTid = GetCurrentThreadId();
      if (fgTid != 0 && fgTid != myTid) {
        AttachThreadInput(myTid, fgTid, true);
        try { SetForegroundWindow(hwnd); } finally { AttachThreadInput(myTid, fgTid, false); }
      } else {
        SetForegroundWindow(hwnd);
      }
    } catch { }
    if (IsForeground(hwnd)) return true;

    // 第二步:敲一下 ALT 解锁,再抢。实测这一步才真正有效。
    try {
      keybd_event(0x12, 0, 0x0000, IntPtr.Zero);   // VK_MENU down
      System.Threading.Thread.Sleep(40);
      keybd_event(0x12, 0, 0x0002, IntPtr.Zero);   // KEYEVENTF_KEYUP
      System.Threading.Thread.Sleep(80);
      SetForegroundWindow(hwnd);
    } catch { }
    return IsForeground(hwnd);
  }
}
"@
}

$tempDir = Join-Path $env:TEMP "dsh-capture"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$logPath = Join-Path $tempDir "events.log"

function Write-Event([hashtable]$obj) {
  $line = $obj | ConvertTo-Json -Compress
  try { [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8) } catch {}
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch {}
}

$config = @{ pollIntervalMs = 200; cooldownMs = 2000; positionMode = "cursor"; fixedX = 0; fixedY = 0; offsetX = 16; offsetY = 16; previewMaxWidth = 320; width = 0; height = 0; dupWindowMs = 6000; autoCloseSec = 0; statePath = ""; classifyEnabled = $true; categories = @(); theme = "c1" }
if ($ConfigPath -and (Test-Path $ConfigPath)) {
  try {
    # 必须显式按 UTF-8 读。宿主写这份配置时是 UTF-8,而 Windows PowerShell 5.1
    # 的 `Get-Content -Raw` 按系统代码页(本机 936/GBK)解码 —— 类目名全是中文,
    # 解错之后连引号都可能被吃掉,`ConvertFrom-Json` 直接报「传入的数组无效」,
    # 于是整个配置被丢弃、下拉退回「自动」一项。实测就是这么坏掉的。
    $cfgText = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
    $cfg = $cfgText | ConvertFrom-Json
    foreach ($k in @('pollIntervalMs','cooldownMs','positionMode','fixedX','fixedY','offsetX','offsetY','previewMaxWidth','width','height','dupWindowMs','autoCloseSec','statePath','classifyEnabled','categories','theme')) {
      if ($null -ne $cfg.$k) { $config[$k] = $cfg.$k }
    }
  } catch { Write-Event @{ t = "err"; msg = "config parse: $($_.Exception.Message)" } }
}

# --- duplicate-screen guard -------------------------------------------------
# Windows' snipping tool can push the SAME screen to the clipboard twice within a
# few seconds (measured 2026-09-29: two images 1 px apart, 3 s apart). Without a
# guard that is two dialogs and two archived copies for one screenshot. Compare a
# coarse 32x32 grey fingerprint against the recent captures and skip near-identical
# ones inside dupWindowMs.
$dupPixelsAllowed = 64   # of 1024 cells (6%); same screen stays well under it
$recentSignatures = @()

function Get-ImageSignature([System.Drawing.Image]$image) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.DrawImage($image, 0, 0, 32, 32) } finally { $g.Dispose() }
    $sig = New-Object 'int[]' 1024
    for ($y = 0; $y -lt 32; $y++) {
      for ($x = 0; $x -lt 32; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $lum = ($c.R * 0.299) + ($c.G * 0.587) + ($c.B * 0.114)
        $sig[($y * 32) + $x] = [int][Math]::Floor($lum / 16)
      }
    }
    return , $sig
  } finally {
    $bmp.Dispose()
  }
}

function Test-SimilarSignature($a, $b, [int]$allowed) {
  $diff = 0
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ($a[$i] -ne $b[$i]) {
      $diff++
      if ($diff -gt $allowed) { return $false }
    }
  }
  return $true
}

function Test-DuplicateCapture($sig, $now) {
  foreach ($entry in $recentSignatures) {
    if (($now - $entry.at).TotalMilliseconds -le [int]$config.dupWindowMs) {
      if (Test-SimilarSignature $sig $entry.sig $dupPixelsAllowed) { return $true }
    }
  }
  return $false
}

function Remember-Signature($sig, $now) {
  $script:recentSignatures = @(@{ sig = $sig; at = $now }) + @($recentSignatures | Select-Object -First 4)
}

# 剪贴板序列号的唯一入口。
#
# 和 Get-PointerPosition 同样的理由留一个测试接缝:真剪贴板在这台机器上被
# 浏览器长期占着(OpenClipboard 连续 8 次失败),测试没法靠它验证刷新逻辑。
# 测试把 $script:SeqOverride 设成一个返回整数的 scriptblock,就能**模拟**
# "用户又截了一张图",完全不动系统剪贴板。
$script:SeqOverride = $null
function Get-ClipboardSeq {
  if ($null -ne $script:SeqOverride) { return [int](& $script:SeqOverride) }
  return [int][WinClip]::GetClipboardSequenceNumber()
}

# --- 剪贴板读取与临时落盘 ---------------------------------------------------
# 主循环和「窗口开着时盯新截图」都要这两步,抽出来免得两份实现走偏。
# 剪贴板是全局资源,别的程序(浏览器、截图工具)随时可能占着它:
# ContainsImage / GetImage 都可能抛,一律当"这会儿没图"处理,不中断监听。

# 读当前剪贴板里的图片,没有或读不到就返回 $null。**调用方负责 Dispose**。
# $script:ClipboardImageOverride 是同一个测试接缝:返回一张现成的位图,
# 就能在完全不碰系统剪贴板的前提下驱动刷新。
$script:ClipboardImageOverride = $null
function Read-ClipboardImage {
  if ($null -ne $script:ClipboardImageOverride) {
    return (& $script:ClipboardImageOverride)
  }
  try {
    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return $null }
  } catch { return $null }
  try { return [System.Windows.Forms.Clipboard]::GetImage() } catch { return $null }
}

# 把图存成临时 png,返回路径;失败返回 $null。
# 同一毫秒里连存两张会撞名(时间戳只到毫秒),撞了就顺延 _2 / _3。
function Save-ClipboardImageToTemp([System.Drawing.Image]$img) {
  $ts = Get-Date -Format "yyyyMMdd_HHmmss_fff"
  $pngPath = Join-Path $tempDir ("clip_{0}.png" -f $ts)
  $n = 1
  while (Test-Path $pngPath) {
    $n++
    $pngPath = Join-Path $tempDir ("clip_{0}_{1}.png" -f $ts, $n)
  }
  try {
    $img.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    return $pngPath
  } catch {
    Write-Event @{ t = "err"; msg = "save: $($_.Exception.Message)" }
    return $null
  }
}

# 把窗里的预览换成新图,并把旧的那张临时图删掉。
#
# 抽成函数是为了能测:它只动 $pic 和 $state,完全不碰剪贴板,所以测试可以
# 拿一张现成的位图直接调,不用去抢那块被浏览器长期占着的剪贴板。
#
# 只换图、不动窗口大小:窗可能已经被拖过、或者按 remember 还原过,按新图的
# 尺寸去改窗会把用户刚摆好的位置和大小冲掉。PicBox 是 Zoom 模式,比例不同
# 就居中留白,不会变形。
function Set-DialogImage {
  param($state, $pic, [System.Drawing.Image]$newImg, [string]$newPath)
  # 换图后把缩放/平移到归零。放大倍数是对**上一张图**设的,套到新图上
  # 会让用户以为看到的是全图,而实际上只看到新图的一角 —— 这是会看错内容的
  # 那种坑,所以宁可让"铺满"状态重置。要在 Refresh 之前改,否则会先按旧
  # 缩放重画一帧,闪一下才跳回铺满。
  if ($null -ne $state.zoom) { $state.zoom = 1.0 }
  if ($null -ne $state.panX) { $state.panX = 0.0 }
  if ($null -ne $state.panY) { $state.panY = 0.0 }
  # 先换状态再重画:Paint 读的是 $state.image,顺序反了会拿旧图重画一帧
  # (UserPaint 下 $pic.Image 不再参与绘制,只是为了让别的代码还能读到它)。
  $oldImg = $pic.Image
  $oldPath = $state.path
  $state.image = $newImg
  $state.path = $newPath
  $pic.Image = $newImg
  $pic.Refresh()
  # 旧图要 Dispose,否则每换一张漏一份 GDI+ 句柄。ReferenceEquals 判一下:
  # 极端情况下新图就是旧图本身,那就别把它释放了。
  if (($null -ne $oldImg) -and (-not [object]::ReferenceEquals($oldImg, $newImg))) {
    try { $oldImg.Dispose() } catch { }
  }
  # 旧的那张临时图不再需要 —— 用户明确说了「原来的截图不用」。
  if ($oldPath -and ($oldPath -ne $newPath)) {
    try { Remove-Item -LiteralPath $oldPath -Force -ErrorAction SilentlyContinue } catch { }
  }
  $state.refreshes = [int]$state.refreshes + 1
}

# 指针位置的唯一入口。
#
# 默认读真实光标。自动化测试可以临时把 $script:PointerOverride 设成一个返回
# Point 的 scriptblock,**模拟**指针位置 —— 这样跑测试不会去动用户真正的鼠标。
# (之前的测试直接挪真鼠标:既打断用户操作,又因为人手会跟它抢而时过时不过。)
$script:PointerOverride = $null
function Get-PointerPosition {
  if ($null -ne $script:PointerOverride) { return (& $script:PointerOverride) }
  return [System.Windows.Forms.Cursor]::Position
}

# --- 记住上次关闭时的位置和大小 --------------------------------------------
#
# 存在一个独立的小 JSON 里,而不是写回 watcher-config.json —— 那份是插件每次
# 重启都会**整份重写**的配置投影,往里写运行时状态会在下次启动时被冲掉。
#
# 读回来的值必须重新校验:显示器拔了、分辨率变了、窗口被拖到不存在的坐标上,
# 都不能让窗弹到看不见的地方。位置只接受"至少有一角落在虚拟桌面内",
# 尺寸按 MinimumSize 夹一遍。
# 路径每次现算,不缓存成脚本级变量 —— 两个理由:
#   1. 测试会把这个函数单独抠出来跑,那时脚本级变量还没赋值;
#   2. 兜底值必须**永远**是绝对路径。写成 Join-Path $tempDir 而 $tempDir 又恰好
#      为空时,会退化成相对路径 "dialog-state.json",落到当前工作目录里 ——
#      真机上 cwd 是用户的随便哪个文件夹,文件就丢了。
function Get-StatePath {
  if ($config.statePath) { return [string]$config.statePath }
  $dir = if ($tempDir) { [string]$tempDir } else { [System.IO.Path]::GetTempPath() }
  return Join-Path $dir "dialog-state.json"
}

function Get-RememberedGeometry {
  try {
    $statePath = Get-StatePath
    if (-not (Test-Path $statePath)) { return $null }
    # 同上:显式 UTF-8,别让系统代码页毁掉 JSON
    $s = ([System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
    $rx = [int]$s.x; $ry = [int]$s.y
    $rw = [int]$s.width; $rh = [int]$s.height
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    # 窗口得**整个**落在虚拟桌面内才认。只判一个角不够:宽 800 的窗钉在
    # 屏幕最右边只露 10px,用户同样够不着标题栏去拖回来。
    if ($rw -le 0 -or $rh -le 0) { return $null }
    if ($rx -lt $vs.Left -or $ry -lt $vs.Top) { return $null }
    if (($rx + $rw) -gt $vs.Right -or ($ry + $rh) -gt $vs.Bottom) { return $null }
    return @{ x = $rx; y = $ry; width = $rw; height = $rh }
  } catch { return $null }
}

function Save-RememberedGeometry([int]$x, [int]$y, [int]$w, [int]$h) {
  # 最小化/最大化时不记 —— 那时候的 Bounds 不是用户想要的位置。
  if ($w -le 0 -or $h -le 0) { return }
  try {
    $statePath = Get-StatePath
    $obj = @{ x = $x; y = $y; width = $w; height = $h }
    $json = $obj | ConvertTo-Json -Compress
    # 先写临时文件再 Move —— 半截 JSON 会让下次启动读不到位置,
    # 而 Move 在同一卷上是原子的。
    $tmp = "$statePath.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
    if (Test-Path $statePath) { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $tmp -Destination $statePath -Force -ErrorAction SilentlyContinue
  } catch { }
}

# --- 弹窗内的布局计算 -------------------------------------------------------
#
# 单独抽成纯函数:给定客户区大小和图片原始尺寸,算出预览框该多大、注释框
# 该多高、各自摆在哪。抽出来有两个好处 —— 能脱离真实弹窗单独跑测试,
# 而且"用户拖边框改大小"和"窗开着时换了张比例不同的图"能共用同一套算法。
#
# 核心:**预览框铺满窗口的可用区域**,不再贴合图片宽高比。0.4.7 ~ 0.5.1 曾
# 让框严格等于图片比例(靠 zoom 把整张图装进去、不留灰边),代价是窗口拉高时
# 多出来的高度只能塞给注释框,图一像素都不变大 —— 用户要的正好相反。
# 现在框拿满空间,图按「铺满」(cover)比例画进去,再小的窗口也能把预览区填满。
# 多出来的纵向空间全给预览框。

# --- 弹窗皮肤 -----------------------------------------------------------------
#
# 一套固定的浅色扁平外观:不跟随系统深浅色,也不依赖系统主题(高对比度主题下
# 系统会给控件刷成另一种配色,那套颜色和这里的浅色底撞在一起很难看)。
#
# 四套主题只换**配色与头部图标画法**,布局、间距、控件位置、操作方式全部一致 ——
# 所以换主题不会让窗口变形,也不会让任何一个按钮挪位置。
#
# 所有数值先按 96 DPI 写死,再由下面的 $S 统一乘一次 scale —— 缩放只有这一个
# 入口,别处不再出现第二套换算。返回值顶层恰好五个键(colors / fonts / metrics /
# header / scale):header 装的是头部信息条那点事(图标画法、括号粗细、条高),
# 和 colors 里的配色分开,免得把"画法"混进"颜色"里。
function Initialize-Skin {
  param([string]$Theme = "c1")
  $scale = 1.0
  try {
    $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    if ($g -and $g.DpiX -gt 0) { $scale = [double]$g.DpiX / 96.0 }
    try { $g.Dispose() } catch { }
  } catch { $scale = 1.0 }
  if ($scale -le 0) { $scale = 1.0 }

  # 唯一的缩放换算点:先乘、再四舍五入、最小 1px(低缩放下小数值会取整成 0)。
  $S = { param($v) [int][Math]::Max(1, [Math]::Round($v * $scale)) }.GetNewClosure()

  # 主题名不认识时静默退回 c1 —— 配置里写错一个字不该让弹窗打不开。
  $themeId = ([string]$Theme).Trim().ToLowerInvariant()
  if ($themeId -notin @('c1', 'c2', 'c3', 'c4')) { $themeId = 'c1' }

  # 每套主题的差异只有这几项:主色三档(常态/hover/按下)、预览面板底、描边、
  # 头部图标画法、括号粗细。其余颜色四套共用。
  #
  # 括号/扫描线这套图标是「截图取景框」的意思:四角括号 = 取景,扫描线 = 识别。
  # 四套的括号粗细与扫描线画法不同,所以一眼能看出换了主题,不只是换了颜色。
  $presets = @{
    c1 = @{ accent = @(13, 148, 136);  accentHover = @(15, 118, 110); accentPress = @(17, 94, 89);  panel = @(240, 248, 247); border = @(205, 224, 221); icon = 'single'; corner = 1.6 }
    c2 = @{ accent = @(79, 70, 229);   accentHover = @(67, 56, 202);  accentPress = @(55, 48, 163); panel = @(243, 244, 252); border = @(216, 219, 240); icon = 'double'; corner = 2.2 }
    c3 = @{ accent = @(31, 41, 55);    accentHover = @(17, 24, 39);   accentPress = @(3, 7, 18);    panel = @(245, 246, 248); border = @(220, 222, 226); icon = 'bar';    corner = 1.4 }
    c4 = @{ accent = @(124, 58, 237);  accentHover = @(109, 40, 217); accentPress = @(91, 33, 182); panel = @(246, 243, 253); border = @(223, 214, 246); icon = 'dot';    corner = 1.8 }
  }
  $p = $presets[$themeId]
  $C = { param($rgb) [System.Drawing.Color]::FromArgb(255, $rgb[0], $rgb[1], $rgb[2]) }.GetNewClosure()

  $colors = @{
    bg             = [System.Drawing.Color]::FromArgb(255, 255, 255)
    panel          = & $C $p.panel
    border         = & $C $p.border
    text           = [System.Drawing.Color]::FromArgb(32, 34, 38)
    textDim        = [System.Drawing.Color]::FromArgb(120, 124, 132)
    accent         = & $C $p.accent
    accentHover    = & $C $p.accentHover
    accentPress    = & $C $p.accentPress
    secondaryHover = [System.Drawing.Color]::FromArgb(243, 244, 246)
    # 次要按钮的按下态:比 hover 再深一档,不然按下去没有反馈。
    secondaryPress = [System.Drawing.Color]::FromArgb(226, 232, 240)
    # 头部信息条的底色:比纯白略暖/略冷一点,让"条"能自己立住,不必再加一条
    # 分隔线(多一条线就多一道割裂感)。四套都用同一个极浅灰,差别由图标主色体现。
    headerBg       = [System.Drawing.Color]::FromArgb(252, 252, 253)
  }

  # 族名写错不会报错,只会静默 fallback 到 Microsoft Sans Serif —— 所以测试里
  # 断言的是族名本身,而不是"有没有设过 Font"。
  $fonts = @{
    title  = New-Object System.Drawing.Font('Microsoft YaHei UI', [single]10.5)
    body   = New-Object System.Drawing.Font('Microsoft YaHei UI', [single]10)
    button = New-Object System.Drawing.Font('Microsoft YaHei UI', [single]10)
    # 头部信息条那一行:比正文小半档,它是"说明"不是"标题"。
    meta   = New-Object System.Drawing.Font('Microsoft YaHei UI', [single]9)
  }

  $mPad = & $S 12
  $mGap = & $S 8
  $mBtnH = & $S 36
  $mBtnW = & $S 108
  $mChkH = & $S 26
  $mFitW = & $S 68
  $mMinPicH = & $S 48
  $mMinNoteH = & $S 64
  $metrics = @{
    Pad = $mPad; Gap = $mGap
    BtnH = $mBtnH; BtnW = $mBtnW
    ChkH = $mChkH; FitW = $mFitW
    MinPicH = $mMinPicH; MinNoteH = $mMinNoteH
  }
  # 「适应」按钮和勾选框在同一行,高度对齐即可,不必再单独给一个度量。
  $metrics.FitH = $metrics.ChkH

  # 头部信息条。高度固定 44(96 DPI):图标 24 + 上下各 10。
  # 它的高度**通过 Get-DialogLayout 的 -TopOffset 传下去**,由布局函数从可用
  # 高度里扣 —— 不在调用方自己减,否则窗口一拉大就会出现控件错位。
  $header = @{
    H       = & $S 44
    Icon    = & $S 24
    Style   = $p.icon
    CornerW = [double]$p.corner
    Theme   = $themeId
  }

  return @{
    colors = $colors
    fonts = $fonts
    metrics = $metrics
    header = $header
    scale = $scale
  }
}

# --- 头部信息条 ---------------------------------------------------------------
#
# 为什么要它:窗体标题栏已经写了「截图分类」,如果窗内再来一行大标题,同一个
# 名字在同一个窗里出现两遍 —— 用户的原话是「上方标题内容重复可以优化下」。
# 所以这里不放标题,只放**这一次截图的元信息**:状态 · 时间 · 尺寸。
#
# 图标是「取景框 + 扫描线」:四角括号 = 取景,中间那道线 = 识别。四套主题的
# 括号粗细与中线画法不同,所以换主题时一眼能看出换了,而不只是换了颜色。
function Draw-Header {
  param(
    $G,
    $Skin,
    [int]$Width,
    [string]$Meta = ""
  )
  if ($null -eq $G -or $Width -le 0) { return }
  $c = $Skin.colors
  $hd = $Skin.header
  $f = $Skin.fonts
  $h = [int]$hd.H
  if ($h -le 0) { return }

  # 底色:极浅灰,靠这点色差让"条"自己立住,不再加一条分隔线。
  $bgBrush = New-Object System.Drawing.SolidBrush($c.headerBg)
  try {
    $G.FillRectangle($bgBrush, 0, 0, $Width, $h)
    # 底部 1px 描边:条和内容区之间要有一条界线,否则白底接白底会糊成一片。
    $lineBrush = New-Object System.Drawing.SolidBrush($c.border)
    try { $G.FillRectangle($lineBrush, 0, ($h - 1), $Width, 1) } finally { $lineBrush.Dispose() }
  } finally { $bgBrush.Dispose() }

  # --- 图标:四角括号 + 中线 ---
  $is = [int]$hd.Icon
  $ix = [int]([Math]::Round($hd.H * 0.32))          # 左侧留白,与 44 高成比例
  $iy = [int]([Math]::Round(($h - $is) / 2.0))      # 垂直居中
  $cw = [single]$hd.CornerW
  $arm = [single]($is * 0.3)
  $pen = New-Object System.Drawing.Pen($c.accent, $cw)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  try {
    $r = [single]$ix; $t = [single]$iy
    $rr = [single]($ix + $is - 1); $bb = [single]($iy + $is - 1)
    $style = [string]$hd.Style
    if ($style -eq 'dot') {
      # 圆角弧括号:用四段圆弧代替直角折线,观感更软。
      $arcR = [single]($is * 0.34)
      $G.DrawArc($pen, $r, $t, ($arcR * 2), ($arcR * 2), 180, 90)
      $G.DrawArc($pen, ($rr - $arcR * 2), $t, ($arcR * 2), ($arcR * 2), 270, 90)
      $G.DrawArc($pen, $r, ($bb - $arcR * 2), ($arcR * 2), ($arcR * 2), 90, 90)
      $G.DrawArc($pen, ($rr - $arcR * 2), ($bb - $arcR * 2), ($arcR * 2), ($arcR * 2), 0, 90)
    } else {
      # 直角括号:八个线段拼四个角。
      $G.DrawLine($pen, $r, $t, ($r + $arm), $t)
      $G.DrawLine($pen, $r, $t, $r, ($t + $arm))
      $G.DrawLine($pen, ($rr - $arm), $t, $rr, $t)
      $G.DrawLine($pen, $rr, $t, $rr, ($t + $arm))
      $G.DrawLine($pen, $r, ($bb - $arm), $r, $bb)
      $G.DrawLine($pen, $r, $bb, ($r + $arm), $bb)
      $G.DrawLine($pen, ($rr - $arm), $bb, $rr, $bb)
      $G.DrawLine($pen, $rr, ($bb - $arm), $rr, $bb)
    }

    # 中线:四套主题四种画法,这是"换主题看得出来"的主要来源之一。
    $midY = [single]($iy + $is / 2.0)
    $padX = [single]($is * 0.28)
    switch ($style) {
      'single' {
        # 一条贯穿的细线 —— 最像"扫描"。
        $G.DrawLine($pen, ($r + $padX), $midY, ($rr - $padX), $midY)
      }
      'double' {
        # 两条平行线:比单线更"密",配靛蓝显得稳。
        $G.DrawLine($pen, ($r + $padX), ($midY - 2), ($rr - $padX), ($midY - 2))
        $G.DrawLine($pen, ($r + $padX), ($midY + 2), ($rr - $padX), ($midY + 2))
      }
      'bar' {
        # 实心短条:不画线,画一根粗条,观感最"重"。
        $barBrush = New-Object System.Drawing.SolidBrush($c.accent)
        try {
          $barH = [int][Math]::Max(2, [Math]::Round($is * 0.16))
          $G.FillRectangle($barBrush, ($r + $padX), ($midY - $barH / 2.0), ($is - $padX * 2), $barH)
        } finally { $barBrush.Dispose() }
      }
      'dot' {
        # 断线 + 中点圆:像"识别到一半",配紫罗兰最跳。
        $gap = [single]($is * 0.18)
        $G.DrawLine($pen, ($r + $padX), $midY, ($r + $padX + $gap), $midY)
        $G.DrawLine($pen, ($rr - $padX - $gap), $midY, ($rr - $padX), $midY)
        $dotR = [single][Math]::Max(1.5, $is * 0.1)
        $dotBrush = New-Object System.Drawing.SolidBrush($c.accent)
        try { $G.FillEllipse($dotBrush, ($ix + $is / 2.0 - $dotR), ($midY - $dotR), ($dotR * 2), ($dotR * 2)) } finally { $dotBrush.Dispose() }
      }
      default {
        $G.DrawLine($pen, ($r + $padX), $midY, ($rr - $padX), $midY)
      }
    }
  } finally { $pen.Dispose() }

  # --- 元信息一行 ---
  # 只写"这一刻的状态",不写标题(标题在窗口标题栏里)。文字用 textDim:
  # 它是说明,不该抢走预览图的注意力。
  if ($Meta) {
    $tx = [int]($ix + $is + [Math]::Round($is * 0.6))
    $flags = [System.Windows.Forms.TextFormatFlags]::VerticalCenter -bor
             [System.Windows.Forms.TextFormatFlags]::SingleLine -bor
             [System.Windows.Forms.TextFormatFlags]::NoPrefix -bor
             [System.Windows.Forms.TextFormatFlags]::EndEllipsis
    $rect = New-Object System.Drawing.Rectangle($tx, 0, [Math]::Max(1, $Width - $tx - 12), $h)
    [System.Windows.Forms.TextRenderer]::DrawText($G, $Meta, $f.meta, $rect, $c.textDim, $flags)
  }
}

# 头部那一行文字:状态 · 时间 · 尺寸。
# 状态写「待入库」而不是「已入库」—— 弹窗这一刻图还没落库,写"已入库"是假话。
function Get-HeaderMeta([datetime]$At, [int]$W, [int]$H) {
  $t = $At.ToString("HH:mm")
  return "待入库 · $t · ${W}×${H}"
}


#
# 为什么不用 Add-Type 子类:
#   ① 子类的 OnPaint 在 DrawToBitmap 下不被采信(采到的是系统灰渐变),渲染
#      验证根本没法做;
#   ② 多处测试按 GetType().Name -eq 'Button' 筛控件,子类会让类型名变掉、筛选
#      结果为空、测试直接崩。
# 所以这里用 New-Object 拿原生 Button,再反射打开 UserPaint —— 和脚本里 $pic
# 的既有做法完全一致(SetStyle 是 protected,没有公开替代品),实测生效。
function New-FlatButton {
  param($Skin, [string]$Kind)
  $b = New-Object System.Windows.Forms.Button
  $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $b.FlatAppearance.BorderSize = 0
  $b.UseVisualStyleBackColor = $false
  $b.Font = $Skin.fonts.button
  $b.TabStop = $false
  try {
    $miStyle = $b.GetType().GetMethod('SetStyle',
      [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
    if ($null -ne $miStyle) {
      $styleFlags = [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
                    [System.Windows.Forms.ControlStyles]::UserPaint -bor
                    [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
      [void]$miStyle.Invoke($b, @([System.Windows.Forms.ControlStyles]$styleFlags, $true))
    }
  } catch { }

  # 四态必须放 hashtable:闭包读普通局部标量读到的是创建时的快照(进一步说,
  # 在事件里改也传不回去),读 hashtable 成员才是活的。
  $st = @{ hover = $false; press = $false; focus = $false }

  $b.Add_MouseEnter({ $st.hover = $true; try { $b.Invalidate() } catch { } }.GetNewClosure())
  $b.Add_MouseLeave({ $st.hover = $false; $st.press = $false; try { $b.Invalidate() } catch { } }.GetNewClosure())
  $b.Add_MouseDown({ $st.press = $true; try { $b.Invalidate() } catch { } }.GetNewClosure())
  $b.Add_MouseUp({ $st.press = $false; try { $b.Invalidate() } catch { } }.GetNewClosure())
  $b.Add_GotFocus({ $st.focus = $true; try { $b.Invalidate() } catch { } }.GetNewClosure())
  $b.Add_LostFocus({ $st.focus = $false; try { $b.Invalidate() } catch { } }.GetNewClosure())

  $b.Add_Paint({
    param($s, $e)
    $G = $e.Graphics
    try {
      $G.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $rect = $b.ClientRectangle
      if ($rect.Width -lt 6 -or $rect.Height -lt 6) { return }

      $isPrimary = ($Kind -eq 'doc')

      # 描边宽度先定,填充和描边共用一条路径 —— 路径按笔宽内缩半个笔宽,
      # 否则 1px 描边会有一半被控件边缘裁掉。
      $penColor = $null
      $penWidth = 0
      if ($isPrimary) {
        if ($st.focus) { $penColor = $Skin.colors.accentPress; $penWidth = 2 }
      } else {
        if ($st.focus) { $penColor = $Skin.colors.accent; $penWidth = 2 }
        else { $penColor = $Skin.colors.border; $penWidth = 1 }
      }

      $inset = 0.0
      if ($penWidth -gt 0) { $inset = [double]$penWidth / 2.0 }
      $x0 = $inset
      $y0 = $inset
      $w1 = [double]$rect.Width - $inset * 2
      $h1 = [double]$rect.Height - $inset * 2
      if ($w1 -lt 4 -or $h1 -lt 4) { return }

      $radius = [int][Math]::Max(2, [Math]::Round(6 * $Skin.scale))
      $d = [double]($radius * 2)
      if ($d -gt $w1) { $d = $w1 }
      if ($d -gt $h1) { $d = $h1 }

      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      $path.AddArc([single]$x0, [single]$y0, [single]$d, [single]$d, 180, 90)
      $path.AddArc([single]($x0 + $w1 - $d), [single]$y0, [single]$d, [single]$d, 270, 90)
      $path.AddArc([single]($x0 + $w1 - $d), [single]($y0 + $h1 - $d), [single]$d, [single]$d, 0, 90)
      $path.AddArc([single]$x0, [single]($y0 + $h1 - $d), [single]$d, [single]$d, 90, 90)
      $path.CloseFigure()

      if ($isPrimary) {
        if ($st.press) { $fill = $Skin.colors.accentPress }
        elseif ($st.hover) { $fill = $Skin.colors.accentHover }
        else { $fill = $Skin.colors.accent }
        $textColor = [System.Drawing.Color]::White
      } else {
        if ($st.press) { $fill = $Skin.colors.secondaryPress }
        elseif ($st.hover) { $fill = $Skin.colors.secondaryHover }
        else { $fill = $Skin.colors.bg }
        $textColor = $Skin.colors.text
      }

      # 先清成窗口底色再裁到圆角里填充:直接 FillPath 不会清掉四角,而 Clear
      # 不裁的话矩形底色会溢出圆角。
      $G.Clear($Skin.colors.bg)
      $G.SetClip($path)
      $brush = New-Object System.Drawing.SolidBrush($fill)
      $G.FillPath($brush, $path)
      $G.ResetClip()

      if ($penWidth -gt 0 -and $null -ne $penColor) {
        $pen = New-Object System.Drawing.Pen($penColor, [single]$penWidth)
        $G.DrawPath($pen, $path)
        $pen.Dispose()
      }

      # 文字自己画:UserPaint 已经把 Button 的原生绘制压掉了,不画就是空白。
      $flags = [System.Windows.Forms.TextFormatFlags]::HorizontalCenter -bor
               [System.Windows.Forms.TextFormatFlags]::VerticalCenter -bor
               [System.Windows.Forms.TextFormatFlags]::NoPadding
      [System.Windows.Forms.TextRenderer]::DrawText($G, $b.Text, $Skin.fonts.button, $rect, $textColor, $flags)

      $brush.Dispose()
      $path.Dispose()
    } catch { }
  }.GetNewClosure())

  return $b
}

# --- 键盘快捷键(1 / 2) -------------------------------------------------------
#
# 用 C# 子类而不是 Add_KeyDown,是因为 KeyPreview 下的 KeyDown 会被 TextBox
# 吞掉(注释框有焦点时按 1 应该往框里输字符,而不是触发"存文档");只有
# ProcessCmdKey 是在所有控件之前的机会——那里能看到 KeyData,也能就地判断
# 当前焦点在不在文本框里。
#
# ⚠️ 但注释框里打数字是正常需求,所以这里**不抢**:焦点在 TextBox 上时直接
# 交回 base。判断放在 C# 里比在 PowerShell 里挂事件更稳(不用管事件顺序)。
function Initialize-KeyForm {
  try {
    if (-not ('DscFastForm' -as [type])) {
      Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Windows.Forms;
public class DscFastForm : Form {
  private bool InTextBox() {
    Control c = this.ActiveControl;
    while (c != null) {
      if (c is TextBoxBase) { return true; }
      if (c is ComboBox && ((ComboBox)c).DropDownStyle == ComboBoxStyle.DropDown) { return true; }
      ContainerControl cc = c as ContainerControl;
      if (cc == null) { return false; }
      c = cc.ActiveControl;
    }
    return false;
  }
  protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
    if (!InTextBox()) {
      if (keyData == Keys.D1 || keyData == Keys.NumPad1) { this.Tag = "doc"; this.DialogResult = DialogResult.OK;  return true; }
      if (keyData == Keys.D2 || keyData == Keys.NumPad2) { this.Tag = "img"; this.DialogResult = DialogResult.Yes; return true; }
    }
    return base.ProcessCmdKey(ref msg, keyData);
  }
}
"@
    }
  } catch { return $null }
  try { if ('DscFastForm' -as [type]) { return (New-Object DscFastForm) } } catch { }
  return $null
}

# --- 标题栏固定浅色 -----------------------------------------------------------
#
# DWMWA_USE_IMMERSIVE_DARK_MODE(属性 35 / 旧编号 20)的语义是 **1 = 深色、
# 0 = 浅色**。目标是"固定浅色、不跟随系统深色",所以传 0 —— 传 1 反而是要深色。
# 属性号先试 35(Win10 2004+),失败再退 20(更老的编号)。全程静默:失败就
# 保持系统默认外观,不写日志、不弹窗、不阻断弹窗本身。
function Initialize-TitleBar {
  param($Form)
  try {
    if (-not ('DscDwm' -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DscDwm {
  [DllImport("dwmapi.dll", SetLastError = true)]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
}
"@
    }
    if ($null -eq $Form) { return }
    $h = $Form.Handle
    if ($h -eq [IntPtr]::Zero) { return }
    # 属性号在不同 Windows 版本上含义不同,这里必须分开写,不能"同一个值写两遍":
    #
    #   20 = DWMWA_USE_IMMERSIVE_DARK_MODE   (BOOL,Win10 1809+)
    #   34 = DWMWA_BORDER_COLOR              (COLORREF,Win11 22000+)
    #   35 = DWMWA_CAPTION_COLOR             (COLORREF,Win11 22000+)
    #   36 = DWMWA_TEXT_COLOR                (COLORREF,Win11 22000+)
    #
    # 踩过的坑:早先以为 35 是"Win11 上的深色开关",于是浅色主题时往 35 写 0。
    # 但在 Win11 上 35 是**标题栏颜色**,0 就是纯黑 —— 结果窗体一片白、顶上一条
    # 漆黑,比原生还难看,而且 DwmSetWindowAttribute 返回 0(成功)让人以为没生效。
    # 20 才是开关,写 0 = 浅色;34/35/36 是颜色,要显式给浅色值。
    #
    # Win10 上 34/35/36 不存在,调用返回 E_INVALIDARG,无副作用,可以放心写。
    $off = 0
    [void][DscDwm]::DwmSetWindowAttribute($h, 20, [ref]$off, 4)
    # COLORREF 是 0x00BBGGRR,不是 RGB —— 白色无所谓,但别照 RGB 习惯去拼别的色。
    $caption = 0x00FFFFFF            # 白
    $text = 0x00201F1C               # 深灰字(COLORREF: B=1C G=1F R=20)
    $border = 0x00E6E2E0             # 浅灰描边(COLORREF: B=E0 G=E2 R=E6)
    [void][DscDwm]::DwmSetWindowAttribute($h, 35, [ref]$caption, 4)
    [void][DscDwm]::DwmSetWindowAttribute($h, 36, [ref]$text, 4)
    [void][DscDwm]::DwmSetWindowAttribute($h, 34, [ref]$border, 4)
  } catch { }
}

function Get-DialogLayout {
  param(
    [int]$ClientW,
    [int]$ClientH,
    [int]$ImageW,
    [int]$ImageH,
    [int]$Pad = 8,
    [int]$Gap = 6,
    [int]$BtnW = 88,
    [int]$BtnH = 32,
    [int]$ChkH = 24,
    [int]$FitW = 0,
    [int]$MinPicH = 40,
    [int]$MinNoteH = 60,
    # 窗体顶部让给"头部信息条"的高度。0 = 没有头部(老调用点与老测试照旧),
    # 非 0 时所有控件整体下移这么多,可用高度也相应减少。
    # 做成参数而不是让调用方自己加偏移:一旦两边各算一次,窗口一拉大就会
    # 出现"控件比可用区域低一截"或"按钮被顶出窗底"的错位。
    [int]$TopOffset = 0
  )
  $ImageW = [Math]::Max(1, $ImageW)
  $ImageH = [Math]::Max(1, $ImageH)
  $TopOffset = [Math]::Max(0, $TopOffset)

  $innerW = [Math]::Max(1, $ClientW - $Pad * 2)
  # 预览图与注释框**之外**的所有纵向开销:头部信息条 + 顶部内边距 + 图与注释框
  # 的间距 + 注释框与勾选框的间距 + 勾选框 + 勾选框与按钮行的间距 + 按钮行 + 下边距
  $chrome = $TopOffset + $Pad * 3 + $Gap * 2 + $ChkH + $BtnH
  # 预览图 + 注释框能共用的纵向空间
  $avail = [Math]::Max($MinPicH + $MinNoteH, $ClientH - $chrome)

  # 预览框铺满可用区域:宽 = 窗宽 - 2*pad,高 = 可用高度 - 注释框高度。
  #
  # 0.5.1 之前这里让框**贴合图片比例**,以便 Zoom 模式不留边 —— 代价是窗口
  # 被拉高时多出来的高度只能塞给注释框,图片本身一点都不变大。现在反过来:
  # 多出来的空间全归预览区,图按「铺满」比例画满它。
  $noteH = $MinNoteH
  $picW = $innerW
  $picH = [Math]::Max($MinPicH, $avail - $noteH)

  $picX = $Pad
  $picY = $TopOffset + $Pad
  $noteY = $picY + $picH + $Pad
  $chkY = $noteY + $noteH + $Gap
  $rowY = $chkY + $ChkH + $Gap

  # 「适应」按钮贴在勾选框那一行右端(齐右内边距)。$FitW 为 0 表示调用方
  # 不关心它的位置(纯布局计算的老调用点仍然只传前 5 个参数)。
  $fitX = if ($FitW -gt 0) { [Math]::Max($Pad, $Pad + $innerW - $FitW) } else { $Pad }

  return @{
    picX = $picX; picY = $picY; picW = $picW; picH = $picH
    noteX = $Pad; noteY = $noteY; noteW = $innerW; noteH = $noteH
    chkX = $Pad; chkY = $chkY
    fitX = $fitX; fitY = $chkY
    rowX = $Pad; rowY = $rowY
    innerW = $innerW
  }
}

# --- 预览缩放 ---------------------------------------------------------------
#
# 单独抽成纯函数:给定预览框大小、图片原始尺寸、缩放倍数和拖动偏移,算出图片
# 该画在框里的哪个矩形。抽出来是因为这段算术有它自己的坑(取整、居中、边界
# 钳制),脱离界面单独测比"弹个窗用眼睛看"可靠得多。
#
# Zoom = 1 表示"整张图铺满框"(cover) —— 这是默认状态,也是「适应」按钮还原的
# 状态。取的是宽高两个方向里**更松**的那一个,所以图一定盖满框、且至少一个
# 方向溢出(比例不一致时另一个方向被裁),不会出现"图缩在框中间四周一片背景"。
# 想看全图就往下滚(Zoom < 1,下限由调用方钳),那时候才留边。
#
# Zoom 更大就是放大看细节,上限由调用方钳(这里只管几何)。
#
# PanX / PanY 是**相对居中位置**的偏移(显示像素)。图没有溢出时不允许拖动
# (偏移被钳成 0,图恒居中);溢出时才允许在溢出范围内移动。
function Get-ZoomRect {
  param(
    [int]$BoxW,
    [int]$BoxH,
    [int]$ImgW,
    [int]$ImgH,
    [double]$Zoom = 1.0,
    [double]$PanX = 0.0,
    [double]$PanY = 0.0
  )
  $BoxW = [Math]::Max(1, $BoxW)
  $BoxH = [Math]::Max(1, $BoxH)
  $ImgW = [Math]::Max(1, $ImgW)
  $ImgH = [Math]::Max(1, $ImgH)

  # cover:整张图**铺满**框的缩放比(取宽高两方向里更松的那个,一定盖满、至少
  # 一边溢出);contain:整张图刚好装进框(更紧的那个,可能留边)。
  $scaleX = [double]$BoxW / [double]$ImgW
  $scaleY = [double]$BoxH / [double]$ImgH
  $cover = [Math]::Max($scaleX, $scaleY)
  $contain = [Math]::Min($scaleX, $scaleY)
  # 下限 = 缩到"整张图刚好装进框"为止。再小就没有信息量,只会多一圈背景。
  $minZoom = $contain / $cover
  $scale = $cover * [Math]::Max($minZoom, [double]$Zoom)

  $w = [Math]::Max(1, [int][Math]::Round($ImgW * $scale))
  $h = [Math]::Max(1, [int][Math]::Round($ImgH * $scale))

  # 溢出多少就允许拖多少;没溢出就只能居中。
  $maxX = [Math]::Max(0.0, ($w - $BoxW) / 2.0)
  $maxY = [Math]::Max(0.0, ($h - $BoxH) / 2.0)
  $px = [Math]::Max(-$maxX, [Math]::Min($maxX, [double]$PanX))
  $py = [Math]::Max(-$maxY, [Math]::Min($maxY, [double]$PanY))

  $x = [int][Math]::Round((($BoxW - $w) / 2.0) + $px)
  $y = [int][Math]::Round((($BoxH - $h) / 2.0) + $py)

  return @{
    x = $x; y = $y; w = $w; h = $h
    panX = $px; panY = $py
    scale = $scale
  }
}

function Show-CaptureDialog {
  param([string]$ImagePath, [int]$AutoCloseMs = 0, [int]$Seq = 0)
  # 皮肤先算:后面的度量、颜色、字体全部从这一份取,脚本里不再出现第二套数字。
  # 主题名从配置来(设置页可切),不认识的值会在 Initialize-Skin 里退回 c1。
  $skin = Initialize-Skin -Theme ([string]$config.theme)
  $m = $skin.metrics
  $skc = $skin.colors
  $skf = $skin.fonts
  $hd = $skin.header
  $scale = $skin.scale
  # 带 1/2 快捷键的窗体。编译不出来就退回普通 Form —— 弹窗本身必须照常能开,
  # 快捷键只是加分项。日志走 Write-Event,但那函数只在主脚本里存在,单独
  # 提取 Show-CaptureDialog 的测试环境没有它,所以先 Get-Command 探一下。
  $form = Initialize-KeyForm
  if ($null -eq $form) {
    try { if (Get-Command Write-Event -ErrorAction SilentlyContinue) { Write-Event @{ t = "err"; msg = "skin: keyform fallback" } } } catch { }
    $form = New-Object System.Windows.Forms.Form
  }
  $img = $null
  $autoTimer = $null
  $refreshTimer = $null
  $bridge = $null
  try {
  $form.Text = "截图分类"
  # 度量已经由 Initialize-Skin 按 DPI 显式算过一遍了。再让 WinForms 按字体
  # 自动缩放一次,等于放大两次 —— 这里关掉。
  try { $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None } catch { }
  $form.BackColor = $skc.bg
  $form.ForeColor = $skc.text
  $form.Font = $skf.title
  # SizableToolWindow:保留"工具窗"外观(无任务栏图标、窄标题栏),但**四边可拖动改大小**。
  # 早先是 FixedToolWindow,尺寸只能在设置页里填数字,想临时放大看细节就得去改配置。
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::SizableToolWindow
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.KeyPreview = $true
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  # 窗口下限不在这里定 —— 要等度量算完、ClientSize 设好之后按同一套 metrics
  # 重算(含窗口边框补偿),否则会和布局对不上。

  # 滚轮与抢前台用到的 C# 类型在这里一次编译好(后面多处要引用 [DscFocusGrab])。
  # 早先它只在 $userPaint 为真的分支里编译,一旦反射退化成原生 Zoom,连
  # SetForegroundWindow 都拿不到类型 —— 两件事本来就无关,不该绑在一起。
  Initialize-WheelBridge

  $img = [System.Drawing.Image]::FromFile($ImagePath)
  $maxW = [int]$config.previewMaxWidth
  $w = [Math]::Max(1, $img.Width)
  $h = [Math]::Max(1, $img.Height)

  $bw = $m.BtnW; $bh = $m.BtnH; $pad = $m.Pad; $gap = $m.Gap; $chkH = $m.ChkH
  # 「适应」按钮很窄,摆在勾选框那一行右端 —— 那行左边只放了「重点」,
  # 右边一直空着。放进按钮行会把窗宽下限顶高一截,不值得。
  $fitW = $m.FitW; $fitH = $m.FitH
  # 按钮行占用的最小宽度:窗宽再怎么被固定值压,也不能压到按钮排不下。
  $rowW = $pad * 2 + $bw * 2 + $gap
  $fixedW = [int]$config.width
  $fixedH = [int]$config.height

  # --- 初始尺寸 ---------------------------------------------------------------
  # 宽度:固定值优先(但不低于按钮行),否则按 previewMaxWidth。
  $totalW = if ($fixedW -gt 0) { [Math]::Max($rowW, $fixedW) } else { [Math]::Max($rowW, $maxW + $pad * 2) }

  # 自适应宽度时**不放大**小图:100x100 的图标铺到 320 宽只会变糊。
  # 窗宽跟着图片收窄(仍不低于按钮行)。固定宽度时按用户要求铺满。
  if ($fixedW -le 0 -and $w -lt ($totalW - $pad * 2)) {
    $totalW = [Math]::Max($rowW, $w + $pad * 2)
  }

  # 高度:按"预览框铺满窗宽时图片的自然高度 + 注释框自然高度"算出自然高度。
  # 算出来正好是"窗口一打开、整张图刚好铺满预览框"的尺寸;用户再拉大窗口,
  # 多出来的高度全给预览框(0.5.2 起),图跟着变大而不是注释框变高。
  # 头部信息条的高度也算进 chrome —— 它占的是窗内顶部的固定一截。
  $innerW0 = [Math]::Max(1, $totalW - $pad * 2)
  $topOffset = [int]$hd.H
  $chrome0 = $topOffset + $pad * 3 + $gap + $chkH + $gap + $bh
  $picH0 = [Math]::Max(1, [int][Math]::Round($innerW0 * ([double]$h / [double]$w)))
  $naturalH = $chrome0 + $picH0 + $m.MinNoteH

  # 固定高度以固定值为准,但不能矮到连"最小预览 + 最小注释框"都放不下。
  $totalH = if ($fixedH -gt 0) { [Math]::Max($fixedH, $chrome0 + $m.MinPicH + $m.MinNoteH) } else { $naturalH }

  $layout = Get-DialogLayout -ClientW $totalW -ClientH $totalH -ImageW $w -ImageH $h `
    -Pad $pad -Gap $gap -BtnW $bw -BtnH $bh -ChkH $chkH -FitW $fitW `
    -MinPicH $m.MinPicH -MinNoteH $m.MinNoteH -TopOffset $topOffset
  $pw = $layout.picW; $ph = $layout.picH
  $noteW = $layout.noteW; $noteH = $layout.noteH
  $noteY = $layout.noteY
  $chkY = $layout.chkY
  $rowY = $layout.rowY

  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Width = $pw
  $pic.Height = $ph
  $pic.Image = $img
  $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $pic.Location = New-Object System.Drawing.Point($layout.picX, $layout.picY)
  $pic.BackColor = $skc.panel
  $pic.BorderStyle = [System.Windows.Forms.BorderStyle]::None

  # --- 头部信息条 -------------------------------------------------------------
  # 用单独的 Panel 画,不在 Form 上直接画:
  #   ① Form 的 UserPaint 会连带影响子控件重绘,而这里只想画最上面那一条;
  #   ② 没有 DoubleBuffered 的 Form 自绘会闪,Panel 的重绘区域小得多。
  #
  # 文字放在一个 hashtable 里(不是普通变量):换图时要在事件里改它,
  # 闭包读普通标量读到的是创建时的快照,读 hashtable 成员才是活的。
  $hdrState = @{ meta = (Get-HeaderMeta -At ([datetime]::Now) -W $w -H $h) }
  $hdr = New-Object System.Windows.Forms.Panel
  $hdr.Location = New-Object System.Drawing.Point(0, 0)
  $hdr.Size = New-Object System.Drawing.Size($totalW, $topOffset)
  $hdr.BackColor = $skc.headerBg
  # Panel 也要开双缓冲,否则拖动改大小时头部会闪。
  try {
    $miHdrStyle = $hdr.GetType().GetMethod('SetStyle',
      [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
    if ($null -ne $miHdrStyle) {
      $hdrFlags = [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
                  [System.Windows.Forms.ControlStyles]::UserPaint -bor
                  [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
      [void]$miHdrStyle.Invoke($hdr, @([System.Windows.Forms.ControlStyles]$hdrFlags, $true))
    }
  } catch { }
  $hdr.Add_Paint({
    param($s, $e)
    Draw-Header -G $e.Graphics -Skin $skin -Width $hdr.Width -Meta $hdrState.meta
  }.GetNewClosure())

  # --- 缩放的绘制 -------------------------------------------------------------
  # Zoom 模式只能"整张装进框",没法放大看细节。接管绘制之后由 Get-ZoomRect
  # 算矩形,自己 DrawImage —— 放大后依然是高质量插值(HighQualityBicubic),
  # 而且能拖动查看溢出部分。
  #
  # UserPaint 必须用反射设:Control.SetStyle 是 protected,SetStyle 的公开
  # 替代品(SetStyle/UpdateStyles)不开放 UserPaint 位。设了 UserPaint +
  # AllPaintingInWmPaint + OptimizedDoubleBuffer 之后,PictureBox 的原生
  # Zoom 绘制被完全抑制,Paint 里画的才是最终像素(实测验证过)。
  $userPaint = $null
  try {
    $miSetStyle = $pic.GetType().GetMethod('SetStyle',
      [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
    if ($null -ne $miSetStyle) {
      $styleFlags = [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
                    [System.Windows.Forms.ControlStyles]::UserPaint -bor
                    [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
      [void]$miSetStyle.Invoke($pic, @([System.Windows.Forms.ControlStyles]$styleFlags, $true))
      $userPaint = $true
    }
  } catch { $userPaint = $null }

  # 预览框要能被 Tab 到、能被 Focus() —— 它是这个窗的"默认落点"。
  # 原因见下面 Shown 里的注释:焦点默认落在注释框时,快捷键 1/2 会被
  # InTextBox() 挡掉(那是故意的:在注释里打"1"不该存图),结果就是快捷键
  # 看着实现了、实际按不动。把焦点交给预览框,两边都满足。
  # PictureBox 默认 Selectable 为 false,同样只能反射设。
  try {
    $pic.TabStop = $true
    if ($null -ne $miSetStyle) {
      $selStyle = [System.Windows.Forms.ControlStyles]::Selectable
      [void]$miSetStyle.Invoke($pic, @([System.Windows.Forms.ControlStyles]$selStyle, $true))
    }
  } catch { }

  # 拖动查看溢出部分时,光标给个抓手,让"能拖"这件事被发现。
  $grabCursor = $null
  try { $grabCursor = [System.Windows.Forms.Cursors]::SizeAll } catch { }

  $noteBox = New-Object System.Windows.Forms.TextBox
  $noteBox.Multiline = $true
  $noteBox.AcceptsReturn = $true
  $noteBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $noteBox.Width = $noteW
  $noteBox.Height = $noteH
  $noteBox.Location = New-Object System.Drawing.Point($pad, $noteY)
  # 字体/配色统一从皮肤取。早先这里是写死的 Microsoft YaHei 9 —— 那是"老式感"
  # 的直接来源之一:窗口换了字,输入框还是旧字,一眼就不像同一套设计。
  $noteBox.Font = $skf.body
  $noteBox.BackColor = $skc.bg
  $noteBox.ForeColor = $skc.text
  $noteBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  try { $noteBox.PlaceholderText = "截图注释 / 评论(可选)…" } catch {}

  $chkKey = New-Object System.Windows.Forms.CheckBox
  $chkKey.Text = "重点"
  $chkKey.Width = 80; $chkKey.Height = 24
  $chkKey.Location = New-Object System.Drawing.Point($pad, $chkY)
  $chkKey.Font = $skf.body
  # 勾选框自己不带底色,底色取窗体的才不会有色块。
  $chkKey.BackColor = $skc.bg
  $chkKey.ForeColor = $skc.text
  $chkKey.Checked = $false

  # 分类下拉:默认「自动」(等 OCR 出来后按内容判),也可以当场指定一个类目。
  #
  # 放在勾选框那一行的中间空隙里 —— 那行左边是「重点」勾选框、右边是「适应」
  # 按钮,中间一直是空的。不额外占高度,也不影响按钮行的宽度下限。
  #
  # 为什么用 ComboBox 而不是一排按钮:类目有 18 个,横排放不下、竖排放会
  # 把窗口撑高一大截;下拉点开才占地方,收起时只占一行。
  #
  # 选项来自宿主写进 watcher-config.json 的 categories(源数据是 categories.mjs),
  # 这里**不再抄一份类目名** —— 抄了就会跟分类器漂。
  $catBox = New-Object System.Windows.Forms.ComboBox
  $catBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  $catBox.Font = $skf.body
  $catBox.BackColor = $skc.bg
  $catBox.ForeColor = $skc.text
  $catBox.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $catBox.Height = $chkH
  $catItems = @()
  if ($config.classifyEnabled) {
    $catItems += "自动"
    foreach ($c in @($config.categories)) { if ($c) { $catItems += [string]$c } }
  }
  # 分类开没开要单独记一个标志,不能回头去读 $catBox.Visible —— 那个属性是
  # **有效可见性**,会连带算上父窗体的状态。ShowDialog() 一返回窗体就隐藏了,
  # 那时 $catBox.Visible 恒为 $false,于是用户选的类目被当成「自动」丢掉。
  # 这个 bug 只有真点一次下拉才看得见:纯读控件属性的测试里窗体是可见的,照样通过。
  $catEnabled = $catItems.Count -gt 0
  if ($catItems.Count -gt 0) {
    foreach ($c in $catItems) { [void]$catBox.Items.Add($c) }
    $catBox.SelectedIndex = 0
    # 夹在「重点」勾选框与「适应」按钮之间。宽度按剩下的空隙算,
    # 但给一个 90px 的保底 —— 窗口很窄时下拉被压到看不见就没意义了。
    $catLeft = $pad + 80 + $gap
    $catRight = $layout.fitX - $gap
    $catBox.Location = New-Object System.Drawing.Point($catLeft, $chkY)
    $catBox.Width = [Math]::Max(90, $catRight - $catLeft)
  } else {
    # 分类被关掉时不留一个空下拉在窗口里 —— 直接隐藏。
    $catBox.Visible = $false
  }

  # 「适应」:把整张图装进框(默认状态是**铺满**,所以这个按钮是往外缩一档),
  # 同时把拖动归零 —— 用来看全图,尤其是铺满时被裁掉的那部分。
  # 放在勾选框那一行的右端 —— 那行右边原本一直空着,不占额外高度,也不
  # 影响按钮行(存文档/存图片)的宽度下限。
  # Text 里用「适应」二字,不写快捷键 —— 滚轮本身就是主入口。
  $bFit = New-FlatButton -Skin $skin -Kind 'fit'
  $bFit.Text = "适应"; $bFit.Tag = "fit"
  $bFit.Width = $fitW; $bFit.Height = $fitH
  $bFit.Location = New-Object System.Drawing.Point($layout.fitX, $layout.fitY)

  # 只有两个按钮:存文档 / 存图片。
  # 曾经的「复制截图」去掉了 —— 剪贴板本来就还是原图,这个按钮等于"什么都不做",
  # 想让剪贴板留着不动的用户直接按 Esc / 让它自动关就行。
  #
  # 主次分明:「存文档」是主操作(实心强调色),「存图片」是次要操作(白底描边)。
  # 两个都做成同一副扁平样式会让用户看不出哪个是默认动作 —— 回车默认就是存文档。
  $bDoc = New-FlatButton -Skin $skin -Kind 'doc'
  $bDoc.Text = "存文档"; $bDoc.Tag = "doc"; $bDoc.Width = $bw; $bDoc.Height = $bh
  $bDoc.Location = New-Object System.Drawing.Point($pad, $rowY)
  $bDoc.Add_Click({ $form.Tag = "doc"; $form.DialogResult = [System.Windows.Forms.DialogResult]::OK })

  $bImg = New-FlatButton -Skin $skin -Kind 'img'
  $bImg.Text = "存图片"; $bImg.Tag = "img"; $bImg.Width = $bw; $bImg.Height = $bh
  $bImg.Location = New-Object System.Drawing.Point(($pad + $bw + $gap), $rowY)
  $bImg.Add_Click({ $form.Tag = "img"; $form.DialogResult = [System.Windows.Forms.DialogResult]::Yes })

  $form.AcceptButton = $bDoc
  # Esc = 忽略(不写库、剪贴板原样保留)。窗体上没有 CancelButton 了(那个按钮就是
  # 被删掉的「复制截图」),所以 Esc 靠下面这个 KeyDown 处理器显式设 DialogResult 关窗。
  $form.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Tag = "ignore"; $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel } })

  $form.Controls.AddRange(@($hdr, $pic, $noteBox, $chkKey, $catBox, $bFit, $bDoc, $bImg))

  # --- 窗口下限 ---------------------------------------------------------------
  # 按同一套度量算「内容最少要多宽 / 多高」,再补上边框 —— 上面的注释承诺的就是
  # 这件事。早先这里是硬编码的 220x240,皮肤化之后 pad / gap / 按钮尺寸全变了,
  # 硬编码的数字会让窗口能被拖到比布局所需更小:一缩小,预览框和按钮就挤出窗框;
  # remember 模式还原一个过小的记录时,也会弹出一个畸形的窗。
  #
  # 宽度下限 = 按钮行(两个按钮 + 左右内边距),再窄按钮就排不下。
  # 高度下限 = 除预览图以外的全部纵向开销 + 最小预览 + 最小注释框。
  # 边框补偿用 Size - ClientSize 实测,不去猜系统主题的边框宽度;拿不到实测值时
  # 退回 SystemInformation 的边框/标题栏尺寸,总比按 0 算强。
  #
  # **必须写在 ClientSize 之前**:MinimumSize 一旦大于当前尺寸,WinForms 会立刻
  # 把窗体撑大并触发 Resize;那时 $relayout 还没挂上,控件会停在按小尺寸算出的
  # 位置上,窗口里白白多出一圈空白。先定下限、再定尺寸,两者就一致了。
  $minClientW = [Math]::Max($rowW, $pad * 2 + $bw * 2 + $gap)
  $minClientH = $chrome0 + $m.MinPicH + $m.MinNoteH
  $frameW = [int]($form.Size.Width - $form.ClientSize.Width)
  $frameH = [int]($form.Size.Height - $form.ClientSize.Height)
  if ($frameW -le 0) {
    $frameW = [int]([System.Windows.Forms.SystemInformation]::FrameBorderSize.Width * 2 + 2)
  }
  if ($frameH -le 0) {
    $frameH = [int]([System.Windows.Forms.SystemInformation]::FrameBorderSize.Height * 2 +
      [System.Windows.Forms.SystemInformation]::CaptionHeight)
  }
  $form.MinimumSize = New-Object System.Drawing.Size(($minClientW + $frameW), ($minClientH + $frameH))

  $form.ClientSize = New-Object System.Drawing.Size($totalW, $totalH)

  # --- 窗口状态 ---------------------------------------------------------------
  # 必须先建 $state 再挂 $relayout:GetNewClosure() 只捕获**创建闭包那一刻**
  # 已经存在的变量,晚于它定义的 $state 会永远读到 $null。
  $state = @{ left = $AutoCloseMs; autoClosed = $false; hovering = $false }
  # 窗口开着时又来了新截图 → 原地换图,不再弹第二个窗。
  #   path      : 当前窗里这张图的临时路径(关窗后由调用方负责删)
  #   image     : 当前这张图本身,换图时要 Dispose 旧的
  #   seq       : 剪贴板序列号,用来判断"有没有新的截图"
  #   refreshes : 换过几次(测试与日志用)
  $state.path = $ImagePath
  $state.image = $img
  $state.seq = $Seq
  $state.refreshes = 0
  # 缩放状态。zoom = 1 是默认状态:整张图**铺满**预览框(cover,比例不一致时
  # 有一边溢出被裁);往下滚能缩到「整张装进框」(contain),那时才留边。
  # panX / panY 是相对居中位置的偏移(显示像素),只影响放大后看得见哪一块。
  $state.zoom = 1.0
  $state.panX = 0.0
  $state.panY = 0.0
  # 拖动中的起点。$null = 没在拖。
  $state.dragFrom = $null
  $state.dragPanX = 0.0
  $state.dragPanY = 0.0

  # --- 缩放的重绘 -------------------------------------------------------------
  # 只用一处绘制逻辑:relayout / 滚轮 / 拖动 / 「适应」都改完 $state 之后叫它。
  # 走 Invalidate 而不是 Refresh:让 WM_PAINT 合并,连续滚轮不会一个格子一个
  # 格子地重画。
  $redraw = {
    try { $pic.Invalidate() } catch { }
  }.GetNewClosure()

  # --- 拖动边框改大小后的重新布局 ---------------------------------------------
  # 只有**预览图**跟着窗口伸缩:PicBox 是 Zoom 模式(等比缩放,放大不糊),
  # 拉大窗口正好是为了看清截图细节。注释框、勾选框、按钮行保持各自尺寸。
  #
  # 预览框铺满窗口的可用区域(0.5.2 起),图按「铺满」比例画进去 —— 所以
  # 框多大,图就多大,纵向和横向都不会出现大片背景边。多出来的高度全给预览框。
  # 用 $state.image 而不是构造时的 $img:窗开着时可能换过图,比例未必一样。
  # 窗口尺寸变了不用动 zoom:zoom = 1 是相对**当前框**的「铺满」,天然跟着走。
  $relayout = {
    $curImg = $state.image
    $cw = [int]$form.ClientSize.Width
    $ch = [int]$form.ClientSize.Height
    if ($null -eq $curImg -or $cw -le 0 -or $ch -le 0) { return }
    # MinPicH / MinNoteH 必须显式传:它们是**皮肤度量**(会随 DPI 缩放),不传就会
    # 回落到 Get-DialogLayout 的 40/60 默认值。那样初始布局用 64、拖一下就变 60,
    # 注释框每次拖动都莫名缩 4px —— 而且只在拉大窗口时才看得出来。
    #
    # TopOffset 同理必须传:头部信息条是固定高度,不传的话重排会当成没有头部,
    # 预览框往上一窜就压到信息条底下(第一次拖动才发现,初始布局是对的)。
    $L = Get-DialogLayout -ClientW $cw -ClientH $ch -ImageW $curImg.Width -ImageH $curImg.Height `
      -Pad $pad -Gap $gap -BtnW $bw -BtnH $bh -ChkH $chkH -FitW $fitW `
      -MinPicH $m.MinPicH -MinNoteH $m.MinNoteH -TopOffset $topOffset
    # 头部条跟着窗宽走。高度不变 —— 它是固定的一截,不随窗口长高而变厚。
    $hdr.Width = $cw
    $hdr.Height = $topOffset
    $pic.Location = New-Object System.Drawing.Point($L.picX, $L.picY)
    $pic.Size = New-Object System.Drawing.Size($L.picW, $L.picH)
    $noteBox.Location = New-Object System.Drawing.Point($L.noteX, $L.noteY)
    $noteBox.Size = New-Object System.Drawing.Size($L.noteW, $L.noteH)
    $chkKey.Location = New-Object System.Drawing.Point($L.chkX, $L.chkY)
    $bFit.Location = New-Object System.Drawing.Point($L.fitX, $L.fitY)
    if ($catBox.Visible) {
      $catLeft = $L.chkX + 80 + $gap
      $catRight = $L.fitX - $gap
      $catBox.Location = New-Object System.Drawing.Point($catLeft, $L.chkY)
      $catBox.Width = [Math]::Max(90, $catRight - $catLeft)
    }
    $bDoc.Location = New-Object System.Drawing.Point($L.rowX, $L.rowY)
    $bImg.Location = New-Object System.Drawing.Point(($L.rowX + $bw + $gap), $L.rowY)
    # 框变小了的话,原来的 pan 可能已经越界 —— 重算一遍把它钳回去,否则
    # 拖大再缩小时图会卡在边缘外面。
    if ($null -ne $state.image) {
      $R = Get-ZoomRect -BoxW $L.picW -BoxH $L.picH `
        -ImgW $state.image.Width -ImgH $state.image.Height `
        -Zoom $state.zoom -PanX $state.panX -PanY $state.panY
      $state.panX = $R.panX
      $state.panY = $R.panY
    }
  }.GetNewClosure()
  $form.Add_Resize($relayout)

  # --- 绘制 / 滚轮缩放 / 拖动 -------------------------------------------------
  # 三件事共用 $state 里的 zoom + panX/panY:
  #   Paint  : 按 Get-ZoomRect 算出的矩形画图(居中 + 偏移)
  #   滚轮   : zoom *= 1.15^步数,以**指针位置**为中心缩放(鼠标指着哪儿就
  #            放大哪儿,比固定以中心缩放顺手得多)
  #   左键拖 : 平移溢出部分
  #
  # 只有 $userPaint 为真时才接管绘制 —— 万一反射失败(理论上只有提权或裁剪
  # 运行时才会),退回原生 Zoom 行为:图照常显示,只是滚轮不生效。
  if ($userPaint) {
    $pic.Add_Paint({
      param($s, $e)
      $curImg = $state.image
      if ($null -eq $curImg) { return }
      $e.Graphics.Clear($pic.BackColor)
      $R = Get-ZoomRect -BoxW $pic.Width -BoxH $pic.Height `
        -ImgW $curImg.Width -ImgH $curImg.Height `
        -Zoom $state.zoom -PanX $state.panX -PanY $state.panY
      # 放大时用双三次插值:截图里的文字放大后依然能读。
      $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $e.Graphics.DrawImage($curImg, (New-Object System.Drawing.Rectangle($R.x, $R.y, $R.w, $R.h)))
    }.GetNewClosure())
  }

  # 缩放倍率的上下限。Zoom = 1 是「铺满」(cover);下限是「整张装进框」
  # (contain)对应的倍数 —— 再往下就是一圈纯背景,没有信息量。上限 12 倍
  # 足够看清截图里的单像素细节。下限不是常数:框和图的比例差多少,它能
  # 缩到多小就不同,所以每次按当前图算。
  $zoomMax = 12.0
  $zoomMinNow = {
    $curImg = $state.image
    if ($null -eq $curImg) { return 1.0 }
    $bw = [Math]::Max(1, $pic.Width); $bh = [Math]::Max(1, $pic.Height)
    $iw = [Math]::Max(1, $curImg.Width); $ih = [Math]::Max(1, $curImg.Height)
    $sx = [double]$bw / [double]$iw; $sy = [double]$bh / [double]$ih
    $cover = [Math]::Max($sx, $sy); $contain = [Math]::Min($sx, $sy)
    if ($cover -le 0) { return 1.0 }
    return [Math]::Max(0.05, $contain / $cover)
  }.GetNewClosure()

  # 把缩放倍数设成 $target,并让 $anchor(框内坐标)那一点尽量留在原地。
  # 不看 $anchor 时以框中心为锚 —— 「适应」和键盘重置都走这条。
  $applyZoom = {
    param([double]$target, $anchor = $null)
    $curImg = $state.image
    if ($null -eq $curImg) { return }
    $target = [Math]::Max((& $zoomMinNow), [Math]::Min($zoomMax, $target))
    if ([Math]::Abs($target - $state.zoom) -lt 0.0001) { return }

    # 缩放前:锚点在"居中坐标系"里的位置(相对框中心)
    $boxW = [Math]::Max(1, $pic.Width)
    $boxH = [Math]::Max(1, $pic.Height)
    if ($null -ne $anchor) {
      $ax = [double]$anchor.X - ($boxW / 2.0)
      $ay = [double]$anchor.Y - ($boxH / 2.0)
    } else {
      $ax = 0.0; $ay = 0.0
    }
    $ratio = $target / $state.zoom
    # 缩放后锚点该在新的居中坐标系里的同一个相对位置 → 反推 pan。
    # pan 是"图相对居中位置挪了多少",锚点位置 = ax * ratio,要保持它不动,
    # pan 就得跟着缩放的相反方向补偿。
    $state.panX = ($state.panX - $ax) * $ratio + $ax
    $state.panY = ($state.panY - $ay) * $ratio + $ay
    $state.zoom = $target

    # 交给几何函数钳制边界(图没溢出时 pan 直接被压成 0)。
    $R = Get-ZoomRect -BoxW $boxW -BoxH $boxH `
      -ImgW $curImg.Width -ImgH $curImg.Height `
      -Zoom $state.zoom -PanX $state.panX -PanY $state.panY
    $state.panX = $R.panX
    $state.panY = $R.panY
    & $redraw
    $cursor = if ($R.w -gt $boxW -or $R.h -gt $boxH) { $grabCursor } else { $null }
    try { $pic.Cursor = $cursor } catch { }
  }.GetNewClosure()

  # 「适应」= 回到"整张图刚好装进框"(contain),缩放下限 + 平移归零。
  # 注意默认状态是**铺满**(cover, zoom=1),所以点这个按钮是往外缩一档 ——
  # 它回答的是"整张图长什么样",补上铺满模式下看不到的那部分。
  $resetZoom = {
    $state.zoom = (& $zoomMinNow)
    $state.panX = 0.0
    $state.panY = 0.0
    & $redraw
    try { $pic.Cursor = $null } catch { }
  }.GetNewClosure()

  $bFit.Add_Click($resetZoom)

  # 双击预览图也回到「适应」。滚轮滚进去了却找不到按钮时,这是最顺手的退路
  # (鼠标本来就在图上)。
  $pic.Add_DoubleClick($resetZoom)

  # --- 滚轮 -------------------------------------------------------------------
  # 一档 120 是 Windows 的标准滚轮增量;乘 1.15 的几何步进,滚 5 格约 2 倍。
  #
  # 这条通道只解决"这条滚轮落在哪":WM_MOUSEWHEEL 会先过 Application 的消息
  # 过滤器,落在预览框里就消费掉,落在注释框里就返回 $false 放行(那边要滚动)。
  # 它决定不了"滚轮会不会来" —— 那由键盘焦点决定,见下面的抢前台。
  if ($userPaint) {
    $wheelHandler = {
      param([int]$sx, [int]$sy, [int]$delta)
      try {
        if ($delta -eq 0) { return $false }
        # 屏幕坐标 → 预览框客户区坐标;不在框里就不交给缩放。
        $pt = $pic.PointToClient((New-Object System.Drawing.Point($sx, $sy)))
        if ($pt.X -lt 0 -or $pt.Y -lt 0 -or $pt.X -ge $pic.Width -or $pt.Y -ge $pic.Height) {
          return $false
        }
        $steps = [double]$delta / 120.0
        $target = $state.zoom * [Math]::Pow(1.15, $steps)
        & $applyZoom $target $pt
        return $true
      } catch {
        return $false
      }
    }.GetNewClosure()

    $bridge = New-Object DscWheelBridge
    $bridge.Handler = [System.Func[int, int, int, bool]]$wheelHandler
    [System.Windows.Forms.Application]::AddMessageFilter($bridge)


    # --- 拖动 ---------------------------------------------------------------
    # 只在图溢出框时允许拖(没溢出时 pan 本来就被钳成 0,拖了也不动,干脆
    # 不换光标)。用框内坐标算位移,鼠标离开框也不影响。
    $pic.Add_MouseDown({
      param($s, $e)
      if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
      $R = Get-ZoomRect -BoxW $pic.Width -BoxH $pic.Height `
        -ImgW $state.image.Width -ImgH $state.image.Height `
        -Zoom $state.zoom -PanX $state.panX -PanY $state.panY
      if (($R.w -le $pic.Width) -and ($R.h -le $pic.Height)) { return }
      $state.dragFrom = $e.Location
      $state.dragPanX = $state.panX
      $state.dragPanY = $state.panY
      try { $pic.Cursor = [System.Windows.Forms.Cursors]::SizeAll } catch { }
    }.GetNewClosure())

    $pic.Add_MouseMove({
      param($s, $e)
      if ($null -eq $state.dragFrom) { return }
      if ($null -eq $state.image) { return }
      $dx = $e.Location.X - $state.dragFrom.X
      $dy = $e.Location.Y - $state.dragFrom.Y
      $R = Get-ZoomRect -BoxW $pic.Width -BoxH $pic.Height `
        -ImgW $state.image.Width -ImgH $state.image.Height `
        -Zoom $state.zoom -PanX ($state.dragPanX + $dx) -PanY ($state.dragPanY + $dy)
      $state.panX = $R.panX
      $state.panY = $R.panY
      & $redraw
    }.GetNewClosure())

    $endDrag = {
      $state.dragFrom = $null
      try {
        $R = Get-ZoomRect -BoxW $pic.Width -BoxH $pic.Height `
          -ImgW $state.image.Width -ImgH $state.image.Height `
          -Zoom $state.zoom -PanX $state.panX -PanY $state.panY
        $over = ($R.w -gt $pic.Width) -or ($R.h -gt $pic.Height)
        $pic.Cursor = if ($over) { $grabCursor } else { $null }
      } catch { }
    }.GetNewClosure()
    $pic.Add_MouseUp($endDrag)
    $pic.Add_MouseLeave($endDrag)
  }

  # --- 自动关闭 ---------------------------------------------------------------
  # 到点自己关窗,等同「忽略」(和 Esc 一样):剪贴板原样保留、不写库、不弹下一层。
  # 必须用 System.Windows.Forms.Timer:只有跑在 UI 消息泵里的 Timer 才能安全地
  # 改 DialogResult 再 Close;Threading.Timer / Start-Sleep 会在别的线程上动控件。
  # 计时只在窗体真正显示后开始(Add_Shown),否则构造+布局的时间也算进去。
  #
  # 鼠标停在窗口上时**不走倒计时**:指针压在窗上说明用户正在看预览 / 准备点按钮,
  # 这时候关窗是在跟人抢手。指针离开后重新给满一轮,所以"5 秒"是
  # "你不碰它 5 秒"而不是"从弹出算 5 秒"。判据用屏幕坐标比较
  # Cursor.Position 与 Form.Bounds —— 窗是按 offsetX/offsetY 摆在光标右下方,
  # 所以刚弹出时指针在窗**外**,不移动的话照常倒计时。
  #
  # 敲键盘 / 改注释 / 勾重点 / 点窗口也把倒计时喂满,免得写到一半窗没了。
  if ($AutoCloseMs -gt 0) {
    $autoTimer = New-Object System.Windows.Forms.Timer
    $autoTimer.Interval = 250
    $autoTimer.Add_Tick({
      $inside = $form.Bounds.Contains((Get-PointerPosition))
      if ($inside) {
        # 停在窗上:冻结倒计时,不关。
        $state.hovering = $true
        return
      }
      if ($state.hovering) {
        # 刚从窗上离开:给满一轮,而不是接着数那剩下的零点几秒。
        $state.hovering = $false
        $state.left = $AutoCloseMs
      }
      if ($state.left -le 0) {
        $autoTimer.Stop()
        $state.autoClosed = $true
        if (-not $form.Tag) { $form.Tag = "ignore" }
        $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Close()
        return
      }
      $state.left -= 250
    }.GetNewClosure())
    $bump = { $state.left = $AutoCloseMs }.GetNewClosure()
    $form.Add_KeyDown($bump)
    $form.Add_MouseDown($bump)
    $noteBox.Add_TextChanged($bump)
    $chkKey.Add_CheckedChanged($bump)
    $form.Add_Shown({ $autoTimer.Start() }.GetNewClosure())
  }

  # --- 窗口开着时盯新截图 -----------------------------------------------------
  # ShowDialog 是**模态**调用:它跑自己的消息泵,主循环那圈 while 在它返回之前
  # 一步都不走。所以窗口开着的时候,剪贴板其实没人看 —— 用户连截两张,
  # 第二张会被 cooldown 吞掉、或者干脆等到窗关了才处理。
  #
  # 这里挂一个 WinForms Timer 在**模态消息泵内部**轮询:发现剪贴板序列号变了、
  # 而且新内容确实是图,就地把预览换成新图,并删掉上一张临时图(用户要求
  # 「原来的截图不用」)。不弹第二个窗、不动窗口位置和大小 —— 用户可能已经把
  # 它拖到顺手的地方了。
  #
  # 为什么不在主循环里改:那要求把 ShowDialog 换成 Show + Application.Run,
  # 会连带改掉"窗关掉之后才拿到返回值"的整套控制流,风险大得多。
  #
  # 去重仍然走同一套 Test-DuplicateCapture:Windows 截图工具会在几秒内把同一张
  # 屏推两次,那种情况不该刷新(否则用户会觉得窗在闪)。
  $refreshTimer = New-Object System.Windows.Forms.Timer
  $refreshTimer.Interval = [Math]::Max(120, [int]$config.pollIntervalMs)
  $refreshTimer.Add_Tick({
    try {
      $seqNow = 0
      try { $seqNow = Get-ClipboardSeq } catch { return }
      if ($seqNow -eq $state.seq) { return }   # 剪贴板没动过
      $state.seq = $seqNow
      $newImg = Read-ClipboardImage
      if ($null -eq $newImg) { return }        # 换成文字/文件了,窗里这张留着
      $now = [DateTime]::Now
      $sig = Get-ImageSignature $newImg
      if (Test-DuplicateCapture $sig $now) {
        $newImg.Dispose()
        return
      }
      Remember-Signature $sig $now
      $newPath = Save-ClipboardImageToTemp $newImg
      if ($null -eq $newPath) {
        $newImg.Dispose()
        return
      }
      Set-DialogImage -state $state -pic $pic -newImg $newImg -newPath $newPath
      # 头部那行写着尺寸(620×1100),换图之后必须跟着改 —— 否则窗口里显示的
      # 是新图,信息条还在报上一张的尺寸,看的人会以为是同一个东西。
      $hdrState.meta = Get-HeaderMeta -At ([datetime]::Now) -W $newImg.Width -H $newImg.Height
      try { $hdr.Invalidate() } catch { }
      # 换过图就重置自动关闭倒计时:用户刚截了新图,正要看这一张。
      if ($AutoCloseMs -gt 0) { $state.left = $AutoCloseMs }
      Write-Event @{ t = "refresh"; path = $newPath; seq = $seqNow }
    } catch {
      # 定时器里抛异常会把整个消息泵带走,一律吞掉并记账。
      Write-Event @{ t = "err"; msg = "refresh: $($_.Exception.Message)" }
    }
  }.GetNewClosure())
  $form.Add_Shown({ $refreshTimer.Start() }.GetNewClosure())

  # --- 位置 ---------------------------------------------------------------
  # 三种模式各管各的,互不干扰:
  #   cursor(默认):跟着鼠标,按 offsetX/offsetY 摆在光标右下方;放不下就翻到
  #                 左上侧(历史行为,原样保留)。
  #   fixed        :出现在 fixedX/fixedY 这个**屏幕坐标**上,与鼠标无关。
  #                 多显示器下坐标系是整个虚拟桌面(副屏在主屏左边时 x 为负),
  #                 所以这里用 VirtualScreen 而不是某个 Screen 的 WorkingArea ——
  #                 否则钉在副屏上的窗会被 clamp 回主屏。
  #   remember     :沿用上次关闭时的位置和大小(**外框**矩形)。没有记录时退回
  #                 cursor 行为 —— 宁可弹在鼠标旁,也不弹在不知道哪儿的角落。
  #
  # 记录文件是**无条件写入**的(不管当前是哪个模式),只是只有 remember 读它。
  # 这样临时切到别的模式看看效果,再切回来,上次摆的位置还在。
  $totalW = [int]$totalW
  $totalH = [int]$totalH
  $remembered = $null
  if ([string]$config.positionMode -eq "remember") {
    $remembered = Get-RememberedGeometry
  }
  if ($null -ne $remembered) {
    # 记录的是**外框**矩形(Left/Top/Width/Height),所以还原也用外框,
    # 不能用 ClientSize —— 两边混着用会让窗口每开一次就胖一圈边框。
    $totalW = [Math]::Max([int]$remembered.width, [int]$form.MinimumSize.Width)
    $totalH = [Math]::Max([int]$remembered.height, [int]$form.MinimumSize.Height)
    $x = [int]$remembered.x
    $y = [int]$remembered.y
    $form.Size = New-Object System.Drawing.Size($totalW, $totalH)
  } elseif ([string]$config.positionMode -eq "fixed") {
    $x = [int]$config.fixedX
    $y = [int]$config.fixedY
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    # 只在"完全落在虚拟桌面之外"时才拉回来,不因为贴边而挪动用户指定的坐标。
    if ($x + $totalW -le $vs.Left -or $x -ge $vs.Right) {
      $x = [Math]::Max($vs.Left, [Math]::Min($x, $vs.Right - $totalW))
    }
    if ($y + $totalH -le $vs.Top -or $y -ge $vs.Bottom) {
      $y = [Math]::Max($vs.Top, [Math]::Min($y, $vs.Bottom - $totalH))
    }
  } else {
    $cursor = Get-PointerPosition
    $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
    $wa = $screen.WorkingArea
    $x = $cursor.X + [int]$config.offsetX
    $y = $cursor.Y + [int]$config.offsetY
    if ($x + $totalW -gt $wa.Right)  { $x = $cursor.X - $totalW - [int]$config.offsetX }
    if ($y + $totalH -gt $wa.Bottom) { $y = $cursor.Y - $totalH - [int]$config.offsetY }
    $x = [Math]::Max($wa.Left, $x)
    $y = [Math]::Max($wa.Top, $y)
  }
  $form.Location = New-Object System.Drawing.Point($x, $y)

  # 关窗时把外框位置记下来。所有关法都走这里 —— 按钮、Esc、右上角 X、
  # 自动关闭倒计时,对用户来说都是"我把窗放在这儿了"。
  # 用 GetNewClosure():这个处理器在 ShowDialog 的消息泵里执行,那时函数的
  # 局部作用域已经不在栈上,不捕获就会读到 $null。
  $form.Add_FormClosing({
    try {
      if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) {
        Save-RememberedGeometry $form.Left $form.Top $form.Width $form.Height
      }
    } catch { }
  }.GetNewClosure())

  # --- 抢前台 -----------------------------------------------------------------
  # 见 DscFocusGrab 的注释:滚轮只发给有键盘焦点的窗口,而隐藏 spawn 的弹窗抢不到
  # 前台,结果就是"图能看见、滚轮没反应"。显示的一瞬间抢一次,之后用户点窗内再补
  # 一次(他可能先点了别处)。全程不移动鼠标。
  $grabFocus = {
    try {
      if ($null -eq $form -or $form.IsDisposed) { return $false }
      $ok = [DscFocusGrab]::Grab($form.Handle)
      return $ok
    } catch { return $false }
  }.GetNewClosure()
  $form.Add_Shown({ [void](& $grabFocus) }.GetNewClosure())
  # 焦点默认落在注释框(它是 Tab 序里第一个可选中的控件)。这会让快捷键 1/2
  # 失效:DscFastForm.ProcessCmdKey 里 InTextBox() 会挡住文本框里的数字键 ——
  # 那是**故意**的(在注释里打"1"不该把图存了),但代价是弹窗一开快捷键就按不动。
  # 把初始焦点交给预览框:它在 Tab 序里靠前、又永远不是文本框,两边都满足。
  # 放在 Shown 里而不是构造期,是因为控件要等布局跑完才定得下位置。
  $form.Add_Shown({
    try { if ($null -ne $pic -and -not $pic.IsDisposed) { [void]$pic.Focus() } } catch { }
  }.GetNewClosure())
  # 标题栏染色要等句柄真的建出来 —— 构造期 Handle 还是 Zero,调 DWM 会静默失败。
  # 放在 Shown 里而不是构造函数里,就是为了这一句能生效。
  $form.Add_Shown({ try { Initialize-TitleBar -Form $form } catch { } }.GetNewClosure())
  $form.Add_MouseDown({ [void](& $grabFocus) }.GetNewClosure())
  [void]$form.ShowDialog()
  if ($autoTimer) { $autoTimer.Stop() }
  if ($null -ne $refreshTimer) { $refreshTimer.Stop() }
  $action = if ($form.Tag) { $form.Tag.ToString() } else { "ignore" }
  $note = $noteBox.Text.Trim()
  $isKey = [bool]$chkKey.Checked
  # path 是**最终**显示的那张:窗口开着时换过图的话,它已经不是传进来的 $ImagePath 了。
  # 调用方要拿它写 choice 事件,否则存进库的是第一张、用户看到的是最后一张。
  # 用户选的类目:"自动"= 空串(交给宿主按 OCR 内容判),具体类目名 = 照用。
  # 索引 0 永远是「自动」;分类被关掉时下拉是隐藏的,也一律当自动。
  #
  # 判断"分类开没开"必须用 $catEnabled,不能用 $catBox.Visible:后者是有效可见性,
  # ShowDialog() 返回后窗体已隐藏,恒为 $false —— 用它就会把用户选的类目静默丢掉。
  $category = ""
  if ($catEnabled -and $catBox.SelectedIndex -gt 0) {
    $category = [string]$catBox.SelectedItem
  }

  return @{
    action = $action; note = $note; isKey = $isKey
    autoClosed = [bool]$state.autoClosed
    path = $state.path
    refreshes = [int]$state.refreshes
    category = $category
  }
  } finally {
    # 消息过滤器必须注销:它挂在 Application 上、活到进程结束,不摘掉的话
    # 每弹一次窗就多一个过滤器,而且都还指着已经 Dispose 掉的控件。
    if ($null -ne $bridge) {
      try { [System.Windows.Forms.Application]::RemoveMessageFilter($bridge) } catch { }
    }
    # 全局钩子同理,而且更严重:它活在系统钩子链里,不摘就会在预览框被 Dispose
    # 之后继续被回调。Windows 超时还会把钩子从链上静默摘掉,所以必须显式卸载。
    if ($null -ne $autoTimer) { $autoTimer.Dispose() }
    if ($null -ne $refreshTimer) { $refreshTimer.Dispose() }
    # 换过图的话,$img 早在 Set-DialogImage 里释放过了;这里要释放的是
    # 窗里**当前**那张(两者相同时只释放一次)。
    if ($null -ne $state -and $null -ne $state.image -and (-not [object]::ReferenceEquals($state.image, $img))) {
      try { $state.image.Dispose() } catch { }
    }
    if ($null -ne $form) { $form.Dispose() }
    if ($null -ne $img) { $img.Dispose() }
  }
}

Write-Event @{ t = "ready" }
$lastSeq = Get-ClipboardSeq
$lastHandled = [DateTime]::Now

while ($true) {
  Start-Sleep -Milliseconds ([int]$config.pollIntervalMs)
  $seq = 0
  try { $seq = Get-ClipboardSeq } catch { continue }
  if ($seq -eq $lastSeq) { continue }
  $lastSeq = $seq
  $now = [DateTime]::Now
  if (($now - $lastHandled).TotalMilliseconds -lt [int]$config.cooldownMs) { continue }
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { continue }
  $img = $null
  try { $img = [System.Windows.Forms.Clipboard]::GetImage() } catch { continue }
  if ($null -eq $img) { continue }
  $sig = Get-ImageSignature $img
  if (Test-DuplicateCapture $sig $now) {
    $img.Dispose()
    Write-Event @{ t = "dup"; seq = $seq }
    continue
  }
  Remember-Signature $sig $now
  $lastHandled = $now
  $pngPath = Save-ClipboardImageToTemp $img
  $img.Dispose()
  if ($null -eq $pngPath) { continue }
  Write-Event @{ t = "img"; path = $pngPath; seq = $seq }

  if ($AutoAction) {
    if ($AutoAction -ne "none") { Write-Event @{ t = "choice"; action = $AutoAction; path = $pngPath } }
    if ($Once) { break }
    continue
  }

  $res = @{ action = "ignore"; note = ""; isKey = $false; autoClosed = $false; path = $pngPath; refreshes = 0; category = "" }
  $autoCloseMs = [int](($config.autoCloseSec * 1000))
  try { $res = Show-CaptureDialog -ImagePath $pngPath -AutoCloseMs $autoCloseMs -Seq $seq } catch {
    Write-Event @{ t = "err"; msg = "dialog: $($_.Exception.Message)" }
  }
  # 窗开着时换过图的话,$res.path 是**最后那张**,不是 $pngPath。
  # 存库得按用户真正看到的那张来,否则存进去的和眼前的对不上。
  # 换图时 Set-DialogImage 已经删掉被替掉的那几张,这里只补刀。
  if ($res.path -and ($res.path -ne $pngPath)) {
    try { Remove-Item -LiteralPath $pngPath -Force -ErrorAction SilentlyContinue } catch { }
  }
  $choicePath = if ($res.path) { $res.path } else { $pngPath }
  Write-Event @{ t = "choice"; action = $res.action; path = $choicePath; note = $res.note; isKey = $res.isKey; autoClosed = $res.autoClosed; category = $res.category }
  # 主循环也要跟上:窗里已经消化掉的那几次刷新,别在这儿又当成新图弹一遍。
  try { $lastSeq = Get-ClipboardSeq } catch { }
  if ($Once) { break }
}
