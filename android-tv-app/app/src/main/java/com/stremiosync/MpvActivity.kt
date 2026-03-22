package com.stremiosync

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Toast
import androidx.fragment.app.FragmentActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import android.util.Log

class MpvActivity : FragmentActivity() {

    private lateinit var syncManager: SyncManager
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView

    private var isSyncing = false
    private var lastTimestamp = 0.0
    private val handler = Handler(Looper.getMainLooper())

    // Safety timeout — if play never comes back, unfreeze after 5s
    private val syncTimeoutRunnable = Runnable {
        Log.w("MpvActivity", "Sync timeout — unfreezing")
        isSyncing = false
    }

    private val timestampPoller = object : Runnable {
        override fun run() {
            if (player.isPlaying) {
                lastTimestamp = player.currentPosition / 1000.0
            }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Log.d("TEST", "MpvActivity started")

        val url = intent.getStringExtra("url") ?: return finish()

        Log.d("TEST", "URL: $url")

        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        playerView = PlayerView(this)
        setContentView(playerView)

        player = ExoPlayer.Builder(this)
            .setLoadControl(
                androidx.media3.exoplayer.DefaultLoadControl.Builder()
                    .setBufferDurationsMs(15_000, 60_000, 2_500, 5_000)
                    .build()
            )
            .build()
        playerView.player = player
        playerView.useController = true

        val mediaItem = MediaItem.fromUri(url)
        player.setMediaItem(mediaItem)
        player.prepare()
        player.playWhenReady = true

        syncManager = SyncManager.getInstance()
        setupPlayerListeners()
        setupSyncListeners()

        handler.post(timestampPoller)
    }

    private fun setSyncing(value: Boolean, timeoutMs: Long = 0) {
        isSyncing = value
        handler.removeCallbacks(syncTimeoutRunnable)
        if (value && timeoutMs > 0) {
            handler.postDelayed(syncTimeoutRunnable, timeoutMs)
        }
    }

    private fun setupPlayerListeners() {
        player.addListener(object : Player.Listener {

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isSyncing) return
                lastTimestamp = player.currentPosition / 1000.0
                if (isPlaying) {
                    // Pause immediately, send ready, wait for server to coordinate play
                    player.pause()
                    setSyncing(true, 5000) // 5s safety timeout in case partner never responds
                    syncManager.bufferingEnd(lastTimestamp)
                    syncManager.ready(lastTimestamp)
                    Log.d("MpvActivity", "Sent ready at $lastTimestamp")
                } else {
                    syncManager.pause(lastTimestamp)
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (isSyncing) return
                if (playbackState == Player.STATE_BUFFERING) {
                    syncManager.bufferingStart(lastTimestamp)
                }
                // STATE_READY intentionally ignored
            }
        })
    }

    private fun setupSyncListeners() {
        syncManager.setListener { event, data ->
            runOnUiThread {
                when (event) {
                    "play" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        setSyncing(true, 2000)
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                        handler.postDelayed({ setSyncing(false) }, 1500)
                    }
                    "pause" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        setSyncing(true, 2000)
                        player.seekTo((ts * 1000).toLong())
                        player.pause()
                        handler.postDelayed({ setSyncing(false) }, 1500)
                    }
                    "seek" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        setSyncing(true, 2000)
                        player.seekTo((ts * 1000).toLong())
                        handler.postDelayed({ setSyncing(false) }, 1500)
                    }
                    "buffering-start" -> {
                        setSyncing(true, 30000) // long timeout for buffering
                        player.pause()
                        Toast.makeText(this, "Partner buffering...", Toast.LENGTH_SHORT).show()
                    }
                    "buffering-end-all" -> {
                        val ts = data.get("timestamp")?.asDouble ?: lastTimestamp
                        setSyncing(true, 2000)
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                        handler.postDelayed({ setSyncing(false) }, 1500)
                    }
                    "peer-ready" -> {
                        // Partner is ready, server will send play shortly — nothing to do
                        Log.d("MpvActivity", "Partner is ready")
                    }
                    "peer-disconnected" -> {
                        setSyncing(false) // unfreeze if waiting for partner
                        Toast.makeText(this, "Partner disconnected", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(timestampPoller)
        handler.removeCallbacks(syncTimeoutRunnable)
        player.release()
    }

    override fun onPause() {
        super.onPause()
        // do not pause — sync controls playback state
    }

    override fun onResume() {
        super.onResume()
        // do NOT auto-play — sync state controls playback
    }
}
