package jp.co.compassionworld.selfregister.domain

enum class ServiceType { SHOP, AOZORA_KITCHEN, FEBBRAIO }
enum class PaymentType { CASH, CREDIT, TRANSPORT_IC, QUICPAY, ID, BARCODE }

data class CartItem(
    val productCode: String,
    val name: String,
    val quantity: Int,
    val unitPriceIncludingTax: Int,
    val imageUrl: String? = null,
    val customizations: Map<String, String> = emptyMap(),
)

sealed interface CheckoutStep {
    data object MemberScan : CheckoutStep
    data object VerifyingMember : CheckoutStep
    data object ServiceSelection : CheckoutStep
    data object ProductSelection : CheckoutStep
    data object OrderReview : CheckoutStep
    data object PaymentSelection : CheckoutStep
    data object StartingPayment : CheckoutStep
    data object ConfirmingSale : CheckoutStep
    data object Completed : CheckoutStep
    data class RecoverableError(val message: String) : CheckoutStep
}

data class CheckoutState(
    val transactionId: String,
    val step: CheckoutStep = CheckoutStep.MemberScan,
    val memberCode: String? = null,
    val service: ServiceType? = null,
    val cart: List<CartItem> = emptyList(),
    val paymentType: PaymentType? = null,
    val productRegistrationComplete: Boolean = false,
) {
    val totalIncludingTax: Int get() = cart.sumOf { it.unitPriceIncludingTax * it.quantity }
}

sealed interface CheckoutAction {
    data class MemberScanned(val memberCode: String) : CheckoutAction
    data object MemberAccepted : CheckoutAction
    data class ServiceSelected(val service: ServiceType) : CheckoutAction
    data class CartConfirmed(val items: List<CartItem>) : CheckoutAction
    data object ReviewAccepted : CheckoutAction
    data class PaymentSelected(val paymentType: PaymentType) : CheckoutAction
    data object ProductRegistrationCompleted : CheckoutAction
    data object PaymentStarted : CheckoutAction
    data object SaleConfirmed : CheckoutAction
    data class Failed(val customerMessage: String) : CheckoutAction
    data object Back : CheckoutAction
    data object Reset : CheckoutAction
}
