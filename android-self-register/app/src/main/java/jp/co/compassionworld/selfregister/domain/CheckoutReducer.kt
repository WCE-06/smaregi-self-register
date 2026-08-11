package jp.co.compassionworld.selfregister.domain

import java.util.UUID

object CheckoutReducer {
    fun reduce(state: CheckoutState, action: CheckoutAction): CheckoutState = when (action) {
        is CheckoutAction.MemberScanned -> state.copy(
            memberCode = action.memberCode.trim().uppercase(),
            step = CheckoutStep.VerifyingMember,
        )
        CheckoutAction.MemberAccepted -> state.copy(step = CheckoutStep.ServiceSelection)
        is CheckoutAction.ServiceSelected -> state.copy(
            service = action.service,
            step = CheckoutStep.ProductSelection,
        )
        is CheckoutAction.CartConfirmed -> state.copy(
            cart = action.items,
            productRegistrationComplete = false,
            step = CheckoutStep.OrderReview,
        )
        CheckoutAction.ReviewAccepted -> state.copy(step = CheckoutStep.PaymentSelection)
        is CheckoutAction.PaymentSelected -> state.copy(
            paymentType = action.paymentType,
            step = CheckoutStep.StartingPayment,
        )
        CheckoutAction.ProductRegistrationCompleted -> state.copy(productRegistrationComplete = true)
        CheckoutAction.PaymentStarted -> state.copy(step = CheckoutStep.ConfirmingSale)
        CheckoutAction.SaleConfirmed -> state.copy(step = CheckoutStep.Completed)
        is CheckoutAction.Failed -> state.copy(step = CheckoutStep.RecoverableError(action.customerMessage))
        CheckoutAction.Back -> when (state.step) {
            CheckoutStep.ServiceSelection -> initialState()
            CheckoutStep.ProductSelection -> state.copy(step = CheckoutStep.ServiceSelection)
            CheckoutStep.OrderReview -> state.copy(step = CheckoutStep.ProductSelection)
            CheckoutStep.PaymentSelection -> state.copy(step = CheckoutStep.OrderReview)
            else -> state
        }
        CheckoutAction.Reset -> initialState()
    }

    fun initialState() = CheckoutState(transactionId = UUID.randomUUID().toString())
}
