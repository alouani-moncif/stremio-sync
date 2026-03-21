package com.stremiosync

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.*
import java.net.Socket

typealias MpvEventListener = (event: String, data: JsonObject) -> Unit

class MpvIpcManager(private val socketPath: String = "/data/data/com.stremiosync/files/mpv-socket") {

    companion object {
        const val TAG = "MpvIpcManager"
    }

    private val gson = Gson()
    private var socket: Socket? = null
    private var writer: PrintWriter? = null
    private var reader: BufferedReader? = null
    private var listening = false
    private var eventListener: MpvEventListener? = null
    private val commandQueue = mutableListOf<String>()

    fun setEventListener(l: MpvEventListener) {
        eventListener = l
    }

    fun connect() {
        Thread {
            // Wait for MPV to create the socket
            var attempts = 0
            while (attempts < 20) {
                try {
                    val file = File(socketPath)
                    if (!file.exists()) {
                        Thread.sleep(500)
                        attempts++
                        continue
                    }
                    // Android local socket via file path
                    val localSocket = android.net.LocalSocket()
                    localSocket.connect(android.net.LocalSocketAddress(socketPath,
                        android.net.LocalSocketAddress.Namespace.FILESYSTEM))

                    writer = PrintWriter(BufferedWriter(OutputStreamWriter(localSocket.outputStream)))
                    reader = BufferedReader(InputStreamReader(localSocket.inputStream))
                    listening = true

                    Log.d(TAG, "Connected to MPV IPC socket")

                    // Flush queued commands
                    commandQueue.forEach { sendRaw(it) }
                    commandQueue.clear()

                    // Observe properties
                    sendCommand("observe_property", 1, "pause")
                    sendCommand("observe_property", 2, "time-pos")
                    sendCommand("observe_property", 3, "paused-for-cache")

                    // Read loop
                    while (listening) {
                        val line = reader?.readLine() ?: break
                        try {
                            val json = gson.fromJson(line, JsonObject::class.java)
                            handleMpvMessage(json)
                        } catch (e: Exception) { /* ignore parse errors */ }
                    }
                    break
                } catch (e: Exception) {
                    Log.e(TAG, "MPV IPC connect failed, retrying...", e)
                    Thread.sleep(500)
                    attempts++
                }
            }
        }.also { it.isDaemon = true }.start()
    }

    private fun handleMpvMessage(json: JsonObject) {
        val event = json.get("event")?.asString ?: return
        eventListener?.invoke(event, json)
    }

    fun sendCommand(vararg args: Any) {
        val obj = JsonObject()
        val arr = com.google.gson.JsonArray()
        args.forEach { arg ->
            when (arg) {
                is String -> arr.add(arg)
                is Int -> arr.add(arg)
                is Double -> arr.add(arg)
                is Boolean -> arr.add(arg)
            }
        }
        obj.add("command", arr)
        sendRaw(gson.toJson(obj))
    }

    private fun sendRaw(cmd: String) {
        if (writer == null) {
            commandQueue.add(cmd)
            return
        }
        writer?.println(cmd)
        writer?.flush()
    }

    fun play() = sendCommand("set_property", "pause", false)
    fun pause() = sendCommand("set_property", "pause", true)
    fun seekTo(timestamp: Double) = sendCommand("seek", timestamp, "absolute")

    fun getTimestamp(callback: (Double) -> Unit) {
        sendCommand("get_property", "time-pos")
        // Response comes back via event listener
    }

    fun disconnect() {
        listening = false
        writer?.close()
        reader?.close()
        socket?.close()
    }
}
