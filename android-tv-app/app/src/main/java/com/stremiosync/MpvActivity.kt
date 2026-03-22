package com.stremiosync

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
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

    // Poll timestamp every second
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
		
        val roomCode = intent.getStringExtra("roomCode") ?: ""
        val isHost = intent.getBooleanExtra("isHost", false)

        // Fullscreen
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        // Setup PlayerView
        playerView = PlayerView(this)
        setContentView(playerView)

        // Setup ExoPlayer
        player = ExoPlayer.Builder(this).build()
        playerView.player = player
        playerView.useController = true

        // Load video
        val mediaItem = MediaItem.fromUri(url)
        player.setMediaItem(mediaItem)
        player.prepare()
        player.playWhenReady = true

        // Setup sync
        syncManager = SyncManager.getInstance()
        setupPlayerListeners()
        setupSyncListeners()
        

        // Start timestamp polling
        handler.post(timestampPoller)
    }

    private fun setupPlayerListeners() {
        player.addListener(object : Player.Listener {

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isSyncing) return
                lastTimestamp = player.currentPosition / 1000.0
                if (isPlaying) {
                    syncManager.play(lastTimestamp)
                } else {
                    syncManager.pause(lastTimestamp)
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (isSyncing) return
                when (playbackState) {
                    Player.STATE_BUFFERING -> syncManager.bufferingStart(lastTimestamp)
                    Player.STATE_READY -> syncManager.bufferingEnd(lastTimestamp)
                }
            }
        })
    }

    private fun setupSyncListeners() {
        syncManager.setListener { event, data ->
            runOnUiThread {
                isSyncing = true
                when (event) {
                    "play" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                    }
                    "pause" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        player.seekTo((ts * 1000).toLong())
                        player.pause()
                    }
                    "seek" -> {
                        val ts = data.get("timestamp")?.asDouble ?: 0.0
                        player.seekTo((ts * 1000).toLong())
                    }
                    "buffering-start" -> {
                        player.pause()
                        Toast.makeText(this, "Partner buffering...", Toast.LENGTH_SHORT).show()
                    }
                    "buffering-end-all" -> {
                        val ts = data.get("timestamp")?.asDouble ?: lastTimestamp
                        player.seekTo((ts * 1000).toLong())
                        player.play()
                    }
                    "peer-disconnected" -> {
                        Toast.makeText(this, "Partner disconnected", Toast.LENGTH_SHORT).show()
                    }
                }
                handler.postDelayed({ isSyncing = false }, 1500)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(timestampPoller)
        player.release()
    }

    override fun onPause() {
        super.onPause()
        player.pause()
    }

    override fun onResume() {
        super.onResume()
    }
}