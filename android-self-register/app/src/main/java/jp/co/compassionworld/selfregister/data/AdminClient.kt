package jp.co.compassionworld.selfregister.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object AdminClient {
    private const val ENDPOINT =
        "https://script.google.com/macros/s/AKfycbx-NlcSg-7MoAKRdySnfs05LY2Ttd3RVYEjWjcDx0MfLTE49EYazxUrV8e2CD-dAB8P/exec"

    suspend fun login(context: android.content.Context, password: String): String = withContext(Dispatchers.IO) {
        val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 8_000
        connection.readTimeout = 15_000
        connection.instanceFollowRedirects = true
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        val deviceId = DeviceAuthStore.deviceId(context)
        connection.outputStream.use { it.write(JSONObject().put("op", "employeeAdminLogin").put("password", password).put("deviceId", deviceId).toString().toByteArray()) }
        val body = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
            .bufferedReader().use { it.readText() }
        val json = JSONObject(body)
        if (!json.optBoolean("ok")) error(json.optString("error", "ADMIN_LOGIN_FAILED"))
        val result = json.optJSONObject("result") ?: error("ADMIN_LOGIN_FAILED")
        result.optString("deviceToken").takeIf { it.isNotBlank() }?.let { DeviceAuthStore.saveToken(context, it) }
        result.optString("url").takeIf { it.startsWith("https://") } ?: error("ADMIN_LOGIN_FAILED")
    }
}
