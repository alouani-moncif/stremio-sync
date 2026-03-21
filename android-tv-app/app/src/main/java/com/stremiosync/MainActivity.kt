package com.stremiosync

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.widget.*
import androidx.fragment.app.FragmentActivity
import com.google.gson.JsonObject

class MainActivity : FragmentActivity() {

    private lateinit var syncManager: SyncManager
    private lateinit var statusText: TextView
    private lateinit var roomCodeText: TextView
    private lateinit var codeInput: EditText
    private lateinit var createBtn: Button
    private lateinit var joinBtn: Button
    private lateinit var peerStatus: TextView

    private var interceptedUrl: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        roomCodeText = findViewById(R.id.roomCodeText)
        codeInput = findViewById(R.id.codeInput)
        createBtn = findViewById(R.id.createBtn)
        joinBtn = findViewById(R.id.joinBtn)
        peerStatus = findViewById(R.id.peerStatus)

        syncManager = SyncManager(SyncManager.SERVER_URL)
        setupSyncListeners()
        syncManager.connect()

        createBtn.setOnClickListener {
            val url = interceptedUrl ?: return@setOnClickListener
            syncManager.createRoom(url)
            createBtn.isEnabled = false
            createBtn.text = "Creating..."
        }

        joinBtn.setOnClickListener {
            val code = codeInput.text.toString().trim().uppercase()
            if (code.length < 4) {
                Toast.makeText(this, "Enter a valid room code", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            syncManager.joinRoom(code)
            joinBtn.isEnabled = false
            joinBtn.text = "Joining..."
        }

        // Handle intent (intercepted from Stremio or video URL)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val data: Uri? = intent.data
        if (data != null) {
            val streamUrl = when {
                // stremio:// protocol
                data.scheme == "stremio" -> data.getQueryParameter("streamUrl")
                // Direct video URL (open with)
                intent.type?.startsWith("video/") == true -> data.toString()
                else -> null
            }
            streamUrl?.let {
                interceptedUrl = it
                runOnUiThread {
                    statusText.text = "✓ URL captured from Stremio"
                    createBtn.isEnabled = true
                }
            }
        }
    }

    private fun setupSyncListeners() {
        syncManager.setListener { event, data ->
            runOnUiThread {
                when (event) {
                    "connected" -> {
                        statusText.text = "● Connected to server"
                        joinBtn.isEnabled = true
                        if (interceptedUrl != null) createBtn.isEnabled = true
                    }
                    "disconnected" -> {
                        statusText.text = "○ Reconnecting..."
                        createBtn.isEnabled = false
                        joinBtn.isEnabled = false
                    }
                    "room-created" -> {
                        val code = data.get("code").asString
                        roomCodeText.text = code
                        roomCodeText.visibility = android.view.View.VISIBLE
                        peerStatus.text = "Waiting for partner..."
                        peerStatus.visibility = android.view.View.VISIBLE
                        // Launch MPV
                        interceptedUrl?.let { launchMpvActivity(it, code, true) }
                    }
                    "room-joined" -> {
                        val url = data.get("url").asString
                        val code = data.get("code").asString
                        peerStatus.text = "Joined room $code"
                        peerStatus.visibility = android.view.View.VISIBLE
                        launchMpvActivity(url, code, false)
                    }
                    "peer-connected" -> peerStatus.text = "Partner connected ✓"
                    "peer-disconnected" -> peerStatus.text = "Partner disconnected"
                    "buffering-start" -> peerStatus.text = "Partner buffering..."
                    "buffering-end-all" -> peerStatus.text = "Partner ready ✓"
                    "error" -> Toast.makeText(
                        this,
                        data.get("message")?.asString ?: "Unknown error",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    private fun launchMpvActivity(url: String, roomCode: String, isHost: Boolean) {
        val intent = Intent(this, MpvActivity::class.java).apply {
            putExtra("url", url)
            putExtra("roomCode", roomCode)
            putExtra("isHost", isHost)
        }
        startActivity(intent)
    }
}
