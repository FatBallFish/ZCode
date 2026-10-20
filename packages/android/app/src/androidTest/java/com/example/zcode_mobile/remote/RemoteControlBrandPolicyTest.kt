package com.example.zcode_mobile.remote

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteControlBrandPolicyTest {
    @Test
    fun selfHostedTicketsAndMikikoDeepLinksKeepTheSameAddress() {
        val query = "sid=sample&hash=proof&ws=wss%3A%2F%2Fws.mikiko.ai"
        val canonical = RemoteControlUrlPolicy.resolve("mikiko://remote?$query")!!
        assertEquals("remote.mikiko.ai", Uri.parse(canonical).host)
        assertEquals("sample", Uri.parse(canonical).getQueryParameter("sid"))
        assertEquals("wss://ws.mikiko.ai", Uri.parse(canonical).getQueryParameter("ws"))
        assertEquals(canonical, RemoteControlUrlPolicy.resolve("zcode://remote?$query"))
        assertTrue(RemoteControlUrlPolicy.isAllowedRemoteUrl("https://remote.mikiko.ai/?$query"))
        assertTrue(RemoteControlUrlPolicy.isAllowedRemoteUrl("https://remote.mikiko.ai/remote/devices"))
        assertFalse(RemoteControlUrlPolicy.isAllowedRemoteUrl("https://zcode.z.ai/remote?sid=sample"))
        assertFalse(RemoteControlUrlPolicy.isAllowedRemoteUrl("https://remote.mikiko.ai/remote-pretend"))
        assertFalse(RemoteControlUrlPolicy.isAllowedRemoteUrl("https://user@remote.mikiko.ai/remote"))
        assertNull(RemoteControlUrlPolicy.resolve("mailto:test@example.com"))
        assertNull(RemoteControlUrlPolicy.resolve("http:remote.mikiko.ai"))
        assertNull(RemoteControlUrlPolicy.resolve("file:///"))
    }

    @Test
    fun recentLinksMigrateOnceAndDoNotReviveAfterClear() {
        withIsolatedPreferences { context ->
            val oldUrl = "https://remote.mikiko.ai/remote?sid=old&hash=proof&ws=wss%3A%2F%2Fws.mikiko.ai"
            context.getSharedPreferences("zcode_remote_control_recent_links", Context.MODE_PRIVATE)
                .edit().putString("links_v1", links(oldUrl)).commit()
            assertEquals(listOf(oldUrl), RemoteControlRecentLinksStore.read(context).map { it.url })
            assertTrue(RemoteControlRecentLinksStore.clear(context).isEmpty())
            assertTrue(RemoteControlRecentLinksStore.read(context).isEmpty())
            assertTrue(context.getSharedPreferences("mikiko_remote_control_recent_links", Context.MODE_PRIVATE)
                .getBoolean("legacy_migrated_v1", false))
        }
    }

    @Test
    fun newerMikikoPreferenceWinsOverLegacyData() {
        withIsolatedPreferences { context ->
            val current = "https://remote.mikiko.ai/remote?sid=current&hash=proof&ws=wss%3A%2F%2Fws.mikiko.ai"
            context.getSharedPreferences("zcode_remote_control_recent_links", Context.MODE_PRIVATE)
                .edit().putString("links_v1", links("https://remote.mikiko.ai/remote?sid=old")).commit()
            context.getSharedPreferences("mikiko_remote_control_recent_links", Context.MODE_PRIVATE)
                .edit().putString("links_v1", links(current)).commit()
            assertEquals(listOf(current), RemoteControlRecentLinksStore.read(context).map { it.url })
        }
    }

    private fun links(url: String): String = JSONArray().put(
        JSONObject().put("url", url).put("openedAt", 1L),
    ).toString()

    private fun withIsolatedPreferences(body: (Context) -> Unit) {
        val base = InstrumentationRegistry.getInstrumentation().context
        val prefix = "mikiko-brand-test-${System.nanoTime()}-"
        val names = mutableSetOf<String>()
        val context = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
                val isolated = prefix + name
                names.add(isolated)
                return base.getSharedPreferences(isolated, mode)
            }
        }
        try { body(context) } finally { names.forEach { base.deleteSharedPreferences(it) } }
    }
}
