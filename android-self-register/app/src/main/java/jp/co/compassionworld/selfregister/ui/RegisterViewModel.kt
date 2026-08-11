package jp.co.compassionworld.selfregister.ui

import androidx.lifecycle.ViewModel
import jp.co.compassionworld.selfregister.domain.CheckoutAction
import jp.co.compassionworld.selfregister.domain.CheckoutReducer
import jp.co.compassionworld.selfregister.domain.CheckoutState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class RegisterViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(CheckoutReducer.initialState())
    val uiState: StateFlow<CheckoutState> = _uiState.asStateFlow()

    fun dispatch(action: CheckoutAction) {
        _uiState.value = CheckoutReducer.reduce(_uiState.value, action)
    }
}
