package com.stremiosync

import android.os.Bundle
import android.widget.Toast
import androidx.fragment.app.FragmentActivity
import com.google.gson.JsonObject
import java.io.File

class MpvActivity : FragmentActivity() {

    private lateinit var syncManager: SyncManager
    private lateinit var mpvIpc: MpvIpcManager

    private var isSyncing = false
    private var lastTimestamp = 0.0
    private var roomCode = ""
    private var isHost = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val url = intent.getStringExtra("url") ?: return finish()
        roomCode = intent.getStringExtra("roomCode") ?: ""
        isHost = intent.getBooleanExtra("isHost", false)

        syncManager = SyncManager(SyncManager.SERVER_URL)
        mpvIpc = MpvIpcManager(getMpvSocketPath())

        launchMpv(url)
        setupMpvListeners()
        setupSyncListeners()
        syncManager.connect()
    }

    private fun getMpvSocketPath(): String {
        val dir = filesDir
        return "${dir.absolutePath}/mpv-socket"
    }

    private fun launchMpv(url: String) {
        // MPV for Android exposes an IPC socket when launched with --input-ipc-server
        // We launch it as an external activity and connect to its socket
        val socketPath = getMpvSocketPath()
        File(socketPath).delete() // clean old socket

        // Launch MPV via intent (MPV for Android must be installed)
        val mpvIntent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
            setDataAndType(android.net.Uri.parse(url), "video/*")
            setPackage("is.xyz.mpv") // MPV for Android package name
            putExtra("is.xyz.mpv.MPVActivity.socket", socketPath)
        }

        try {
            startActivity(mpvIntent)
        } catch (e: Exception) {
            Toast.makeText(this, "MPV for Android not installed. Install from GitHub.", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        // Connect to MPV IPC after a short delay
        android.os.Handler(mainLooper).postDelayed({
            mpvIpc.connect()
        }, 1500)
    }

    private fun setupMpvListeners() {
        mpvIpc.setEventListener { event, data ->
            if (isSyncing) return@setEventListener

            when (event) {
                "property-change" -> {
                    val name = data.get("name")?.asString ?: return@setEventListener
                    when (name) {
                        "time-pos" -> {
                            lastTimestamp = data.get("data")?.asDouble ?: lastTimestamp
                        }
                        "pause" -> {
                            val paused = data.get("data")?.asBoolean ?: return@setEventListener
                            if (paused) syncManager.pause(lastTimestamp)
                            else syncManager.play(lastTimestamp)
                        }
                        "paused-for-cache" -> {
                            val buffering = data.get("data")?.asBoolean ?: return@setEventListener
                            if (buffering) syncManager.bufferingStart(lastTimestamp)
                            else syncManager.bufferingEnd(lastTimestamp)
                        }
                    }
                }
            }
        }
    }

    private fun setupSyncListeners() {
        syncManager.setListener { event, data ->
            isSyncing = true
            when (event) {
                "play" -> {
                    val ts = data.get("timestamp")?.asDouble ?: 0.0
                    mpvIpc.seekTo(ts)
                    mpvIpc.play()
                }
                "pause" -> {
                    val ts = data.get("timestamp")?.asDouble ?: 0.0
                    mpvIpc.seekTo(ts)
                    mpvIpc.pause()
                }
                "seek" -> {
                    val ts = data.get("timestamp")?.asDouble ?: 0.0
                    mpvIpc.seekTo(ts)
                }
                "buffering-start" -> {
                    mpvIpc.pause()
                    runOnUiThread {
                        Toast.makeText(this, "Partner buffering...", Toast.LENGTH_SHORT).show()
                    }
                }
                "buffering-end-all" -> {
                    val ts = data.get("timestamp")?.asDouble ?: lastTimestamp
                    mpvIpc.seekTo(ts)
                    mpvIpc.play()
                }
                "peer-disconnected" -> {
                    runOnUiThread {
                        Toast.makeText(this, "Partner disconnected", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            android.os.Handler(mainLooper).postDelayed({ isSyncing = false }, 200)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        mpvIpc.disconnect()
        syncManager.disconnect()
    }
}
