package jp.co.compassionworld.selfregister.data

import jp.co.compassionworld.selfregister.domain.CartItem
import jp.co.compassionworld.selfregister.domain.PaymentType
import jp.co.compassionworld.selfregister.domain.ServiceType

data class MemberResult(val found: Boolean)
data class Product(val code: String, val name: String, val priceIncludingTax: Int, val section: ServiceType)
data class StudioUsage(val found: Boolean, val productCode: String? = null, val usageMinutes: Int = 0)

interface RegisterRepository {
    suspend fun verifyMember(memberCode: String): MemberResult
    suspend fun cachedProducts(): List<Product>
    suspend fun refreshProducts(): List<Product>
    suspend fun febbraioUsage(memberCode: String): StudioUsage
    suspend fun enqueueProducts(transactionId: String, memberCode: String, items: List<CartItem>): String
    suspend fun startPayment(transactionId: String, productJobId: String, paymentType: PaymentType): String
    suspend fun waitForSmaregiSale(transactionId: String, expectedTotal: Int): Boolean
    suspend fun returnRegisterToInitialState(transactionId: String)
}
