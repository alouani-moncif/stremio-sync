package com.stremiosync

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.FragmentActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import android.util.Log
import android.graphics.Color
import android.view.Gravity

class MpvActivity : FragmentActivity() {

    private lateinit var syncManager: SyncManager
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var statusOverlay: TextView

    // When true, player events are ignored — sync commands are in control
    private var isSyncing = false

    // Tracks last known timestamp for sending to server
    private var lastTimestamp = 0.0

    private val handler = Handler(Looper.getMainLooper())

    // Safety valve — if we sent ready but never got play back, unfreeze after 8s
    private val readyTimeoutRunnable = Runnable {
        Log.w("MpvActivity", "Ready timeout — partner may be offline, unfreezing")
        isSyncing = false
        showStatus("")
    }

    private val timestampPoller = object : Runnable {
        override fun run() {
            if (player.isPlaying) {
                lastTimestamp = player.currentPosition / 1000.0
            }
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Log.d("MpvActivity", "MpvActivity started")

        val url = intent.getStringExtra("url") ?: return finish()

        Log.d("MpvActivity", "URL: $url")

        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        // Root layout: player + status overlay on top
        val root = FrameLayout(this)
        setContentView(root)

        playerView = PlayerView(this)
        root.addView(playerView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // Status overlay for "Waiting for partner..." etc.
        statusOverlay = TextView(this).apply {
            textSize = 18f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(180, 0, 0, 0))
            setPadding(32, 16, 32, 16)
            visibility = View.GONE
        }
        val overlayParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER }
        root.addView(statusOverlay, overlayParams)

        // Build ExoPlayer with generous buffer settings
        player = ExoPlayer.Builder(this)
            .setLoadControl(
                androidx.media3.exoplayer.DefaultLoadControl.Builder()
                    .setBufferDurationsMs(15_000, 60_000, 2_500, 5_000)
                    .build()
            )
            .build()
        playerView.player = player
        playerView.useController = true

        // Load video but DO NOT autoplay — wait for server to say play
        val mediaItem = MediaItem.fromUri(url)
        player.setMediaItem(mediaItem)
        player.prepare()
        player.playWhenReady = false

        syncManager = SyncManager.getInstance()
        setupPlayerListeners()
        setupSyncListeners()

        handler.post(timestampPoller)

        showStatus("⏳ Connecting...")
    }

    private fun showStatus(msg: String) {
        if (msg.isEmpty()) {
            statusOverlay.visibility = View.GONE
        } else {
            statusOverlay.text = msg
            statusOverlay.visibility = View.VISIBLE
        }
    }

    private fun setupPlayerListeners() {
        player.addListener(object : Player.Listener {

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isSyncing) return

                lastTimestamp = player.currentPosition / 1000.0

                if (isPlaying) {
                    // User pressed play — freeze player and coordinate with server
                    player.pause()
                    isSyncing = true
                    showStatus("⏳ Waiting for partner...")
                    // Cancel any previous ready timeout
                    handler.removeCallbacks(readyTimeoutRunnable)
                    handler.postDelayed(readyTimeoutRunnable, 8000)
                    syncManager.ready(lastTimestamp)
                    Log.d("MpvActivity", "User play → sent ready at $lastTimestamp")
                } else {
                    // User pressed pause
                    syncManager.pause(lastTimestamp)
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (isSyncing) return
                when (playbackState) {
                    Player.STATE_BUFFERING -> {
                        showStatus("⏳ Buffering...")
                        syncManager.bufferingStart(lastTimestamp)
                    }
                    Player.STATE_READY -> {
                        // Only send bufferingEnd if we were actually buffering
                        // (not on initial load)
                        if (player.isPlaying) {
                            showStatus("")
                            syncManager.bufferingEnd(lastTimestamp)
                        }
                    }
                    else -> {}
                }
            }
        })
    }

    private fun setupSyncListeners() {
        syncManager.setListener { event, data ->
            runOnUiThread {
                Log.d("MpvActivity", "Sync event: $event")
                when (event) {
                    "play" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        handler.removeCallbacks(readyTimeoutRunnable)
                        isSyncing = true
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                        showStatus("")
                        // Release sync lock after seek+play settles
                        handler.postDelayed({
                            isSyncing = false
                        }, 1500)
                    }
                    "pause" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        isSyncing = true
                        player.seekTo((ts * 1000).toLong())
                        player.pause()
                        showStatus("")
                        handler.postDelayed({ isSyncing = false }, 1500)
                    }
                    "seek" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        isSyncing = true
                        player.seekTo((ts * 1000).toLong())
                        handler.postDelayed({ isSyncing = false }, 1500)
                    }
                    "buffering-start" -> {
                        isSyncing = true
                        player.pause()
                        showStatus("⏳ Partner is buffering...")
                    }
                    "buffering-end-all" -> {
                        val ts = data.get("timestamp")?.asDouble ?: lastTimestamp
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                        showStatus("")
                        handler.postDelayed({ isSyncing = false }, 1500)
                    }
                    "peer-ready" -> {
                        showStatus("⏳ Partner is ready, starting soon...")
                    }
                    "peer-connected" -> {
                        showStatus("✓ Partner connected")
                        handler.postDelayed({ showStatus("") }, 2000)
                    }
                    "peer-disconnected" -> {
                        // Unfreeze immediately — no point waiting
                        handler.removeCallbacks(readyTimeoutRunnable)
                        isSyncing = false
                        showStatus("⚠️ Partner disconnected")
                        handler.postDelayed({ showStatus("") }, 3000)
                    }
                    "connected" -> {
                        showStatus("✓ Connected to server")
                        handler.postDelayed({ showStatus("") }, 2000)
                    }
                    "disconnected" -> {
                        showStatus("⚠️ Reconnecting...")
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(timestampPoller)
        handler.removeCallbacks(readyTimeoutRunnable)
        player.release()
    }

    override fun onPause() {
        super.onPause()
        // do not touch player — sync controls playback
    }

    override fun onResume() {
        super.onResume()
        // do not touch player — sync controls playback
    }
}
