#requires -Version 5
# 快捷键 1 / 2 到底走不走得通?
#
# 早先只断言过"源码里有 ProcessCmdKey 分支",那证明不了什么。第一版还试过
# SendKeys 真的发按键 —— 在后台/无交互桌面上它根本不返回,测试挂死两分钟。
#
# 这里换个办法:直接反射调用 DscFastForm.ProcessCmdKey。它本身就是 WinForms
# 把按键送进窗体的唯一入口,绕过 SendKeys 只是省掉了"键怎么从桌面走到窗体"
# 这一段 —— 而那段是 Windows 的职责,不是我们的代码要负责的。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# 用 $PSScriptRoot 推路径,不要写死绝对路径 —— 别人把仓库克隆到别处,
# 写死的那种会在第一行就报「找不到文件」,而原因看起来像是脚本坏了。
$srcPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\clip-dialog.ps1'
if (-not (Test-Path $srcPath)) { throw "找不到 $srcPath" }
$src = [System.IO.File]::ReadAllText($srcPath, [System.Text.UTF8Encoding]::new($false))

function Get-FnSource([string]$text, [string]$name) {
  $idx = $text.IndexOf("function $name")
  if ($idx -lt 0) { throw "脚本里没有 $name" }
  $rest = $text.Substring($idx + "function $name".Length)
  if ($rest.Length -gt 0) {
    $c = $rest[0]
    if (-not ($c -eq '(' -or $c -eq '{' -or [char]::IsWhiteSpace($c))) { throw "命中前缀但不是 $name" }
  }
  $start = $text.IndexOf('{', $idx)
  $depth = 0
  for ($i = $start; $i -lt $text.Length; $i++) {
    if ($text[$i] -eq '{') { $depth++ }
    elseif ($text[$i] -eq '}') { $depth--; if ($depth -eq 0) { return $text.Substring($idx, $i - $idx + 1) } }
  }
  throw "花括号没配平: $name"
}

Invoke-Expression (Get-FnSource $src 'Initialize-KeyForm')

$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "PASS $name" } else { "FAIL $name - $detail"; $script:fail++ }
}

$form = Initialize-KeyForm
Check 'Initialize-KeyForm 拿到 DscFastForm 实例' ($null -ne $form) '返回了 $null(Add-Type 失败?)'
if ($null -eq $form) { '[key-test] 无法继续'; exit 1 }
Check '类型是 DscFastForm(不是退化的普通 Form)' ($form.GetType().Name -eq 'DscFastForm') "实际 $($form.GetType().Name)"

# ProcessCmdKey 是 protected,只能反射调。
$mi = $form.GetType().GetMethod('ProcessCmdKey',
  [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
Check 'ProcessCmdKey 存在' ($null -ne $mi) '反射没找到 ProcessCmdKey'
if ($null -eq $mi) { '[key-test] 无法继续'; exit 1 }

$msg = New-Object System.Windows.Forms.Message

function Send-Key([System.Windows.Forms.Keys]$key) {
  $args2 = @($msg, $key)
  return [bool]$mi.Invoke($form, $args2)
}

# --- 焦点不在文本框(默认情况:预览框) ------------------------------------
$form.Tag = $null
$handled = Send-Key ([System.Windows.Forms.Keys]::D1)
Check '按 1 被 ProcessCmdKey 接住' ($handled -eq $true) "handled=$handled"
Check '按 1 把 Tag 设成 doc' ("$($form.Tag)" -eq 'doc') "Tag=$($form.Tag)"
Check '按 1 把 DialogResult 设成 OK' ($form.DialogResult -eq [System.Windows.Forms.DialogResult]::OK) "DialogResult=$($form.DialogResult)"

$form.Tag = $null
$form.DialogResult = [System.Windows.Forms.DialogResult]::None
$handled = Send-Key ([System.Windows.Forms.Keys]::NumPad2)
Check '小键盘 2 也能接住' ($handled -eq $true) "handled=$handled"
Check '按 2 把 Tag 设成 img' ("$($form.Tag)" -eq 'img') "Tag=$($form.Tag)"
Check '按 2 把 DialogResult 设成 Yes' ($form.DialogResult -eq [System.Windows.Forms.DialogResult]::Yes) "DialogResult=$($form.DialogResult)"

# --- 焦点在注释框:数字键必须放行(否则在注释里打"1"就误存) --------------
$tb = New-Object System.Windows.Forms.TextBox
$form.Controls.Add($tb)
$form.ActiveControl = $tb
$form.Tag = $null
$form.DialogResult = [System.Windows.Forms.DialogResult]::None
$handled = Send-Key ([System.Windows.Forms.Keys]::D1)
Check '焦点在注释框时 1 不被接住' ($handled -eq $false) "handled=$handled"
Check '焦点在注释框时 Tag 没被改' ("$($form.Tag)" -eq '') "Tag=$($form.Tag)"

$form.ActiveControl = $null
$form.Controls.Remove($tb)
$tb.Dispose()

# --- 其它键放行 ------------------------------------------------------------
$form.Tag = $null
$handled = Send-Key ([System.Windows.Forms.Keys]::D3)
Check '按 3 不被接住(没有这个快捷键)' ($handled -eq $false) "handled=$handled"

# --- 源码层:初始焦点必须交给预览框 ----------------------------------------
# 光有 ProcessCmdKey 不够 —— 弹窗一开焦点若在注释框,InTextBox() 会让 1/2
# 全部失效。这条钉住"Shown 里把焦点给预览框"这件事本身。
Check 'Shown 里把焦点交给预览框' ($src.Contains('$pic.Focus()')) '缺 $pic.Focus()'
Check '预览框被设为可选中' ($src.Contains('ControlStyles]::Selectable') -and $src.Contains('$pic.TabStop = $true')) '预览框不可选中,Focus() 会失败'

$form.Dispose()
if ($script:fail -eq 0) { '[key-test] 全部通过' } else { "[key-test] $($script:fail) 项失败" }
exit $script:fail
