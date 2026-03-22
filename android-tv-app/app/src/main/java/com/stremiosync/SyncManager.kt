package com.stremiosync

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI

typealias SyncEventListener = (event: String, data: JsonObject) -> Unit

class SyncManager(private val serverUrl: String) {

    companion object {
        const val TAG = "SyncManager"
        const val SERVER_URL = "ws://192.168.11.103:3000"

        @Volatile private var instance: SyncManager? = null
        fun getInstance(): SyncManager {
            return instance ?: synchronized(this) {
                instance ?: SyncManager(SERVER_URL).also { instance = it }
            }
        }
    }

    private val gson = Gson()
    private var ws: WebSocketClient? = null
    private var listener: SyncEventListener? = null
    private var reconnectJob: Thread? = null

    private var currentRoomCode: String? = null
    private var currentRoomUrl: String? = null
    private var currentIsHost: Boolean = false

    fun setListener(l: SyncEventListener) {
        listener = l
    }

    fun connect() {
        ws = object : WebSocketClient(URI(serverUrl)) {

            override fun onOpen(handshake: ServerHandshake) {
                Log.d(TAG, "✅ Connected to sync server: $serverUrl")
                listener?.invoke("connected", JsonObject())
                startHeartbeat()
            }

            override fun onMessage(message: String) {
                try {
                    val json = gson.fromJson(message, JsonObject::class.java)
                    val event = json.get("event")?.asString ?: return
                    listener?.invoke(event, json)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse message: $message", e)
                }
            }

            override fun onClose(code: Int, reason: String, remote: Boolean) {
                Log.d(TAG, "❌ Disconnected: code=$code reason=$reason")
                listener?.invoke("disconnected", JsonObject())
                scheduleReconnect()
            }

            override fun onError(ex: Exception) {
                Log.e(TAG, "WebSocket error", ex)
            }
        }
        Log.d(TAG, "🔄 Connecting to: $serverUrl")
        ws?.connect()
    }

    fun send(event: String, vararg pairs: Pair<String, Any>) {
        val obj = JsonObject()
        obj.addProperty("event", event)
        pairs.forEach { (k, v) ->
            when (v) {
                is String -> obj.addProperty(k, v)
                is Number -> obj.addProperty(k, v)
                is Boolean -> obj.addProperty(k, v)
            }
        }
        ws?.send(gson.toJson(obj))
    }

    fun createRoom(url: String) {
        currentRoomUrl = url
        currentIsHost = true
        send("create-room", "url" to url)
    }

    fun joinRoom(code: String) {
        currentRoomCode = code
        currentIsHost = false
        send("join-room", "code" to code)
    }

    fun play(timestamp: Double) = send("play", "timestamp" to timestamp)
    fun pause(timestamp: Double) = send("pause", "timestamp" to timestamp)
    fun seek(timestamp: Double) = send("seek", "timestamp" to timestamp)
    fun bufferingStart(timestamp: Double) = send("buffering-start", "timestamp" to timestamp)
    fun bufferingEnd(timestamp: Double) = send("buffering-end", "timestamp" to timestamp)

    private fun startHeartbeat() {
        Thread {
            while (ws?.isOpen == true) {
                Thread.sleep(30000)
                send("ping")
            }
        }.also { it.isDaemon = true }.start()
    }

    private fun scheduleReconnect() {
        reconnectJob = Thread {
            Thread.sleep(3000)
            connect()
            Thread.sleep(1000)
            val code = currentRoomCode
            val url = currentRoomUrl
            if (!currentIsHost && code != null) {
                send("join-room", "code" to code)
            } else if (currentIsHost && url != null) {
                send("create-room", "url" to url)
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun disconnect() {
        ws?.close()
        ws = null
    }
	
	fun ready(timestamp: Double) = send("ready", "timestamp" to timestamp)
}
