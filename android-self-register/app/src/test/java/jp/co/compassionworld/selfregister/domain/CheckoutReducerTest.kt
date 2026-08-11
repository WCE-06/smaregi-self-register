package jp.co.compassionworld.selfregister.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class CheckoutReducerTest {
    @Test fun normalFlowKeepsOneTransactionId() {
        val initial = CheckoutReducer.initialState()
        val verified = CheckoutReducer.reduce(initial, CheckoutAction.MemberScanned("650a0db2f6"))
        val services = CheckoutReducer.reduce(verified, CheckoutAction.MemberAccepted)
        assertEquals("650A0DB2F6", services.memberCode)
        assertEquals(initial.transactionId, services.transactionId)
        assertEquals(CheckoutStep.ServiceSelection, services.step)
    }

    @Test fun resetCreatesNewTransaction() {
        val initial = CheckoutReducer.initialState()
        val reset = CheckoutReducer.reduce(initial, CheckoutAction.Reset)
        assert(initial.transactionId != reset.transactionId)
        assertEquals(CheckoutStep.MemberScan, reset.step)
    }
}
