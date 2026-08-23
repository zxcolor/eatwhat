package com.chishenme.app.feature.consent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThirdPartyServiceDisclosureTest {
    @Test
    fun `discloses server-side SMS and SMTP processing without claiming an Android SDK`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("阿里云计算有限公司"))
        assertTrue(disclosure.contains("短信服务（SMS）"))
        assertTrue(disclosure.contains("标准 SMTP 服务"))
        assertTrue(disclosure.contains("邮箱验证码能力默认关闭"))
        assertTrue(disclosure.contains("同意隐私文件并主动点击获取验证码"))
        assertTrue(disclosure.contains("手机号或邮箱地址及本次 6 位验证码"))
        assertTrue(disclosure.contains("自有后端"))
        assertTrue(disclosure.contains("阿里云隐私政策"))
        assertTrue(disclosure.contains("必须补充实际 SMTP 服务商主体和隐私政策"))
        assertFalse(disclosure.contains("阿里云 Android SDK"))
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
        assertTrue(disclosure.contains("不把高德 POI 内容发送给模型"))
        assertTrue(disclosure.contains("AMAP 关闭时不会向高德传输"))
    }

    @Test
    fun `discloses WeChat subject scope proof flow backend verification and official policy`() {
        val disclosure = THIRD_PARTY_SERVICE_DISCLOSURE

        assertTrue(disclosure.contains("微信开放平台登录由深圳市腾讯计算机系统有限公司提供"))
        assertTrue(disclosure.contains("Android OpenSDK 6.8.40"))
        assertTrue(disclosure.contains("主动点击微信登录或微信注册后才初始化 SDK"))
        assertTrue(disclosure.contains("snsapi_userinfo"))
        assertTrue(disclosure.contains("state 和一次性临时 authorization code"))
        assertTrue(disclosure.contains("只把 authorization code 交给自有后端"))
        assertTrue(disclosure.contains("AppID/AppSecret"))
        assertTrue(disclosure.contains("OpenID 及可选 UnionID"))
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
        assertTrue(disclosure.contains("Android 只读取本次临时 access token"))
        assertTrue(disclosure.contains("不采信客户端返回的 OpenID"))
        assertTrue(disclosure.contains("client_id 与本 App 的 AppID 完全一致"))
        assertTrue(disclosure.contains("临时凭证不写入本机、日志或界面"))
        assertTrue(
            disclosure.contains(
                "https://wiki.connect.qq.com/qq%E4%BA%92%E8%81%94sdk%E9%9A%90%E7%A7%81" +
                    "%E4%BF%9D%E6%8A%A4%E5%A3%B0%E6%98%8E",
            ),
        )
    }
}
