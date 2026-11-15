/**
 * 类目表。移植自 dsh-photo-organizer（同一套 18 类），**单一数据源**。
 *
 * 为什么单独一个文件：宿主侧（core.mjs）、弹窗下拉（watcher-config.json）、
 * 设置页（client.js 通过 /categories 读不到，走 settings 里的只读说明）
 * 都要用到同一份清单。分散写会漂。
 *
 * 顺序有意义：靠前的类别优先匹配（更具体、更可靠）。
 */
export const DEFAULT_CATEGORIES = [
  {
    key: '聊天记录',
    desc: '微信/QQ/Telegram 等聊天对话截图',
    apps: ['com.tencent.mm', 'com.tencent.mobileqq', 'org.telegram', 'com.tencent.tim'],
    keywords: ['对方正在输入', '撤回了一条消息', '语音通话', '视频通话', '群聊', '发送', '你在干嘛'],
    patterns: ['周步桢', '打扰了'],
  },
  {
    key: '支付账单',
    desc: '账单、付款、收款、余额、转账截图',
    apps: ['com.eg.android.AlipayGphone', 'com.tencent.mm'],
    keywords: ['支付成功', '付款成功', '收款', '余额', '零钱', '账单', '转账', '已支付', '退款', '花呗', '微信支付', '支付宝'],
  },
  {
    key: '购物',
    desc: '淘宝/京东/拼多多等商品页与订单截图',
    apps: ['com.taobao.taobao', 'com.jingdong.app.mall', 'com.xunmeng.pinduoduo'],
    keywords: ['立即购买', '加入购物车', '包邮', '优惠券', '销量', '宝贝', '已下单', '待收货', '店铺', '评价'],
  },
  {
    key: '游戏截图',
    desc: '手游画面、抽卡结果、战绩统计',
    // 国服包名和国际服不是一回事：崩坏星穹铁道国服是 com.miHoYo.hkrpg，
    // 国际服才是 com.HoYoverse.hkrpgoversea。两个都要列。
    apps: [
      'com.miHoYo.Yuanshen',
      'com.miHoYo.hkrpg',
      'com.miHoYo.wuwa',
      'com.miHoYo.bh3',
      'com.mihoyo.hyperion',
      'com.HoYoverse.hkrpgoversea',
      'com.HoYoverse.Yuanshen',
      'com.tencent.tmgp',
      'com.netease.onmyoji',
      'com.hypergryph.arknights',
      'com.bilibili.azurlane',
      'com.Sunborn.SnqxExilium',
      'com.papegames.nn4',
      'com.bluepoch.mverse',
    ],
    keywords: ['抽卡', '十连', '保底', '命座', '圣遗物', '角色池', '武器池', '跃迁', '战意值', '积分', '击杀', '助攻', '胜利', '失败', '战绩', '段位', '原石', '星琼', 'uid:', 'uid：', '关卡', '副本', '挑战', '编队', '推荐等级', '首领'],
  },
  {
    key: '问答社区',
    desc: '知乎、贴吧、豆瓣等问答/讨论页截图',
    apps: ['com.zhihu.android', 'com.baidu.tieba'],
    keywords: ['知乎', '个回答', '邀请回答', '关注问题', '写回答', '赞同', '评论', '贴吧', '楼主', '豆瓣'],
  },
  {
    key: '社交媒体',
    desc: '微博、小红书、B站、抖音等社区流',
    apps: ['com.sina.weibo', 'com.xingin.xhs', 'tv.danmaku.bili', 'com.ss.android.ugc.aweme'],
    keywords: ['微博', '转发', '点赞', '评论', '小红书号', '关注', '粉丝', 'bilibili', '弹幕', '投币'],
  },
  {
    key: '视频播放',
    desc: '视频播放界面（含字幕）与影视截图',
    apps: [],
    keywords: ['倍速', '全屏', '选集', '投屏', '弹幕', '立即播放', 'HD', '标清', '超清', 'CCTV', '直播'],
  },
  {
    key: '学习资料',
    desc: '题目、课件、笔记、外语学习等',
    apps: ['com.fenbi.android.solar', 'com.youdao.dict', 'com.eusoft.eudic'],
    keywords: ['题目', '答案解析', '求极限', '语法解释', '单词', '例句', '考试', '成绩', '学号', '班级', '作业', '笔记'],
  },
  {
    key: '文档票据',
    desc: '纸质文件、合同、票据、表格的照片',
    apps: ['com.tencent.docs'],
    keywords: ['合同', '协议', '证明', '发票', '收据', '表格', '议题', '征求意见', '公司', '签名', '盖章', '身份证'],
  },
  {
    key: '交友社交',
    desc: '陌生人社交/相亲类 App 截图',
    apps: ['com.jike.app', 'com.tantan'],
    keywords: ['匹配', '心动', '喜欢', '聊得来'],
  },
  {
    key: '地图出行',
    desc: '地图导航、行程、打车截图',
    apps: ['com.autonavi.minimap', 'com.baidu.BaiduMap', 'com.sdu.didi.psnger'],
    keywords: ['导航', '公里', '路线', '步行', '驾车', '红绿灯', '到达', '预计', '打车', '司机'],
  },
  {
    key: '代码开发',
    desc: '代码、终端、报错截图',
    apps: ['com.termux'],
    keywords: ['function', 'return', 'const', 'import', 'class', 'def ', 'console', 'ERROR', 'Traceback', 'git ', 'npm '],
  },
  {
    key: '时政新闻',
    desc: '新闻报道、时事、政务/国际/财经类资讯截图',
    apps: [],
    keywords: [
      '新闻', '记者', '报道', '新华社', '人民日报', '央视', '国务院', '外交部', '国防部',
      '声明', '通报', '发布会', '选举', '总统', '首相', '法案', '制裁', '停火', '谈判',
      '政策', '失业率', '通胀', '股价', '美联储', '经济', '疫情', '官方回应',
    ],
    patterns: ['\\d+月\\d+日[\\s\\S]{0,12}(电|讯)', '据[^，。]{1,6}报道', '(新闻|资讯)(客户端|频道)?[：:]'],
  },
  {
    key: '二次元',
    desc: '动漫插画、立绘、角色图、番剧截图',
    apps: [],
    keywords: [
      '动漫', '漫画', '番剧', '新番', '轻小说', '动画', '立绘', '同人', '声优', '原画',
      '连载', '完结', '剧场版', '本子', '纸片人', '更新至', '第三话', '画集',
    ],
    patterns: ['第\\d+[话話集]', '第\\d+卷', 'CV[：:]', 'TVA|OVA'],
  },
  {
    key: '梗图表情包',
    desc: '带大字的搞笑图、表情包、网络梗',
    apps: [],
    keywords: [
      '哈哈哈', '笑死', '绝了', '就这', '麻了', '破防', '离谱', '无语', '绷不住',
      '急死', '赢麻', 'yyds', 'xswl', 'awsl', '蚌埠住', '含金量', '精神状态',
      '差不多得了', '我不理解', '典中典',
    ],
    patterns: ['[？?]{3,}', '\\b666\\b', '(doge|狗头|笑cry)'],
  },
  {
    key: '生活日常',
    desc: '日常生活记录、吃喝、宠物、天气、随手拍配文',
    apps: [],
    keywords: [
      '今天', '明天', '早上', '中午', '晚上', '晚饭', '早餐', '午饭', '夜宵', '好吃',
      '外卖', '咖啡', '奶茶', '猫咪', '狗狗', '天气', '生日快乐', '加油', '打卡',
      '出门', '回家', '宿舍', '上班', '下班', '晚安', '早安', '逛街', '晒太阳',
    ],
    // 这里**不能**写 `\d{1,2}[：:]\d{2}` 这种裸时间正则。
    // 实测教训：4977 张里它单独命中了 922 张 —— 因为手机截图状态栏右上角
    // 永远有「16:12」，OCR 一定会把它读出来。一条看似无害的时间正则，
    // 会把整批截图整片吸进"生活日常"。
    // 要时间线索，必须带上"人怎么用它"的上下文（几点 + 做了什么）。
    patterns: [
      '(今天|明天|昨天)[^，。]{0,8}(吃|去|见|买)',
      '(晚上|中午|早上|下午)\\s*\\d{1,2}[：:]\\d{2}[^，。]{0,10}(吃|出门|到|见|睡)',
    ],
  },
  {
    key: '文字梗',
    desc: '以文字为主体的截图：段子、神回复、长文分享、网友评论区截图',
    apps: [],
    // 这一类是「诚实兜底」：主体就是一段文字，但从文字里推不出更具体的场景。
    // 它们既不是梗图（没有夸张的图画），也不是生活日常（不是自己拍的生活记录），
    // 硬塞进哪个类目都是撒谎，所以单独给一个类目。
    keywords: [
      '段子', '神回复', '热评', '评论区', '网友', '搞笑', '笑死', '今日份',
      '脱口秀', '名场面', '语录', '文案', '投稿', '转发', '知乎体', '发疯文学',
    ],
    patterns: ['(网友|评论区|热评)[^，。]{0,10}(说|评论|回复)', '\\d+(\\.\\d+)?万(赞|浏览|展现|人)'],
  },
  {
    key: '摄影',
    desc: '相机拍摄的真实照片（风景/美食/宠物/人像/实物）',
    apps: [],
    keywords: [],
  },
];

/** 类目名清单（顺序即优先级），给弹窗下拉与设置页用 */
export const CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c.key);

/** 扫码类 App 包名 → 应用名，用于从截图文件名里反推来源 */
export const APP_NAMES = {
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.tencent.tim': 'TIM',
  'org.telegram': 'Telegram',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.taobao.taobao': '淘宝',
  'com.jingdong.app.mall': '京东',
  'com.xunmeng.pinduoduo': '拼多多',
  'com.zhihu.android': '知乎',
  'com.sina.weibo': '微博',
  'com.xingin.xhs': '小红书',
  'tv.danmaku.bili': 'B站',
  'com.ss.android.ugc.aweme': '抖音',
  'com.fenbi.android.solar': '粉笔',
  'com.baidu.tieba': '贴吧',
  'com.autonavi.minimap': '高德',
  'com.baidu.BaiduMap': '百度地图',
  'com.sdu.didi.psnger': '滴滴',
  'com.jike.app': '即刻',
  'com.miHoYo.Yuanshen': '原神',
  'com.miHoYo.hkrpg': '星穹铁道',
  'com.miHoYo.wuwa': '鸣潮',
  'com.miHoYo.bh3': '崩坏3',
  'com.mihoyo.hyperion': '米游社',
  'com.HoYoverse.hkrpgoversea': '星穹铁道',
  'com.HoYoverse.Yuanshen': '原神',
  'com.xiaomi.router': '小米路由器',
  'com.netease.onmyoji': '阴阳师',
  'com.hypergryph.arknights': '明日方舟',
  'com.bilibili.azurlane': '碧蓝航线',
  'com.Sunborn.SnqxExilium': '尘白禁区',
  'com.papegames.nn4': '恋与深空',
  'com.bluepoch.mverse': '重返未来',
};
