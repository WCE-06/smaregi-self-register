package jp.co.compassionworld.selfregister.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class FebbraioCheckout(
    val sessionId: String,
    val productCode: String,
    val billingHours: Int,
    val billingMinutes: Int,
    val billingAmount: Int,
)

data class SaleMatch(val transactionId: String, val total: Int)

object RegisterApiClient {
    private const val ENDPOINT =
        "https://script.google.com/macros/s/AKfycbx-NlcSg-7MoAKRdySnfs05LY2Ttd3RVYEjWjcDx0MfLTE49EYazxUrV8e2CD-dAB8P/exec"
    private lateinit var applicationContext: Context

    fun configure(context: Context) {
        applicationContext = context.applicationContext
    }

    suspend fun verifyMember(memberCode: String): Boolean {
        val result = call("member", JSONObject().put("memberCode", memberCode))
        android.util.Log.i("SelfRegister", "member result=${result.optString("code")} length=${memberCode.length} suffix=${memberCode.takeLast(4)}")
        return result.optBoolean("found")
    }

    suspend fun checkoutFebbraio(memberCode: String, requestId: String): FebbraioCheckout {
        val result = call("febbraioCharge", JSONObject().put("memberCode", memberCode).put("requestId", requestId))
        return FebbraioCheckout(
            sessionId = result.getString("sessionId"),
            productCode = result.getString("productCode").uppercase(),
            billingHours = result.getInt("billingHours"),
            billingMinutes = result.getInt("billingMinutes"),
            billingAmount = result.getInt("billingAmount"),
        )
    }

    suspend fun enqueue(
        businessKey: String,
        memberCode: String = "",
        productCodes: List<String> = emptyList(),
        finishAction: String = "",
        secondaryAction: String = "",
        tertiaryAction: String = "",
        dependsOnJobId: String = "",
    ): String {
        val form = JSONObject()
            .put("businessKey", businessKey)
            .put("memberCode", memberCode)
            .put("useForcedNo", memberCode.isNotBlank())
            .put("productCodes", JSONArray(productCodes))
            .put("finishAction", finishAction)
            .put("secondaryAction", secondaryAction)
            .put("tertiaryAction", tertiaryAction)
            .put("dependsOnJobId", dependsOnJobId)
        return call("enqueue", JSONObject().put("form", form)).getString("id")
    }

    suspend fun awaitJob(jobId: String, timeoutMs: Long = 90_000): String {
        val started = System.currentTimeMillis()
        while (System.currentTimeMillis() - started < timeoutMs) {
            val result = call("status", JSONObject().put("jobId", jobId))
            when (val status = result.optString("status")) {
                "COMPLETED" -> return result.optString("result")
                "ERROR", "NOT_FOUND" -> error("REGISTER_JOB_$status: ${result.optString("result")}")
            }
            delay(350)
        }
        error("REGISTER_JOB_TIMEOUT")
    }

    suspend fun findSale(memberCode: String, productCodes: List<String>, expectedTotal: Int, sinceMs: Long): SaleMatch? {
        val result = call(
            "smaregiSale",
            JSONObject().put("memberCode", memberCode).put("productCodes", JSONArray(productCodes))
                .put("expectedTotal", expectedTotal).put("sinceMs", sinceMs),
        )
        if (!result.optBoolean("found")) return null
        return SaleMatch(result.getString("transactionId"), result.getInt("total"))
    }

    suspend fun completeFebbraio(sessionId: String, transactionId: String, requestId: String) {
        val result = call(
            "febbraioPayment",
            JSONObject().put("sessionId", sessionId).put("transactionId", transactionId).put("requestId", requestId),
        )
        check(result.optString("paymentStatus", result.optString("status")).uppercase() == "PAID")
    }

    private suspend fun call(action: String, payload: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        check(::applicationContext.isInitialized) { "REGISTER_API_NOT_CONFIGURED" }
        val deviceId = DeviceAuthStore.deviceId(applicationContext)
        val deviceToken = DeviceAuthStore.token(applicationContext)
        check(deviceToken.isNotBlank()) { "ANDROID_DEVICE_AUTH_REQUIRED" }
        val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 8_000
        connection.readTimeout = 70_000
        connection.instanceFollowRedirects = true
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        val request = JSONObject().put("op", "androidUi").put("deviceId", deviceId).put("deviceToken", deviceToken)
            .put("action", action).put("payload", payload)
        connection.outputStream.use { it.write(request.toString().toByteArray(Charsets.UTF_8)) }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val root = JSONObject(stream.bufferedReader().use { it.readText() })
        if (!root.optBoolean("ok")) error(root.optString("error", "REGISTER_API_ERROR"))
        root.optJSONObject("result") ?: JSONObject()
    }
}
