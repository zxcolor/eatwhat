package com.chishenme.app.feature.consent

/**
 * One source of truth for the first-run and Settings disclosures. SMS and
 * SMTP delivery are server-side integrations, not Android SDKs.
 */
internal const val THIRD_PARTY_SERVICE_DISCLOSURE =
    "当前版本使用阿里云计算有限公司提供的短信服务（SMS）投递手机号验证码；邮箱验证码能力默认关闭，启用后由自有后端通过项目运营者配置的标准 SMTP 服务投递，不在 Android 中集成邮件服务商 SDK。只有在你同意隐私文件并主动点击获取验证码后，自有后端才会把手机号或邮箱地址及本次 6 位验证码提交给相应投递服务，用于完成手机号注册/登录或邮箱登录/绑定；不会为该投递提交位置、餐厅偏好、微信或 QQ 账号。阿里云隐私政策可在阿里云官网“阿里云隐私政策（最新）”查看；正式启用邮箱通道前，本清单必须补充实际 SMTP 服务商主体和隐私政策。" +
        "当前版本预留由自有后端调用高德软件有限公司高德开放平台 Web 服务 API 的能力，Android 未集成高德地图 SDK，Web Service Key 和数字签名私钥也不会进入安装包。只有在你同意隐私文件、服务端明确启用 AMAP 且你主动发起地点搜索或推荐后，自有后端才会按单次请求向高德提交查询中心坐标（Android 系统位置为 WGS84，后端在调用边界转换为 GCJ-02；拒绝系统定位后主动选择的固定地点也可能作为查询中心）、搜索词或餐饮类型、半径，以及地点检索所需的地域、分页和返回字段参数，用于实时返回附近地点或餐厅。当前 LIVE_DISPLAY_ONLY 模式不跨请求缓存或持久化高德 POI，不把高德 POI 内容发送给模型，也不在缺少书面数据权利时开放导航、拨号、复制地址等外部动作；AMAP 关闭时不会向高德传输。高德隐私政策和高德开放平台服务协议可在高德开放平台官网查看。" +
        "微信开放平台登录由深圳市腾讯计算机系统有限公司提供，当前使用 Android OpenSDK 6.8.40。只有在你同意本清单并主动点击微信登录或微信注册后才初始化 SDK，并请求 snsapi_userinfo 授权范围。微信向 Android 回传服务端签发的 state 和一次性临时 authorization code；本 App 先在内存中核对 state，再只把 authorization code 交给自有后端。后端使用仅保存在服务端的 AppID/AppSecret，通过微信官方 HTTPS 接口换取结果并校验 snsapi_userinfo、OpenID 及可选 UnionID；微信 access token 和 refresh token 不返回 Android，也不写入本机、日志或界面。微信官方《OpenSDK Android 开发者合规使用指南》：https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html#%E5%90%88%E8%A7%84%E6%8C%87%E5%8D%97。" +
        "QQ 互联登录由深圳市腾讯计算机系统有限公司提供，当前使用 Android OpenSDK 官方 3.5.19 Lite 包。只有在你同意本清单并主动点击 QQ 登录或绑定后才初始化 SDK，并请求 get_simple_userinfo 授权范围；SDK 可能处理设备型号以及 QQ/TIM 是否安装。Android 只读取本次临时 access token，不采信客户端返回的 OpenID，并只把该 token 交给自有后端。后端通过 QQ 官方 HTTPS me 接口校验响应中的 client_id 与本 App 的 AppID 完全一致后取得 OpenID；临时凭证不写入本机、日志或界面。QQ 官方《QQ互联SDK隐私保护声明》：https://wiki.connect.qq.com/qq%E4%BA%92%E8%81%94sdk%E9%9A%90%E7%A7%81%E4%BF%9D%E6%8A%A4%E5%A3%B0%E6%98%8E。" +
        "自动定位仍使用 Android 系统框架；未来新增第三方服务前，会继续逐项说明主体、用途、数据类型、隐私政策与初始化时机。"
