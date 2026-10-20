package com.example.zcode_mobile.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.example.zcode_mobile.MainActivity
import com.example.zcode_mobile.R

class RemoteControlKeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val remoteUrl = readRemoteUrl(intent).orEmpty()
        val channelId = ensureNotificationChannel()

        // Bugfix: 纯浏览器后台后 WebView/JS/WebSocket 容易被系统暂停或回收。
        // 前台服务不能保证 WebView socket 永不断，但能给远控会话一个用户可见的保活边界，
        // 降低进程被杀概率；真正的状态恢复仍交给 web 端 replayable snapshot 协议完成。
        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_remote_control)
            .setContentTitle(getString(R.string.remote_keep_alive_title))
            .setContentText(getString(R.string.remote_keep_alive_text))
            .setContentIntent(createContentIntent(remoteUrl))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun ensureNotificationChannel(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return CHANNEL_ID
        }
        val manager = getSystemService(NotificationManager::class.java)
        // 旧 channel 的 importance 包含用户授权选择，升级只更新可见名称/说明，不重置该选择。
        val existing = manager.getNotificationChannel(CHANNEL_ID)
            ?: manager.getNotificationChannel(LEGACY_CHANNEL_ID)
        val channel = existing ?: NotificationChannel(
            CHANNEL_ID,
            getString(R.string.remote_keep_alive_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        channel.name = getString(R.string.remote_keep_alive_channel)
        channel.description = getString(R.string.remote_keep_alive_channel_description)
        manager.createNotificationChannel(channel)
        return channel.id
    }

    private fun createContentIntent(remoteUrl: String): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_REMOTE_URL, remoteUrl)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        private const val CHANNEL_ID = "mikiko_remote_control"
        private const val LEGACY_CHANNEL_ID = "zcode_remote_control"
        private const val NOTIFICATION_ID = 1001
        const val EXTRA_REMOTE_URL = "ai.mikiko.remote.REMOTE_URL"
        private const val LEGACY_EXTRA_REMOTE_URL = "com.example.zcode_mobile.remote.REMOTE_URL"

        fun readRemoteUrl(intent: Intent?): String? =
            intent?.getStringExtra(EXTRA_REMOTE_URL) ?: intent?.getStringExtra(LEGACY_EXTRA_REMOTE_URL)

        fun start(context: Context, remoteUrl: String) {
            val intent = Intent(context, RemoteControlKeepAliveService::class.java)
                .putExtra(EXTRA_REMOTE_URL, remoteUrl)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RemoteControlKeepAliveService::class.java))
        }
    }
}
