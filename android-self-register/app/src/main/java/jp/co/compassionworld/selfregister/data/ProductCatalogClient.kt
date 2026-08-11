package jp.co.compassionworld.selfregister.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class CatalogProduct(
    val code: String,
    val name: String,
    val price: Int,
    val basePrice: Int,
    val taxDivision: String,
    val taxRate: Int,
    val section: String,
    val barcode: Boolean,
    val imageUrl: String?,
    val menuCategory: String,
    val displaySequence: Int,
    val description: String,
    val optionGroups: String,
    val cocktailBase: String,
    val cocktailMixer: String,
    val soldOut: Boolean,
    val scheduleEnabled: Boolean,
    val scheduleStart: String,
    val scheduleEnd: String,
    val scheduleDays: Set<Int>,
)

object ProductCatalogClient {
    private const val ENDPOINT =
        "https://script.google.com/macros/s/AKfycbx-NlcSg-7MoAKRdySnfs05LY2Ttd3RVYEjWjcDx0MfLTE49EYazxUrV8e2CD-dAB8P/exec?api=catalog"
    private const val CACHE_FILE = "product-catalog.json"

    suspend fun loadCached(context: Context): List<CatalogProduct> = withContext(Dispatchers.IO) {
        val cache = context.filesDir.resolve(CACHE_FILE)
        if (cache.exists()) runCatching { parse(cache.readText()) }.getOrDefault(emptyList()) else emptyList()
    }

    suspend fun load(context: Context): List<CatalogProduct> = withContext(Dispatchers.IO) {
        val cache = context.filesDir.resolve(CACHE_FILE)
        try {
            val connection = URL("$ENDPOINT&sync=${System.currentTimeMillis()}").openConnection() as HttpURLConnection
            connection.connectTimeout = 8_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val products = parse(body)
            require(products.isNotEmpty()) { "EMPTY_PRODUCT_CATALOG" }
            cache.writeText(body)
            products
        } catch (error: Exception) {
            if (cache.exists()) parse(cache.readText()) else emptyList()
        }
    }

    private fun parse(body: String): List<CatalogProduct> {
        val root = JSONObject(body)
        if (!root.optBoolean("ok")) return emptyList()
        val products = root.optJSONObject("result")?.optJSONArray("products") ?: JSONArray()
        return buildList {
            for (index in 0 until products.length()) {
                val item = products.optJSONObject(index) ?: continue
                val code = item.optString("code").trim()
                val name = item.optString("name").trim()
                val schedule = item.optJSONObject("schedule")
                val days = schedule?.optJSONArray("days")
                if (code.isEmpty() || name.isEmpty()) continue
                add(
                    CatalogProduct(
                        code = code,
                        name = name,
                        price = item.optInt("price"),
                        basePrice = item.optInt("basePrice", item.optInt("price")),
                        taxDivision = item.optString("taxDivision", "0"),
                        taxRate = item.optInt("taxRate", 10),
                        section = item.optString("section", "shop"),
                        barcode = item.optBoolean("barcode", true),
                        imageUrl = item.optString("imageUrl").takeIf { it.isNotBlank() },
                        menuCategory = item.optString("menuCategory"),
                        displaySequence = item.optInt("displaySequence", Int.MAX_VALUE),
                        description = item.optString("description"),
                        optionGroups = item.optJSONArray("optionGroups")?.toString().orEmpty(),
                        cocktailBase = item.optString("cocktailBase"),
                        cocktailMixer = item.optString("cocktailMixer"),
                        soldOut = item.optBoolean("soldOut", false),
                        scheduleEnabled = schedule?.optBoolean("enabled", true) ?: true,
                        scheduleStart = schedule?.optString("start", "00:00") ?: "00:00",
                        scheduleEnd = schedule?.optString("end", "23:59") ?: "23:59",
                        scheduleDays = buildSet { if (days == null) addAll(1..7) else for (dayIndex in 0 until days.length()) add(days.optInt(dayIndex)) },
                    )
                )
            }
        }.sortedWith(compareBy<CatalogProduct> { it.displaySequence }.thenBy { it.name })
    }
}
