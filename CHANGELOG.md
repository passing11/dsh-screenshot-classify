# Changelog

本项目沿用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法。

## [0.3.1] - 2026-11-15

修一个只有在真机点一次下拉才看得见的 bug：弹窗里选的类目被静默丢弃。

### 修复

- **手选的类目回不到宿主**（`clip-dialog.ps1`）。返回值的判断原本写成
  `if ($catBox.Visible -and $catBox.SelectedIndex -gt 0)`，而 `Control.Visible` 是
  **有效可见性** —— 它会连带算父容器的状态。`ShowDialog()` 返回的那一刻窗体已经
  隐藏，这个属性恒为 `$false`，于是用户在下拉里选了「学习资料」、按钮也点了，最后
  送回去的 `category` 是空的，条目按自动分类入库，用户的选择白做。

  改成建下拉时就记一个独立标志 `$catEnabled = $catItems.Count -gt 0`，返回时只看
  它和 `SelectedIndex`。分类开关是「配置里有没有类目」，这件事跟控件当前可不可见
  是两回事，不该回头去读一个会随窗体状态变化的值。

- **为什么之前的测试没抓到**：那些断言都在 Timer 里读控件，那时窗体还可见，
  `Visible` 是 `$true`，判断看起来完全正常。**读控件属性证明不了返回值对** ——
  必须真的走一遍「选中 → 点按钮 → 看 ShowDialog 返回什么」。

### 新增

- **`test/test-dialog-category.ps1`**（12 项）：真的弹窗、真的选中类目、真的点
  「存文档」、检查 `ShowCaptureDialog` 返回的 `category`。覆盖「选了能带出来」
  「不选时是空串」「分类关掉时下拉 0 项且 category 空」三种情况，外加两条源码层
  断言钉住旧写法不许回来（`if ($catBox.Visible -and` 必须消失、
  `if ($catEnabled -and` 必须存在）。
- `npm run test:window:category`。

### 测试

- 11 个 PowerShell 套件 **338 项全 PASS**（比 0.3.0 多出 category 那 12 项）。
- 9 个 JS 套件全 exit=0。

### 测试不再打扰主屏

- 10 处模拟指针原本都钉在 `PrimaryScreen` 左上角，弹窗就跟着出现在主屏上。现在
  改成优先挑一块**非主屏**，只有一块屏时才退回主屏。用单条表达式而不是辅助函数：
  这些测试各自抠函数独立执行，加一个全局函数漏定义一处就是
  `CommandNotFoundException`。

## [0.3.0] - 2026-11-15

弹窗改名并加上主题。0.2.0 把外观从「Windows 默认」拉到了「浅色现代扁平」，但只有
一套配色、且窗口标题和窗内大标题写了两遍同一个名字。这一版解决这两件事。

### 改名

- **窗口标题「截图入库」→「截图分类」**（`clip-dialog.ps1`）。设置页导航名同步改成
  「截图分类」/ "Screenshot Classify"。工具名 `screenshot_*` 与笔记格式不变 —— 那些
  是接口和存档格式，改名会让已有的笔记和调用脚本一起断掉。
- **头部不再重复标题**：窗体标题栏已经写着「截图分类」，窗内原本又来一行大标题，
  同一个名字在同一个窗里出现两遍。现在头部改成一条 44px 高的**信息条**，只放这一次
  截图的元信息：`待入库 · 22:19 · 620×1100`。写「待入库」不写「已入库」—— 弹窗这
  一刻图还没落库，写已入库是假话。

### 新增

- **四套主题**（`c1` 青碧扫描 / `c2` 靛蓝取景 / `c3` 石墨取景 / `c4` 紫罗兰取景），
  设置页「弹窗」分组里一键切换。四套**只换配色与头部图标画法**，布局和操作完全
  一致 —— 所以切换不会让用户重新学一遍怎么用。
- **头部图标**（`Draw-Header`）：四角括号 = 取景框，中间那道线 = 识别。四套的括号
  粗细（1.4~2.2）与中线画法（单线 / 双线 / 实心条 / 断线加中点圆）都不同，所以换
  主题是一眼能看出来的，不只是换了颜色。
- **`Get-HeaderMeta`**：`待入库 · HH:mm · W×H`。换图时会跟着更新 —— 否则窗里是新
  图、信息条还报上一张的尺寸。
- **`Get-DialogLayout` 新增 `-TopOffset` 参数**：头部占的高度由布局函数统一从可用
  高度里扣，而不是让调用方自己减。两边各算一次的话，窗口一拉大就会错位（预览框往
  上窜、压到信息条底下）。

### 修复

- **`$relayout` 漏传 `-TopOffset`**：初始布局是对的，第一次拖动才发现预览框跑到信息
  条底下 —— 这正是「两边各算一次」会出的错。
- **换图后信息条不更新**：`Set-DialogImage` 之后没有重算 `$hdrState.meta`，窗口里是
  新图、尺寸还是上一张的。
- **`Initialize-Skin` 注释与实现不一致**：注释说头部高度「由 Show-CaptureDialog 自己
  从可用高度里扣」，实际改成走 `-TopOffset` 参数了，注释同步改掉。

### 测试

- 10 个 PowerShell 套件 **326 项全 PASS**：layout-calc 102 / layout 22 / resize 30 /
  fixed 15 / remember 29 / autoclose-dialog 13 / autoclose-hover 11 / dialog-refresh 45 /
  zoom-calc 45 / keys 14。
- 9 个 JS 套件全 exit=0。`test-config-shape.mjs` 新增两条：`dialogTheme` 必须在 Config
  schema 里（漏了会表现为「设置页改了没反应」）、`dialogTheme: "c9"` 必须被拒（否则
  一路传到 PowerShell 静默退回 c1，用户以为换了其实没换）。
- 9 个 ps1 测试的窗标题码点从「截图入库」改成「截图分类」
  （`0x622A 0x56FE 0x5206 0x7C7B`），并在抠函数列表里补上 `Draw-Header` /
  `Get-HeaderMeta` —— 漏一个就是 `CommandNotFoundException`。

### 渲染验证的坑（第三次踩，记下来）

- **`TextRenderer.DrawText` 不认 `Graphics.TranslateTransform`**。它走 GDI 而不是
  GDI+，变换矩阵对它无效 —— 想在位图上「平移着画」会把文字画到绝对坐标 0,0。真弹窗
  没这个问题（`Panel.Paint` 给的 Graphics 原点本就是客户区左上角），但离屏渲染必须
  先画到独立位图再贴回主图。
- 真窗口渲染三条路都试过了，全不可靠：`Show()` 无消息泵 → `PrintWindow` 永远等不到
  响应；`ShowDialog()` + 一次性 Timer → 只出第一张；`PrintWindow` +
  `PW_RENDERFULLCONTENT` 对 DWM 合成窗口会叠红色斜线伪影。**结论：样张用纯 GDI+
  离屏绘制，落地效果以真机为准。**

## [0.2.0] - 2026-11-14

弹窗界面重做。原来那套是 Windows 默认外观：系统灰底、Tahoma/宋体、方角细边、
两个按钮毫无主次、类目下拉是原生 ComboBox。现在换成浅色现代扁平，配色固定一套
（不跟随系统主题，免得深色模式下白底截图框配黑字看不清）。

### 新增

- **皮肤层 `Initialize-Skin`**：一处定义配色、字体、间距，全部按 DPI 缩放。返回
  `@{colors; fonts; metrics; scale}`，`scale` 由 `Graphics.DpiX / 96` 算出。颜色 10 个键
  （`bg` 白 / `panel` 浅灰 / `border` / `text` / `textDim` / `accent` 蓝 / `accentHover` /
  `accentPress` / `secondaryHover` / `secondaryPress`），字体三档（标题 10.5 / 正文 10 /
  按钮 10，族名 `Microsoft YaHei UI`）。
- **自绘按钮 `New-FlatButton`**：圆角、悬停/按下/焦点三态、主操作实心强调色、次要操作
  白底描边。**故意不用 `Add-Type` 子类**，理由是两条：① 子类 `OnPaint` 在
  `DrawToBitmap` 下不被采信，渲染验证做不了；② 多个测试按 `GetType().Name -eq 'Button'`
  筛控件，子类会让筛选结果为空。改为 `FlatStyle=Flat` + 反射开 `UserPaint` 自绘。
- **快捷键 `1` / `2`**：`Initialize-KeyForm` 用 `Add-Type` 定义 `DscFastForm`，只重写
  `ProcessCmdKey` —— 数字 1（含小键盘）等于「存文档」，2 等于「存图片」。走
  `ProcessCmdKey` 而不是 `KeyDown`，因为焦点在 ComboBox 或注释框时 `KeyDown` 会被控件
  吞掉。编译失败时回退成普通 `Form`，功能不受影响。- **标题栏染色 `Initialize-TitleBar`**：白底、深灰字、浅灰描边。

### 修复

- **皮肤函数只定义、从未被调用**：`New-FlatButton` / `Initialize-TitleBar` 写好了却没人
  调，按钮仍是原生描边、字体仍写死 `Microsoft YaHei 9`。这是「改完还是老样子」的真正
  原因。现在三个按钮、注释框、勾选框、下拉全部走皮肤，标题栏在 `Shown` 里染（构造期
  `$form.Handle` 还是 Zero，DWM 会静默失败）。
- **黑标题栏**：早先以为「DWM 属性 35 是 Win11 的深色开关」，浅色主题时往 35 写 `0`。
  Win11 的属性号实际是 `20 = USE_IMMERSIVE_DARK_MODE (BOOL)`、`34 = BORDER_COLOR`、
  `35 = CAPTION_COLOR`、`36 = TEXT_COLOR`（后三个是 COLORREF，Win11 22000+）。**往 35
  写 0 = 把标题栏涂成纯黑，而 `DwmSetWindowAttribute` 返回 0（成功），极具误导性。**
  现在 20 写 0 关深色，35/36/34 分别写白 / 深灰字 / 浅灰边；COLORREF 是 `0x00BBGGRR`
  不是 RGB。Win10 上 34/35/36 不存在，调用返回 `E_INVALIDARG` 但无副作用。
- **窗口最小尺寸丢失**：`$form.MinimumSize` 赋值整行被删，导致「记住上次位置」分支里的
  `Max($remembered.width, $form.MinimumSize.Width)` 读到 0，窗口能被缩到 64x41、勾选框
  和按钮被挤出窗外。现在按皮肤度量重算并加边框补偿（`$form.Size - $form.ClientSize`），
  实测下限 264x265。**赋值必须插在 `$form.ClientSize = ...` 之前** —— MinimumSize 一旦
  大于当前尺寸，WinForms 会立刻撑大并触发 Resize，那时 `$relayout` 还没挂上，控件会停在
  按小尺寸算的位置。
- **`$relayout` 漏传度量**：拖动窗口时调 `Get-DialogLayout` 只传了 Pad/Gap/BtnW/BtnH/FitW，
  没传 `MinPicH`/`MinNoteH`，回落到默认 40/60，注释框每拖一次缩 4px。现在补齐。

- **快捷键等于没做（真实缺陷）**：`ProcessCmdKey` 写得没错，但弹窗一打开焦点默认落在
  **注释框**（它是 Tab 序里第一个可选中的控件），而 `InTextBox()` 会故意挡掉文本框里的
  数字键 —— 那是为了「在注释里打 1 不该把图存了」。两边各自都对，合起来就是快捷键按不动。
  修法：把预览框设为 `Selectable` + `TabStop`，并在 `Add_Shown` 里 `$pic.Focus()`，让初始
  焦点落在预览框。`PictureBox` 默认不可选中，`Selectable` 位同样只能反射设。

### 界面细节

- 标题栏文字仍由系统画（`SizableToolWindow` 不接管非客户区），只改了底色与文字色。
- 布局守恒式没变：窗口高 = 上边距 + 预览 + 边距 + 注释 + Gap + 勾选 + Gap + 按钮 + 边距。
  皮肤化把两个硬编码的 `10` 换成了 `Gap`，所以数字从 96→92、180→184、444→448。
  测试断言改成守恒式（`$Pad*3 + $Gap*2 + $ChkH + $BtnH`）而不是换一个魔法数字。

### 测试

- 10 个 PowerShell 套件 **326 项全 PASS**：layout-calc 102 / layout 22 / resize 30 /
  fixed 15 / remember 29 / autoclose-dialog 13 / autoclose-hover 11 / dialog-refresh 45 /
  zoom-calc 45 / keys 14。
- 新增 `test-dialog-keys.ps1`（14 项）：**直接反射调 `ProcessCmdKey`**，不靠 SendKeys。
  试过 SendKeys，在无交互桌面/后台 shell 里它根本不返回，测试挂死两分钟（实测两次）。
  反射调用绕过的是「键怎么从桌面走到窗体」—— 那段是 Windows 的职责，不是我们的代码要
  负责的。断言覆盖：1 → `Tag=doc` + `DialogResult=OK`、小键盘 2 → `Tag=img` +
  `DialogResult=Yes`、焦点在注释框时 1 **不被接住**（防「删掉 InTextBox() 让快捷键更灵、
  但用户打数字就误存」的回归）、按 3 放行、源码层钉住 `$pic.Focus()` 与
  `ControlStyles::Selectable`。
- 两个 autoclose 套件加了**预热**：第一次弹窗要编译四个 C# 类型（`DscWheelBridge` /
  `DscFocusGrab` / `DscFastForm` / `DscDwm`），实测合计 400~500ms，加上加载图片、算度量、
  建控件，首次约 1.6~1.8 秒。真机上弹窗进程长驻，这笔钱只付一次；但测试每次都是新进程，
  不预热就会把编译开销算进「关闭时刻」，让计时断言看起来像倒计时变慢了。所以先弹一次
  1ms 自动关的窗。**预热必须放在 `$tmp` 图片生成之后** —— 第一次插在 `$tmp` 创建之前，
  `Show-CaptureDialog` 拿到空路径直接报错，预热形同虚设。
- 按钮计数断言从 `New-Object System.Windows.Forms.Button` 改为数 `New-FlatButton -Skin`
  （0.2.0 起按钮统一由前者造，旧断言数到 0）。
- 9 个 JS 套件全 exit=0（本次没动 JS，跑一遍确认没连带）。

### 渲染验证的坑

- `DrawToBitmap` **抓不到 `UserPaint` 自绘像素**，输出里按钮显示成原生描边、预览框全空
  —— 它会说谎，不能用来验收。
- `CopyFromScreen` 受 `Bounds` 过期与窗口遮挡影响，截出来缺半边。
- **只有 `PrintWindow` + `PW_RENDERFULLCONTENT`（flag=2）能拿到真实像素。**
- 比截图更可靠的是属性探针：直接读控件属性（字体族名、`BackColor`、反射 `GetStyle`
  验证 `UserPaint` 为 True），不依赖像素。

## [0.1.0] - 2026-11-13

首个版本。基于 [`dsh-screenshot-capture`](https://github.com/passing11/dsh-screenshot-capture) 0.4.8
的采集链路重写，把 [`dsh-photo-organizer`](../dsh-photo-organizer) 的规则分类器接到「截图入库」上。

### 新增

- **自动分类**（`classify.mjs` + `categories.mjs`）：18 个类目的纯本地规则引擎，免费、瞬时、离线。
  类目搬进独立的 `categories.mjs` 作为单一数据源 —— 宿主侧、弹窗下拉、设置页都用这一份，
  免得三处各抄一遍然后互相漂。
- **类目写进笔记标题行**：`## 14:30 #文档 #学习资料`。第二个 `#标签` 就是类目，
  在 Obsidian 里点它能直接筛。
- **弱判定单列一行**：`> 分类: 梗图表情包（弱）`。**不动标题行**，
  这样标签检索永远干净，「这条别太信」的信息也不丢。
- **弹窗类目下拉**（`scripts/clip-dialog.ps1` 新增 `$catBox`）：默认「自动」（等 OCR 后按内容判），
  也可以当场指定具体类目。夹在「重点」复选框与「适应」按钮之间的空隙里，
  不额外占高度、不抬高窗宽下限。选项由宿主写进 `watcher-config.json` 传下来，
  ps1 里不抄第二份类目表。
- **文档摘要**（`summarize.mjs`）：`off` / `rules`（本地抽取式，免费）/ `host`（宿主文本模型）。
  默认 `rules`。只对 `#文档` 生效，`#图片` 不跑 OCR、没有文字可总结。
- **证据分档**：每条判定带 `evidence ∈ {strong, camera, weak, fallback, manual}`，
  置信度按证据给而不是按分数给 —— `weak` 压到 0.3~0.4，`fallback` 固定 0.2。
  让「判不准」在笔记里看得见，而不是假装很确定。
- **晚间整理沿用入库类目**：类目优先级「当晚手动指定 > 入库时判定 > 未分类」。
  不这么做的话，自动分类会在归档那一步被抹平成一张「未分类」大杂烩。
- **知识库笔记新增 `## 摘要` 一节**，排在 `## 文字` 之前 —— 摘要是给人扫的，原文是给人核的。
- 设置页新增两个分组：**分类**（开关 + 弱判定阈值）与**摘要**（模式 / 模型 / 长度）。

### 修复（都只在真实宿主里才暴露）

- **`defineTool` 的 `parameters` 必须是扁平属性映射**，不是 JSON Schema 对象。
  写成 `{ type: "object", properties: {...} }` 会让整个插件不激活，
  报 `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`。
  无参数的工具写 `parameters: {}`。
- **Volatile 字段是 cell 不是值**：DSH 0.2.x 把盖过 `.volatile()` 的字段包成 `{ get(): value }`，
  `JSON.stringify(cell)` → `{}`。配置读取处必须先解包，否则 18 个字段会全变成空对象，
  然后 `config.vaultPath.trim()` 抛 `is not a function`。
- **设置页 `scope.set()` 被宿主拒绝时 resolve `false` 而不是 reject**，旧写法会误报「已保存」。
  现在判 `ok !== false` 并重试一次（宿主用 revision 乐观并发，插件每次重载 revision 都变，
  首次写必被拒，镜像刷新后重试即成功）。

### 分类质量：三条被实测推翻的规则

都写进了 `categories.mjs` / `classify.mjs` 的注释里，防止后人「顺手优化」又加回来：

1. **裸时间正则不能当证据**。`\d{1,2}[：:]\d{2}` 单独命中 922 张（手机截图状态栏永远有「16:12」），
   把「生活日常」顶到 21%。
2. **形态学不能选类目**。「文字 < 40 字」曾同时给「梗图表情包」和「二次元」各 +0.7，
   982 张的冠军由类目表声明顺序决定。
3. **目录先验不能对有文字的图生效**。「从哪个 App 存的」回答不了「画面画的是什么」；
   降到 0.4 仍独赢 2310 张。本插件干脆不用目录。

另外，**「无文字 → 摄影/二次元/梗图各 +1.4」整段删掉了** —— 让「没有文字」这张票平均分给三个类目，
冠军又由声明顺序决定，无文字截图会莫名变成「摄影」，而摄影的语义是相机直出。

### 与 dsh-screenshot-capture 的关系

- 采集链路（剪贴板监听、悬浮窗、OCR、原子写入、晚间整理）**原样保留**。
- 新插件 id / 设置命名空间与旧插件不同（`dsh-screenshot-classify`），
  否则两份 Config schema 会互相覆盖。
- 旧配置通过 `LEGACY_SETTINGS_NS = "dsh-screenshot-capture"` 兜底读取，
  装完即用，`vaultPath` / `ocrMode` / 弹窗位置全部沿用。
- **两者不能同时启用** —— 同一个剪贴板监听两次会弹两个窗、同一张图入库两次。
  装好本插件后请停用 `dsh-screenshot-capture`。

### 测试

| 套件 | 项数 | 内容 |
|---|---|---|
| `test-format.mjs` | 19 | 笔记块格式、弱行/摘要行幂等、老格式兼容 |
| `test-classify.mjs` | 48 | 分类规则（含上面四条被推翻的规则） |
| `test-summarize.mjs` | 42 | 抽取式摘要、清洗、host 降级、永不抛错 |
| `test-storage.mjs` | — | 入库/回填/整理全链路 + 类目不被抹平 |
| `test-dialog-layout.ps1` | 22 | 悬浮窗布局 + **类目下拉位置**（含 drag 后不越界） |
| 其余 5 个 | — | reasoning / autoclose / config-shape / single-instance / settings-reload |

合计 **9 个 JS 套件 + 9 个 PowerShell 窗口套件**全绿。

`test-single-instance` 需要写 `~/.dsh/dsh-screenshot-capture/watcher.lock`；
在受限沙箱里会 **跳过并说明原因**，而不是把「环境不允许」报成「锁坏了」。
