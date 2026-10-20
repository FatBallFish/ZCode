package com.example.zcode_mobile.remote

import android.net.Uri
import com.example.zcode_mobile.BuildConfig

private const val MIKIKO_REMOTE_SCHEME = "mikiko"
// 旧二维码 scheme 仅兼容读取，目标仍统一为自建入口。
private const val LEGACY_REMOTE_SCHEME = "zcode"
private const val REMOTE_LINK_HOST = "remote"
private const val MIKIKO_REMOTE_WEB_HOST = "remote.mikiko.ai"

object RemoteControlUrlPolicy {
    fun resolve(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return null
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        return resolve(uri)
    }

    fun resolve(uri: Uri?): String? {
        if (uri == null) {
            return null
        }

        if ((uri.scheme?.lowercase() == MIKIKO_REMOTE_SCHEME || uri.scheme?.lowercase() == LEGACY_REMOTE_SCHEME) && uri.host?.lowercase() == REMOTE_LINK_HOST) {
            return buildDefaultRemoteUrl(uri)
        }

        if (isAllowedRemoteUrl(uri)) {
            return uri.toString()
        }

        return null
    }

    fun isAllowedRemoteUrl(raw: String?): Boolean {
        val uri = runCatching { Uri.parse(raw?.trim().orEmpty()) }.getOrNull() ?: return false
        return isAllowedRemoteUrl(uri)
    }

    private fun buildDefaultRemoteUrl(uri: Uri): String {
        val base = Uri.parse(BuildConfig.REMOTE_CONTROL_DEFAULT_URL).buildUpon()
        uri.encodedQuery?.let { base.encodedQuery(it) }
        uri.encodedFragment?.let { base.encodedFragment(it) }
        return base.build().toString()
    }

    private fun isAllowedRemoteUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        // 根路径票据需读取 query；opaque 或非网页 URI 应先拒绝，避免 Android Uri 抛异常。
        if (!uri.isHierarchical || (scheme != "http" && scheme != "https")) {
            return false
        }
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()

        // 自建票据部署于独立域根路径；保留 sid/hash/ws，不能只接受上游 /remote 路径。
        val remotePath = path == "/remote" || path.startsWith("/remote/")
        val rootTicket = (path.isEmpty() || path == "/") &&
            !uri.getQueryParameter("sid").isNullOrBlank() &&
            !uri.getQueryParameter("hash").isNullOrBlank() &&
            !uri.getQueryParameter("ws").isNullOrBlank()
        if (!uri.userInfo.isNullOrEmpty()) {
            return false
        }
        if (scheme == "https" && host == MIKIKO_REMOTE_WEB_HOST && (remotePath || rootTicket)) {
            return true
        }

        if (!BuildConfig.DEBUG) {
            return false
        }

        // Bugfix: 开发机真机调试时二维码会指向局域网 Vite 地址。
        // 生产包只允许自建 remote.mikiko.ai，debug 包才放开测试域、本机和局域网 http/https，避免远控壳变成任意浏览器。
        if (!remotePath && !rootTicket) {
            return false
        }
        if (host == MIKIKO_REMOTE_WEB_HOST) {
            return scheme == "https"
        }
        return (scheme == "http" || scheme == "https") && isDebugHost(host)
    }

    private fun isDebugHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") {
            return true
        }
        if (host.endsWith(".local")) {
            return true
        }
        if (host.startsWith("192.168.") || host.startsWith("10.")) {
            return true
        }
        return Regex("^172\\.(1[6-9]|2\\d|3[0-1])\\.").containsMatchIn(host)
    }
}
