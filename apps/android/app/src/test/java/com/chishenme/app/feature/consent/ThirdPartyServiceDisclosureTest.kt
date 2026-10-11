package com.chishenme.app.feature.consent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThirdPartyServiceDisclosureTest {
    @Test
    fun `discloses server-side SMS and SMTP processing without claiming an Android SDK`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("阿里云计算有限公司"))
        assertTrue(disclosure.contains("号码认证服务短信认证（PNVS）"))
        assertTrue(disclosure.contains("标准 SMTP 服务"))
        assertTrue(disclosure.contains("阿里邮箱企业版"))
        assertTrue(disclosure.contains("同意隐私文件并主动点击获取验证码"))
        assertTrue(disclosure.contains("验证码由阿里云动态生成"))
        assertTrue(disclosure.contains("仅为本次校验短暂处理你输入的验证码"))
        assertTrue(disclosure.contains("不会把明文验证码写入响应、日志或数据库"))
        assertTrue(disclosure.contains("转交阿里云校验"))
        assertFalse(disclosure.contains("自有 API 与 Android 均不获取明文手机号验证码"))
        assertTrue(disclosure.contains("邮箱地址和本次 6 位验证码"))
        assertTrue(disclosure.contains("自有后端"))
        assertTrue(disclosure.contains("阿里云隐私政策"))
        assertTrue(disclosure.contains("已有账号登录或新号直接创建账号"))
    }

    @Test
    fun `removed carrier auth and risk SDK disclosures do not remain`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        listOf(
            "融合认证",
            "一键" + "登录",
            "图形认证",
            "READ_PHONE_STATE",
            "友盟登录安全 SDK",
        ).forEach { removed -> assertFalse(disclosure.contains(removed)) }
    }

    @Test
    fun `discloses server-side AMap live processing without claiming an Android SDK`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("高德软件有限公司"))
        assertTrue(disclosure.contains("高德开放平台 Web 服务 API"))
        assertTrue(disclosure.contains("Android 未集成高德地图 SDK"))
        assertTrue(disclosure.contains("Web Service Key 和数字签名私钥也不会进入安装包"))
        assertTrue(disclosure.contains("主动发起地点搜索或推荐"))
        assertTrue(disclosure.contains("WGS84"))
        assertTrue(disclosure.contains("GCJ-02"))
        assertTrue(disclosure.contains("固定地点也可能作为查询中心"))
        assertTrue(disclosure.contains("不跨请求缓存或持久化高德 POI"))
        assertTrue(disclosure.contains("已获授权的启动收集"))
        assertTrue(disclosure.contains("3.5 km 内最多两页餐厅"))
        assertTrue(disclosure.contains("本机私有目录按启动时间戳独立保存 90 天"))
        assertTrue(disclosure.contains("撤回隐私同意后删除"))
        assertTrue(disclosure.contains("本次用户位置、坐标系和定位精度（米）也保存到同一文件"))
        assertTrue(disclosure.contains("系统未提供有效精度时保存为空"))
        assertTrue(disclosure.contains("不把高德 POI 内容发送给模型"))
        assertTrue(disclosure.contains("AMAP 关闭时不会向高德传输"))
    }

    @Test
    fun `discloses WeChat subject scope proof flow backend verification and official policy`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("微信开放平台登录由深圳市腾讯计算机系统有限公司提供"))
        assertTrue(disclosure.contains("Android OpenSDK 6.8.40"))
        assertTrue(disclosure.contains("主动点击微信登录或登录后绑定微信时才初始化 SDK"))
        assertTrue(disclosure.contains("snsapi_userinfo"))
        assertTrue(disclosure.contains("state 和一次性临时 authorization code"))
        assertTrue(disclosure.contains("原 state 和 authorization code 一并交给自有后端"))
        assertTrue(disclosure.contains("不提交原始 SDK 回调对象或客户端声称的 OpenID"))
        assertTrue(disclosure.contains("一次性消费 state 并核对用途与设备"))
        assertTrue(disclosure.contains("AppID/AppSecret"))
        assertTrue(disclosure.contains("校验 snsapi_userinfo 与 OpenID"))
        assertTrue(disclosure.contains("仅按 AppID + OpenID 识别本移动应用内的微信身份"))
        assertTrue(disclosure.contains("不因缺少 UnionID 拒绝有效身份"))
        assertTrue(disclosure.contains("不利用 UnionID 静默合并账号"))
        assertTrue(disclosure.contains("access token 和 refresh token 不返回 Android"))
        assertTrue(
            disclosure.contains(
                "https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/" +
                    "Android.html#%E5%90%88%E8%A7%84%E6%8C%87%E5%8D%97",
            ),
        )
    }

    @Test
    fun `discloses QQ subject scope proof flow backend verification and official policy`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("QQ 互联登录由深圳市腾讯计算机系统有限公司提供"))
        assertTrue(disclosure.contains("3.5.19 Lite 包"))
        assertTrue(disclosure.contains("主动点击 QQ 登录或绑定后才初始化 SDK"))
        assertTrue(disclosure.contains("get_simple_userinfo"))
        assertTrue(disclosure.contains("设备型号以及 QQ/TIM 是否安装"))
        assertTrue(disclosure.contains("Android 使用 loginServerSide 模式"))
        assertTrue(disclosure.contains("历史名为 access_token 的兼容字段"))
        assertTrue(disclosure.contains("本次一次性 authorization code"))
        assertTrue(disclosure.contains("不承载可直接访问 QQ API 的 access token"))
        assertTrue(disclosure.contains("不采信客户端返回的 OpenID"))
        assertTrue(disclosure.contains("只把本次 state 与 authorization code 交给自有后端"))
        assertTrue(disclosure.contains("使用同一 AppID 与仅保存在服务端的 AppKey"))
        assertTrue(disclosure.contains("先把 authorization code 换成提供方 access token"))
        assertTrue(disclosure.contains("client_id 与本 App 的 AppID 完全一致"))
        assertTrue(disclosure.contains("要求合法 UnionID 并用于稳定身份去重"))
        assertTrue(disclosure.contains("QQ 身份只能登录已绑定账号，不会静默合并"))
        assertTrue(disclosure.contains("authorization code 只在 Android 与后端内存中短暂处理"))
        assertTrue(disclosure.contains("提供方 access token 和 refresh token 不返回 Android"))
        assertTrue(disclosure.contains("三类临时凭证均不写入本机、日志、数据库或界面"))
        assertFalse(disclosure.contains("Android 只读取本次临时 access token"))
        assertTrue(
            disclosure.contains(
                "https://wiki.connect.qq.com/qq%E4%BA%92%E8%81%94sdk%E9%9A%90%E7%A7%81" +
                    "%E4%BF%9D%E6%8A%A4%E5%A3%B0%E6%98%8E",
            ),
        )
    }
}
