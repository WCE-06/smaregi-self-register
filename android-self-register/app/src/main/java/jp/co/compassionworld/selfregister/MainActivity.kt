package jp.co.compassionworld.selfregister

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.platform.LocalContext
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.co.compassionworld.selfregister.domain.*
import jp.co.compassionworld.selfregister.data.CatalogProduct
import jp.co.compassionworld.selfregister.data.ProductCatalogClient
import jp.co.compassionworld.selfregister.data.AdminClient
import jp.co.compassionworld.selfregister.data.FebbraioCheckout
import jp.co.compassionworld.selfregister.data.RegisterApiClient
import jp.co.compassionworld.selfregister.ui.RegisterViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import coil3.compose.AsyncImage
import kotlin.math.ceil
import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.text.Normalizer

private val Forest = Color(0xFF185C43)
private val Ink = Color(0xFF173229)
private val Cream = Color(0xFFF5F0E6)
private val Paper = Color(0xFFFFFDF8)
private val Muted = Color(0xFF68736D)
private val Gold = Color(0xFFD9A441)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterKioskDisplay()
        setContent { SelfRegisterTheme { RegisterApp() } }
        window.decorView.postDelayed({ enterKioskDisplay() }, 700)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterKioskDisplay()
    }

    private fun enterKioskDisplay() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}

@Composable
private fun SelfRegisterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(primary = Forest, background = Cream, surface = Paper),
        typography = Typography(
            headlineLarge = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Bold),
            headlineMedium = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
        ),
        content = content,
    )
}

@Composable
private fun RegisterApp(viewModel: RegisterViewModel = viewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val workflowScope = rememberCoroutineScope()
    LaunchedEffect(context) { RegisterApiClient.configure(context) }
    var catalog by remember { mutableStateOf<List<CatalogProduct>>(emptyList()) }
    var activityKey by remember { mutableIntStateOf(0) }
    var adminTapCount by remember { mutableIntStateOf(0) }
    var lastAdminTapAt by remember { mutableLongStateOf(0L) }
    var showAdminLogin by remember { mutableStateOf(false) }
    var adminUrl by remember { mutableStateOf<String?>(null) }
    var memberJobDeferred by remember { mutableStateOf<Deferred<String>?>(null) }
    var productJobId by remember { mutableStateOf("") }
    var febbraioCheckout by remember { mutableStateOf<FebbraioCheckout?>(null) }
    var saleStartedAt by remember { mutableLongStateOf(0L) }
    val openAdmin: () -> Unit = {
        val now = android.os.SystemClock.elapsedRealtime()
        adminTapCount = if (now - lastAdminTapAt <= 1_800) adminTapCount + 1 else 1
        lastAdminTapAt = now
        if (adminTapCount >= 5) { adminTapCount = 0; showAdminLogin = true }
    }
    val reset: () -> Unit = {
        viewModel.dispatch(CheckoutAction.Reset)
        memberJobDeferred = null
        productJobId = ""
        febbraioCheckout = null
        saleStartedAt = 0L
        activityKey++
        Unit
    }

    LaunchedEffect(state.step, activityKey) {
        if (state.step !is CheckoutStep.MemberScan && state.step !is CheckoutStep.Completed) {
            delay(60_000)
            reset()
        }
    }
    LaunchedEffect(Unit) {
        catalog = ProductCatalogClient.loadCached(context)
        while (true) {
            ProductCatalogClient.load(context).takeIf { it.isNotEmpty() }?.let { catalog = it }
            delay(15 * 60_000L)
        }
    }

    LaunchedEffect(state.step, state.memberCode, state.service, state.cart, state.paymentType) {
        try {
            when (state.step) {
                CheckoutStep.VerifyingMember -> {
                    val memberCode = state.memberCode ?: error("MEMBER_CODE_REQUIRED")
                    if (!RegisterApiClient.verifyMember(memberCode)) error("会員情報を確認できませんでした。")
                    // 顧客名簿の確認が済んだ時点で画面を先へ進める。
                    // スマレジiPadへの会員入力は、店舗選択中に裏で並行実行する。
                    memberJobDeferred = workflowScope.async {
                        RegisterApiClient.enqueue(
                            businessKey = "${state.transactionId}_member",
                            memberCode = memberCode,
                        )
                    }
                    viewModel.dispatch(CheckoutAction.MemberAccepted)
                }
                CheckoutStep.ProductSelection -> if (state.service == ServiceType.FEBBRAIO && febbraioCheckout == null) {
                    val memberCode = state.memberCode ?: error("MEMBER_CODE_REQUIRED")
                    val checkout = RegisterApiClient.checkoutFebbraio(memberCode, state.transactionId)
                    val master = catalog.firstOrNull { it.code.equals(checkout.productCode, ignoreCase = true) }
                        ?: error("料金商品が商品マスターにありません。")
                    if (master.price != checkout.billingAmount) error("受付料金とスマレジの商品価格が一致しません。")
                    febbraioCheckout = checkout
                    viewModel.dispatch(
                        CheckoutAction.CartConfirmed(
                            listOf(
                                CartItem(
                                    productCode = master.code,
                                    name = master.name,
                                    quantity = 1,
                                    unitPriceIncludingTax = master.price,
                                    customizations = mapOf("利用時間" to checkout.billingHours.toString()),
                                ),
                            ),
                        ),
                    )
                }
                CheckoutStep.OrderReview -> if (productJobId.isBlank() && state.cart.isNotEmpty()) {
                    val memberJobId = memberJobDeferred?.await().orEmpty()
                    productJobId = RegisterApiClient.enqueue(
                        businessKey = "${state.transactionId}_products",
                        productCodes = state.cart.flatMap { item -> List(item.quantity) { item.productCode } },
                        dependsOnJobId = memberJobId,
                    )
                    RegisterApiClient.awaitJob(productJobId)
                    viewModel.dispatch(CheckoutAction.ProductRegistrationCompleted)
                }
                CheckoutStep.StartingPayment -> {
                    val payment = state.paymentType ?: error("PAYMENT_TYPE_REQUIRED")
                    val actions = paymentActions(payment)
                    saleStartedAt = System.currentTimeMillis()
                    val jobId = RegisterApiClient.enqueue(
                        businessKey = "${state.transactionId}_payment_${payment.name}",
                        finishAction = actions.first,
                        secondaryAction = actions.second,
                        tertiaryAction = actions.third,
                        dependsOnJobId = productJobId,
                    )
                    RegisterApiClient.awaitJob(jobId)
                    viewModel.dispatch(CheckoutAction.PaymentStarted)
                }
                CheckoutStep.ConfirmingSale -> {
                    val memberCode = state.memberCode ?: error("MEMBER_CODE_REQUIRED")
                    val deadline = System.currentTimeMillis() + 180_000L
                    var sale: jp.co.compassionworld.selfregister.data.SaleMatch? = null
                    while (sale == null && System.currentTimeMillis() < deadline) {
                        sale = RegisterApiClient.findSale(
                            memberCode,
                            state.cart.flatMap { item -> List(item.quantity) { item.productCode } },
                            state.totalIncludingTax,
                            saleStartedAt,
                        )
                        if (sale == null) delay(2_000)
                    }
                    val confirmed = sale ?: error("お支払いの確認が完了しませんでした。")
                    febbraioCheckout?.let {
                        RegisterApiClient.completeFebbraio(it.sessionId, confirmed.transactionId, "${state.transactionId}_paid")
                    }
                    viewModel.dispatch(CheckoutAction.SaleConfirmed)
                }
                else -> Unit
            }
        } catch (error: Exception) {
            android.util.Log.e(
                "SelfRegister",
                "checkout step=${state.step::class.simpleName} error=${error.message}",
                error,
            )
            viewModel.dispatch(CheckoutAction.Failed(customerErrorMessage(error)))
        }
    }

    if (adminUrl != null) {
        AdminWebView(adminUrl!!, onClose = { adminUrl = null })
        return
    }
    Surface(Modifier.fillMaxSize(), color = Cream) {
        Column(Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 14.dp)) {
            val canBack = state.step is CheckoutStep.ServiceSelection ||
                state.step is CheckoutStep.ProductSelection || state.step is CheckoutStep.OrderReview ||
                state.step is CheckoutStep.PaymentSelection
            RegisterHeader(
                canBack = canBack,
                canCancel = state.step !is CheckoutStep.MemberScan,
                onBack = { viewModel.dispatch(CheckoutAction.Back) },
                onCancel = reset,
                onLogoTap = openAdmin,
            )
            Spacer(Modifier.height(12.dp))
            Card(
                Modifier.fillMaxSize(),
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = Paper),
                elevation = CardDefaults.cardElevation(defaultElevation = 3.dp),
            ) {
                Box(Modifier.fillMaxSize().padding(22.dp)) {
                    when (val step = state.step) {
                        CheckoutStep.MemberScan -> MemberScanScreen { viewModel.dispatch(CheckoutAction.MemberScanned(it)) }
                        CheckoutStep.VerifyingMember -> VerifyingMemberScreen()
                        CheckoutStep.ServiceSelection -> ServiceScreen {
                            viewModel.dispatch(CheckoutAction.ServiceSelected(it))
                        }
                        CheckoutStep.ProductSelection -> ProductScreen(state.service, catalog, state.cart) {
                            viewModel.dispatch(CheckoutAction.CartConfirmed(it))
                        }
                        CheckoutStep.OrderReview -> ReviewScreen(state,
                            onConfirm = { viewModel.dispatch(CheckoutAction.ReviewAccepted) },
                        )
                        CheckoutStep.PaymentSelection -> PaymentScreen(state) {
                            viewModel.dispatch(CheckoutAction.PaymentSelected(it))
                        }
                        CheckoutStep.StartingPayment -> PaymentStartingScreen()
                        CheckoutStep.ConfirmingSale -> SaleConfirmingScreen()
                        CheckoutStep.Completed -> CompletedScreen(reset)
                        is CheckoutStep.RecoverableError -> ErrorScreen(step.message, reset)
                    }
                }
            }
        }
    }
    if (showAdminLogin) AdminLoginDialog(onDismiss = { showAdminLogin = false }, onAuthenticated = { showAdminLogin = false; adminUrl = it })
}

@Composable
private fun RegisterHeader(canBack: Boolean, canCancel: Boolean, onBack: () -> Unit, onCancel: () -> Unit, onLogoTap: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(54.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(48.dp).background(Forest, RoundedCornerShape(15.dp)).clickable(onClick = onLogoTap), contentAlignment = Alignment.Center) {
            Text("お", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text("セルフレジ", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold)
            Text("かんたん・スムーズなお会計", color = Muted, fontSize = 12.sp)
        }
        Spacer(Modifier.weight(1f))
        if (canBack) {
            OutlinedButton(onClick = onBack, shape = RoundedCornerShape(14.dp)) {
                Text("← 前の画面へ戻る", color = Forest, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(10.dp))
        }
        if (canCancel) {
            OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(14.dp)) {
                Text("取引を中止する", color = Forest, fontWeight = FontWeight.Bold)
            }
        } else {
            Surface(shape = RoundedCornerShape(20.dp), color = Color(0xFFE5F3EB)) {
                Text("●  準備できています", Modifier.padding(horizontal = 18.dp, vertical = 10.dp), color = Forest)
            }
        }
    }
}

@Composable
private fun AdminLoginDialog(onDismiss: () -> Unit, onAuthenticated: (String) -> Unit) {
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("従業員用管理画面") },
        text = { Column(horizontalAlignment=Alignment.CenterHorizontally) {
            Text("画面のテンキーで従業員用パスワードを入力してください。")
            Spacer(Modifier.height(10.dp))
            Surface(Modifier.fillMaxWidth().height(50.dp),shape=RoundedCornerShape(10.dp),color=Color.White,border=androidx.compose.foundation.BorderStroke(1.dp,Color(0xFFD4CEC4))) {
                Box(contentAlignment=Alignment.Center){Text("●".repeat(password.length),fontSize=20.sp,letterSpacing=4.sp,color=Ink)}
            }
            Spacer(Modifier.height(10.dp))
            listOf(listOf("1","2","3"),listOf("4","5","6"),listOf("7","8","9"),listOf("クリア","0","⌫")).forEach { row ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    row.forEach { key -> OutlinedButton(
                        onClick={when(key){"クリア"->password="";"⌫"->password=password.dropLast(1);else->if(password.length<20)password+=key}},
                        modifier=Modifier.weight(1f).height(48.dp),shape=RoundedCornerShape(11.dp)
                    ){Text(key,fontSize=if(key=="クリア")12.sp else 19.sp,fontWeight=FontWeight.Bold)} }
                }
                Spacer(Modifier.height(7.dp))
            }
            if(message.isNotEmpty()) Text(message,color=Color(0xFFA43D30),fontSize=12.sp)
        } },
        confirmButton = { Button(enabled=!busy&&password.isNotEmpty(),onClick={busy=true;message="確認しています…";scope.launch{runCatching{AdminClient.login(context,password)}.onSuccess(onAuthenticated).onFailure{message=if(it.message.orEmpty().contains("LOCKED"))"試行回数が多いため、10分後にお試しください。" else "パスワードが正しくありません。"};busy=false}}){Text("管理画面へ")} },
        dismissButton = { TextButton(enabled=!busy,onClick=onDismiss){Text("キャンセル")} },
    )
}

@Composable
private fun AdminWebView(url: String, onClose: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Cream)) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) { Text("従業員用管理画面", color=Ink, fontSize=20.sp, fontWeight=FontWeight.Bold); Spacer(Modifier.weight(1f)); Button(onClick=onClose){Text("セルフレジへ戻る")} }
        AndroidView(factory={ context -> WebView(context).apply { settings.javaScriptEnabled=true; settings.domStorageEnabled=true; webViewClient=WebViewClient(); loadUrl(url) } }, modifier=Modifier.fillMaxSize())
    }
}

@Composable
private fun MemberScanScreen(onScan: (String) -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("いらっしゃいませ。", color = Ink, fontSize = 38.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            Text("お会計の最初に会員証をスキャンしてください。", color = Muted, fontSize = 20.sp)
            Spacer(Modifier.height(34.dp))
            Surface(color = Color(0xFFE8F2ED), shape = RoundedCornerShape(20.dp)) {
                Row(Modifier.padding(horizontal = 34.dp, vertical = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("▥", color = Forest, fontSize = 34.sp)
                    Spacer(Modifier.width(16.dp))
                    Text("バーコードリーダーに会員証をかざしてください", color = Forest, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
            }
            ScannerCapture(minLength = 8, onScan = onScan)
            Spacer(Modifier.height(24.dp))
            TextButton(onClick = { onScan("650A0DB2F6") }) { Text("動作確認用に進む", color = Muted) }
        }
    }
}

@Composable
private fun ScannerCapture(minLength: Int, onScan: (String) -> Unit) {
    AndroidView(
        modifier = Modifier.size(1.dp),
        factory = { context ->
            EditText(context).apply {
                showSoftInputOnFocus = false
                isSingleLine = true
                // 日本語IMEの変換・予測を通さず、バーコードリーダーから届く
                // 英数字をそのまま受け取る。
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                isFocusable = true
                isFocusableInTouchMode = true
                alpha = 0f
                val handler = Handler(Looper.getMainLooper())
                var pending: Runnable? = null
                doAfterTextChanged { value ->
                    pending?.let(handler::removeCallbacks)
                    val code = value?.toString()?.trim().orEmpty()
                    if (code.length >= minLength) {
                        pending = Runnable {
                            val completed = Normalizer.normalize(
                                text?.toString()?.trim().orEmpty(),
                                Normalizer.Form.NFKC,
                            ).uppercase()
                            if (completed.length >= minLength) {
                                setText("")
                                onScan(completed)
                            }
                        // Bluetooth/USBリーダーが一時停止しても途中の文字列を送らないよう、
                        // 一連のキー入力が700ms止まるまで待つ。
                        }.also { handler.postDelayed(it, 700) }
                    }
                }
                // 画面内のボタンやロゴを触った後も、バーコードリーダーの
                // キー入力先を自動でこの欄へ戻す。純正キーボードは表示しない。
                setOnFocusChangeListener { view, hasFocus ->
                    if (!hasFocus) view.post { view.requestFocus() }
                }
                post { requestFocus() }
                val focusKeeper = object : Runnable {
                    override fun run() {
                        if (!isAttachedToWindow) return
                        if (!hasFocus()) requestFocus()
                        postDelayed(this, 250)
                    }
                }
                post(focusKeeper)
            }
        },
        update = { field ->
            if (!field.hasFocus()) field.post { field.requestFocus() }
        },
    )
}

@Composable
private fun VerifyingMemberScreen() {
    LoadingPanel("会員情報を確認しています", "確認でき次第、自動で次へ進みます")
}

@Composable
private fun ServiceScreen(onSelect: (ServiceType) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Text("ご利用先を選んでください", color = Ink, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text("カード全体をタップすると、すぐに次へ進みます", color = Muted, fontSize = 16.sp)
        Spacer(Modifier.height(22.dp))
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            ServiceCard(Modifier.weight(1f), "買", "おもひで商店", "商品のバーコードを読み取って\nセルフレジでお会計", Color(0xFFE6F1EA)) { onSelect(ServiceType.SHOP) }
            ServiceCard(Modifier.weight(1f), "食", "Aozora kitchen", "お食事・ドリンクを選んで\nその場でご注文", Color(0xFFFFF0D5)) { onSelect(ServiceType.AOZORA_KITCHEN) }
            ServiceCard(Modifier.weight(1f), "時", "FEBBRAIO・\nアートリエ", "施設のご利用時間を確認して\nチェックアウト", Color(0xFFE9E5F4)) { onSelect(ServiceType.FEBBRAIO) }
        }
    }
}

@Composable
private fun ServiceCard(modifier: Modifier, icon: String, title: String, description: String, tint: Color, onClick: () -> Unit) {
    Surface(
        modifier.fillMaxHeight().clickable(onClick = onClick),
        shape = RoundedCornerShape(22.dp),
        color = tint,
        border = androidx.compose.foundation.BorderStroke(2.dp, Color.White),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Box(Modifier.size(58.dp).background(Forest, RoundedCornerShape(18.dp)), contentAlignment = Alignment.Center) {
                Text(icon, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            }
            Column {
                Text(title, color = Ink, fontSize = 25.sp, lineHeight = 29.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(9.dp))
                Text(description, color = Muted, fontSize = 14.sp, lineHeight = 21.sp)
            }
            Text("こちらを選ぶ  →", color = Forest, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ProductScreen(service: ServiceType?, catalog: List<CatalogProduct>, initialCart: List<CartItem>, onConfirm: (List<CartItem>) -> Unit) {
    if (service == ServiceType.AOZORA_KITCHEN) {
        val synced = catalog.filter { it.section == "kitchen" && !isPackagedRetailKitchenItem(it) }.map { product ->
            KitchenMenuItem(
                code = product.code,
                name = product.name,
                price = product.price,
                priceExcludingTax = taxExcludedPrice(product),
                category = when {
                    product.name.contains("かき氷") -> "dessert"
                    else -> canonicalAlcoholCategory(product.name, product.menuCategory)
                },
                // 商品コードに紐づくスマレジ・モバイルオーダー画像だけを使用する。
                // 類似商品名から端末内画像を推測すると誤表示になるため上書きしない。
                image = product.imageUrl,
                customizable = product.optionGroups.isNotBlank() || product.menuCategory.startsWith("food-") ||
                    product.menuCategory.endsWith("cocktail"),
                cocktailBase = product.cocktailBase.ifBlank { inferMocktailRecipe(product.name)?.first.orEmpty() },
                cocktailMixer = product.cocktailMixer.ifBlank { inferMocktailRecipe(product.name)?.second.orEmpty() },
                soldOut = product.soldOut,
                scheduleEnabled = product.scheduleEnabled,
                scheduleStart = product.scheduleStart,
                scheduleEnd = product.scheduleEnd,
                scheduleDays = product.scheduleDays,
            )
        }
        KitchenMenuScreen(onConfirm, if (synced.isNotEmpty()) synced else kitchenMenuItems)
        return
    }
    if (service == ServiceType.SHOP) {
        ShopScannerScreen(catalog.filter { it.section == "shop" }, initialCart, onConfirm)
        return
    }
    val items = when (service) {
        ServiceType.FEBBRAIO -> emptyList()
        else -> listOf(
            CartItem("4901625421798", "バーコード商品", 1, 498),
            CartItem("DEMO_NO_BARCODE", "バーコードのない商品", 1, 300),
        )
    }
    if (service == ServiceType.FEBBRAIO) {
        StudioConnectionPendingScreen()
        return
    }
    var selected by remember { mutableStateOf(items.first()) }
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text(if (service == ServiceType.FEBBRAIO) "ご利用内容を確認しました" else "商品を選んでください", color = Ink, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text(if (service == ServiceType.SHOP) "バーコード商品は続けてスキャンできます" else "商品をタップすると選択できます", color = Muted)
            }
            Spacer(Modifier.weight(1f))
            Surface(color = Color(0xFFE7F2EC), shape = RoundedCornerShape(18.dp)) {
                Text("選択中  1点", Modifier.padding(18.dp, 10.dp), color = Forest, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.height(18.dp))
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items.forEach { item ->
                val active = selected.productCode == item.productCode
                Surface(
                    Modifier.weight(1f).fillMaxHeight().clickable { selected = item },
                    shape = RoundedCornerShape(18.dp),
                    color = if (active) Color(0xFFE5F2EB) else Color.White,
                    border = androidx.compose.foundation.BorderStroke(if (active) 3.dp else 1.dp, if (active) Forest else Color(0xFFDDD8CE)),
                ) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.SpaceBetween) {
                        Box(Modifier.fillMaxWidth().weight(1f).background(Color(0xFFF1EDE5), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                            if (item.imageUrl != null) {
                                AsyncImage(
                                    model = item.imageUrl,
                                    contentDescription = item.name,
                                    modifier = Modifier.fillMaxSize(),
                                    contentScale = ContentScale.Crop,
                                )
                            } else {
                                Text(if (service == ServiceType.FEBBRAIO) "◷" else "▥", fontSize = 36.sp)
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        Text(item.name, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        Text("税込 ¥${item.unitPriceIncludingTax}", color = Forest, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Button(onClick = { onConfirm(listOf(selected)) }, Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(18.dp)) {
            Text(if (service == ServiceType.FEBBRAIO) "利用内容を確認する" else "選択内容を確認する　税込 ¥${selected.unitPriceIncludingTax}", fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ShopScannerScreen(products: List<CatalogProduct>, initialCart: List<CartItem>, onConfirm: (List<CartItem>) -> Unit) {
    val productByCode = remember(products) {
        products.flatMap { product -> listOf(product.code, product.code.uppercase())
            .map { it to product } }.toMap()
    }
    val cart = remember { mutableStateMapOf<String, Int>() }
    var message by remember { mutableStateOf("商品のバーコードをスキャンしてください") }
    var showNoBarcode by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    LaunchedEffect(initialCart) {
        initialCart.forEach { cart[it.productCode] = it.quantity }
    }
    val selected = products.filter { (cart[it.code] ?: 0) > 0 }
    val count = cart.values.sum()
    val total = selected.sumOf { it.price * (cart[it.code] ?: 0) }
    fun add(product: CatalogProduct) { cart[product.code] = (cart[product.code] ?: 0) + 1 }
    fun remove(product: CatalogProduct) {
        val next = (cart[product.code] ?: 0) - 1
        if (next <= 0) cart.remove(product.code) else cart[product.code] = next
    }
    fun scan(code: String) {
        if (products.isEmpty()) { message = "商品マスタを同期しています。少しお待ちください。"; return }
        val product = productByCode[code] ?: productByCode[code.uppercase()]
        if (product == null) message = "商品を確認できませんでした。もう一度スキャンしてください。"
        else { add(product); message = "${product.name}を追加しました" }
    }

    Box(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Text("商品のバーコードをスキャン", color = Ink, fontSize = 29.sp, fontWeight = FontWeight.Bold)
                Text("読み取った商品だけが右の買い物かごに表示されます", color = Muted, fontSize = 15.sp)
                Spacer(Modifier.height(20.dp))
                Surface(Modifier.fillMaxWidth().weight(1f), color = Color(0xFFE8F2ED), shape = RoundedCornerShape(22.dp)) {
                    Column(Modifier.padding(26.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        Text("▥", color = Forest, fontSize = 58.sp)
                        Spacer(Modifier.height(14.dp))
                        Text(message, color = if (message.startsWith("商品を確認")) Color(0xFFB33A2E) else Ink,
                            fontSize = 19.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(20.dp))
                        OutlinedButton(onClick = { showNoBarcode = true }, Modifier.height(58.dp), shape = RoundedCornerShape(15.dp)) {
                            Text("バーコードがない商品はこちら", color = Forest, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                ScannerCapture(minLength = 4, onScan = ::scan)
            }
            Surface(Modifier.width(410.dp).fillMaxHeight(), shape = RoundedCornerShape(18.dp), color = Color.White,
                border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA))) {
                Column {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("スキャンした商品", color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.weight(1f)); Text("${count}点", color = Forest, fontWeight = FontWeight.Bold)
                    }
                    HorizontalDivider(color = Color(0xFFE5E0D7))
                    if (selected.isEmpty()) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Text("商品をスキャンすると\nここに表示されます", color = Muted, textAlign = TextAlign.Center)
                    } else LazyColumn(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                        items(selected, key = { it.code }) { product ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(product.name, color = Ink, fontWeight = FontWeight.Bold)
                                    val qty = cart[product.code] ?: 0
                                    Text("税抜 ¥${taxExcludedPrice(product) * qty}", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                                    Text("税込 ¥${product.price * qty}", color = Muted, fontSize = 11.sp)
                                }
                                SmallQuantityButton("−") { remove(product) }
                                Text("${cart[product.code] ?: 0}", Modifier.padding(horizontal = 10.dp), fontWeight = FontWeight.Bold)
                                SmallQuantityButton("＋") { add(product) }
                            }
                            HorizontalDivider(color = Color(0xFFEEEAE3))
                        }
                    }
                    Surface(color = Color(0xFFFAF7F0)) {
                        Column(Modifier.padding(16.dp)) {
                            val subtotal = selected.sumOf { taxExcludedPrice(it) * (cart[it.code] ?: 0) }
                            Row { Text("小計（税抜）", color = Muted); Spacer(Modifier.weight(1f)); Text("¥$subtotal", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Bold) }
                            Row { Text("税込合計", color = Muted); Spacer(Modifier.weight(1f)); Text("¥$total", color = Ink, fontSize = 25.sp, fontWeight = FontWeight.Bold) }
                            Spacer(Modifier.height(10.dp))
                            Button(onClick = { onConfirm(selected.map { CartItem(it.code, it.name, cart[it.code] ?: 0, it.price, it.imageUrl) }) },
                                enabled = count > 0, modifier = Modifier.fillMaxWidth().height(62.dp), shape = RoundedCornerShape(16.dp)) {
                                Text(if (count > 0) "お会計へ進む" else "商品をスキャンしてください", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
        if (showNoBarcode) {
            val candidates = products.filter { !it.barcode && (search.isBlank() || it.name.contains(search, true) || it.code.contains(search, true)) }
            Surface(Modifier.align(Alignment.Center).fillMaxWidth(.82f).fillMaxHeight(.84f), shape = RoundedCornerShape(24.dp), color = Paper, shadowElevation = 14.dp) {
                Column(Modifier.padding(20.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("バーコードがない商品", color = Ink, fontSize = 25.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.weight(1f)); TextButton(onClick = { showNoBarcode = false }) { Text("閉じる ✕") }
                    }
                    androidx.compose.material3.OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                        label = { Text("商品名で検索") })
                    Spacer(Modifier.height(12.dp))
                    LazyVerticalGrid(columns = GridCells.Fixed(3), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        gridItems(candidates, key = { it.code }) { product ->
                            Surface(Modifier.height(105.dp).clickable { add(product); showNoBarcode = false; message = "${product.name}を追加しました" },
                                shape = RoundedCornerShape(14.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA))) {
                                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
                                    Text(product.name, color = Ink, fontWeight = FontWeight.Bold, maxLines = 2)
                                    Text("税抜 ¥${taxExcludedPrice(product)}", color = Ink, fontWeight = FontWeight.Bold)
                                    Text("税込 ¥${product.price}", color = Muted, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun productImage(fileName: String): String =
    "file:///android_asset/products/$fileName"

private fun taxExcludedPrice(product: CatalogProduct): Int = when (product.taxDivision) {
    "1", "2" -> product.basePrice
    else -> ceil(product.price * 100.0 / (100.0 + product.taxRate)).toInt()
}

@Composable
private fun StudioConnectionPendingScreen() {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("スタジオ精算を準備しています", color = Ink, fontSize = 31.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text("誤った料金で進まないよう、受付システムとの接続完了まで精算を停止しています。", color = Muted, fontSize = 17.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        Surface(color = Color(0xFFFFF0D8), shape = RoundedCornerShape(16.dp)) {
            Text("上部の「前の画面へ戻る」から、ご利用先を選び直せます。", Modifier.padding(horizontal = 24.dp, vertical = 14.dp), color = Color(0xFF8A5B13), fontWeight = FontWeight.Bold)
        }
    }
}

private fun isPackagedRetailKitchenItem(product: CatalogProduct): Boolean =
    product.code.matches(Regex("^[0-9]{8,14}$")) &&
        Regex("赤いきつね|緑のたぬき|カップヌードル|カップ麺|即席麺").containsMatchIn(product.name)

private fun inferMocktailRecipe(productName: String): Pair<String, String>? {
    if (!productName.contains("モクテル") && !productName.contains("ノンアル")) return null
    val name = productName.replace("　", "").replace(" ", "")
    val base = when {
        name.contains("カシス") -> "カシス"
        name.contains("ストロベリー") -> "ストロベリー"
        name.contains("ピーチ") || name.contains("ファジーネーブル") || name.contains("レゲエパンチ") -> "ピーチ"
        name.contains("梅酒風") -> "梅酒風"
        else -> return null
    }
    val mixer = when {
        name.contains("ラムネ") -> "ラムネ"
        name.contains("カルピス") -> "カルピス"
        name.contains("ミルク") -> "ミルク"
        name.contains("オレンジ") || name.contains("ファジーネーブル") -> "オレンジ"
        name.contains("ウーロン") || name.contains("レゲエパンチ") -> "ウーロン茶"
        name.contains("グリーンティー") || name.contains("緑茶") -> "緑茶"
        name.contains("コーラ") -> "コーラ"
        name.contains("水割り") -> "水"
        name.contains("ソーダ") -> "ソーダ"
        name.contains("ロック") -> "ロック"
        else -> return null
    }
    return base to mixer
}

private fun canonicalAlcoholCategory(productName: String, currentCategory: String): String {
    val name = productName.replace("　", "").replace(" ", "")
    if (name.contains("ノンアル") || name.contains("モクテル")) return currentCategory
    if (name.contains("カルーア")) return "alcohol-cocktail"
    if (name.contains("瓶ビール") || name.contains("角ハイボール")) return "alcohol-main"
    val traditionalBase = Regex("芋焼酎|麦焼酎|泡盛|^梅酒").containsMatchIn(name)
    val simpleServe = Regex("ロック|水割り|ソーダ割り").containsMatchIn(name)
    return if (traditionalBase && simpleServe) "alcohol-main" else currentCategory
}

private data class KitchenMenuItem(
    val code: String,
    val name: String,
    val price: Int,
    val category: String,
    val image: String? = null,
    val customizable: Boolean = false,
    val cocktailBase: String = "",
    val cocktailMixer: String = "",
    val priceExcludingTax: Int = price,
    val soldOut: Boolean = false,
    val scheduleEnabled: Boolean = true,
    val scheduleStart: String = "00:00",
    val scheduleEnd: String = "23:59",
    val scheduleDays: Set<Int> = (1..7).toSet(),
)

private fun KitchenMenuItem.isAvailableAt(now: LocalDateTime): Boolean {
    if (!scheduleEnabled) return false
    val start = runCatching { LocalTime.parse(scheduleStart) }.getOrDefault(LocalTime.MIN)
    val end = runCatching { LocalTime.parse(scheduleEnd) }.getOrDefault(LocalTime.of(23, 59))
    val time = now.toLocalTime()
    val today = now.dayOfWeek.value
    if (start <= end) return today in scheduleDays && !time.isBefore(start) && !time.isAfter(end)
    if (!time.isBefore(start)) return today in scheduleDays
    val previousDay = if (today == DayOfWeek.MONDAY.value) DayOfWeek.SUNDAY.value else today - 1
    return !time.isAfter(end) && previousDay in scheduleDays
}

private val kitchenMenuItems = listOf(
    KitchenMenuItem("tsukemen", "濃厚魚介つけ麺", 900, "food-tsukemen", productImage("product_image_1777539105_860198633.jpg"), true),
    KitchenMenuItem("kitsune_udon", "きつねうどん", 650, "food-udon", productImage("product_image_1783832528_8625086.jpg"), true),
    KitchenMenuItem("kake_udon", "かけうどん", 550, "food-udon", productImage("product_image_1783832857_763744818.jpg"), true),
    KitchenMenuItem("houtou", "ほうとう", 900, "food-udon", productImage("product_image_1777790021_1024900588.jpg"), true),
    KitchenMenuItem("bolognese", "ボロネーゼパスタ", 850, "food-pasta", productImage("product_image_1784300708_1605368157.jpg"), true),
    KitchenMenuItem("carbonara", "カルボナーラパスタ", 850, "food-pasta", productImage("product_image_1783832848_491620697.jpg"), true),
    KitchenMenuItem("kakuni_don", "角煮丼", 880, "food-don", productImage("product_image_1777539010_1442682524.jpg"), true),
    KitchenMenuItem("katsu_don", "カツ丼", 850, "food-don", productImage("product_image_1777538995_1144950376.jpg"), true),
    KitchenMenuItem("wafu_karaage_don", "和風からあげ丼", 780, "food-don", productImage("product_image_1777537949_38733724.jpg"), true),
    KitchenMenuItem("garlic_karaage_don", "にんにくからあげ丼", 780, "food-don", productImage("product_image_1777537963_985687319.jpg"), true),
    KitchenMenuItem("mixed_karaage_don", "あいもりからあげ丼", 850, "food-don", productImage("product_image_1777537978_1559150914.jpg"), true),
    KitchenMenuItem("cheese_dog", "チーズドッグ", 550, "food-side", productImage("product_image_1777537807_830015385.jpg")),
    KitchenMenuItem("karaage", "和風からあげ", 500, "food-side", productImage("product_image_1777537125_530876683.jpg")),
    KitchenMenuItem("potato", "ふりふりポテト", 400, "food-side", productImage("product_image_1777537291_807228877.jpg")),
    KitchenMenuItem("coffee", "ブレンドコーヒー", 400, "soft-cafe"),
    KitchenMenuItem("iced_coffee", "アイスコーヒー", 400, "soft-cafe"),
    KitchenMenuItem("cafe_latte", "カフェラテ", 450, "soft-cafe"),
    KitchenMenuItem("cocoa", "ココア", 450, "soft-cafe"),
    KitchenMenuItem("strawberry_milk", "いちごミルク", 500, "soft-cafe"),
    KitchenMenuItem("milk_tea", "ミルクティー", 450, "soft-cafe"),
    KitchenMenuItem("orange", "オレンジジュース", 350, "soft-simple"),
    KitchenMenuItem("apple", "アップルジュース", 350, "soft-simple"),
    KitchenMenuItem("cola", "コーラ", 350, "soft-simple"),
    KitchenMenuItem("ginger_ale", "ジンジャーエール", 350, "soft-simple"),
    KitchenMenuItem("ramune", "ラムネ", 350, "soft-simple"),
    KitchenMenuItem("calpis", "カルピス", 350, "soft-simple"),
    KitchenMenuItem("oolong", "ウーロン茶", 300, "soft-simple"),
    KitchenMenuItem("green_tea", "緑茶", 300, "soft-simple"),
    KitchenMenuItem("mocktail_peach", "ピーチモクテル", 650, "soft-mocktail", customizable = true),
    KitchenMenuItem("mocktail_cassis", "カシスモクテル", 650, "soft-mocktail", customizable = true),
    KitchenMenuItem("mocktail_lemon", "レモンモクテル", 650, "soft-mocktail", customizable = true),
    KitchenMenuItem("mocktail_strawberry", "ストロベリーモクテル", 650, "soft-mocktail", customizable = true),
    KitchenMenuItem("beer", "ビール", 650, "alcohol-main"),
    KitchenMenuItem("highball", "ハイボール", 600, "alcohol-main"),
    KitchenMenuItem("imo_shochu", "芋焼酎", 600, "alcohol-main"),
    KitchenMenuItem("mugi_shochu", "麦焼酎", 600, "alcohol-main"),
    KitchenMenuItem("awamori", "泡盛", 600, "alcohol-main"),
    KitchenMenuItem("umeshu", "梅酒", 600, "alcohol-main"),
    KitchenMenuItem("reggae_punch", "レゲエパンチ", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("cassis_orange", "カシスオレンジ", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("fuzzy_navel", "ファジーネーブル", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("moscow_mule", "モスコミュール", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("peach_oolong", "ピーチウーロン", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("cassis_soda", "カシスソーダ", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("kahlua_milk", "カルーアミルク", 700, "alcohol-cocktail", customizable = true),
    KitchenMenuItem("shaved_ice", "ふわふわかき氷", 500, "dessert"),
    KitchenMenuItem("coffee_jelly", "コーヒーゼリー", 450, "dessert"),
)

@Composable
private fun KitchenMenuScreen(onConfirm: (List<CartItem>) -> Unit, menuItems: List<KitchenMenuItem>) {
    val mainTabs = listOf(
        "food-tsukemen" to "つけ麺", "food-udon" to "うどん・ほうとう", "food-pasta" to "パスタ",
        "food-don" to "ご飯もの", "food-side" to "サイドメニュー", "drink" to "ドリンク", "dessert" to "デザート",
    )
    var category by remember { mutableStateOf("food-udon") }
    var drinkGroup by remember { mutableStateOf("") }
    var drinkCategory by remember { mutableStateOf("") }
    var cocktailBuilder by remember { mutableStateOf(false) }
    var cocktailBase by remember { mutableStateOf("") }
    var cafeSelection by remember { mutableStateOf("") }
    val cart = remember { mutableStateMapOf<String, Int>() }
    val customizations = remember { mutableStateMapOf<String, Map<String, String>>() }
    var customizing by remember { mutableStateOf<KitchenMenuItem?>(null) }
    var currentTime by remember { mutableStateOf(LocalDateTime.now(ZoneId.of("Asia/Tokyo"))) }
    LaunchedEffect(Unit) { while (true) { currentTime = LocalDateTime.now(ZoneId.of("Asia/Tokyo")); delay(30_000) } }

    val visibleCategory = if (category != "drink") category else drinkCategory
    val visibleItems = menuItems.filter { it.category == visibleCategory }
    val categoryOpen = visibleItems.firstOrNull()?.isAvailableAt(currentTime) ?: true
    val cartItems = menuItems.filter { (cart[it.code] ?: 0) > 0 }
    val count = cart.values.sum()
    val total = cartItems.sumOf { it.price * (cart[it.code] ?: 0) }
    fun change(item: KitchenMenuItem, delta: Int) {
        if (delta > 0 && (item.soldOut || !item.isAvailableAt(currentTime))) return
        val next = ((cart[item.code] ?: 0) + delta).coerceAtLeast(0)
        if (next == 0) {
            cart.remove(item.code)
            customizations.remove(item.code)
        } else cart[item.code] = next
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            mainTabs.forEach { (key, label) ->
                val active = category == key
                Surface(
                    Modifier.weight(1f).height(46.dp).clickable {
                        category = key
                        if (key == "drink") { drinkGroup = ""; drinkCategory = ""; cocktailBuilder = false; cocktailBase = ""; cafeSelection = "" }
                    },
                    shape = RoundedCornerShape(12.dp),
                    color = if (active) Color(0xFFDCECE3) else Color.White,
                    border = androidx.compose.foundation.BorderStroke(if (active) 2.dp else 1.dp, if (active) Forest else Color(0xFFD8D3C9)),
                ) { Box(contentAlignment = Alignment.Center) { Text(label, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center) } }
            }
        }
        if (category == "drink" && drinkGroup.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(top = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { drinkGroup = ""; drinkCategory = "" }) { Text("← ドリンク種別へ") }
                Text(if (drinkGroup == "soft") "ソフトドリンク" else "アルコールドリンク", color = Ink, fontWeight = FontWeight.Bold)
                if (drinkCategory.isNotEmpty()) {
                    Text("  ›  ", color = Muted)
                    TextButton(onClick = { drinkCategory = "" }) { Text("ジャンルを選び直す") }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        if (visibleCategory.isNotEmpty() && !categoryOpen) {
            val sample = visibleItems.firstOrNull()
            Surface(Modifier.fillMaxWidth().padding(bottom = 8.dp), shape = RoundedCornerShape(14.dp), color = Color(0xFFFFF0D8)) {
                Column(Modifier.padding(14.dp)) {
                    Text("現在は販売時間外です", color = Ink, fontWeight = FontWeight.Bold)
                    if (sample != null) Text("販売時間 ${sample.scheduleStart}〜${sample.scheduleEnd}　時間内にもう一度お選びください。", color = Muted, fontSize = 12.sp)
                }
            }
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                category == "drink" && drinkGroup.isEmpty() -> DrinkChoicePanel(
                    Modifier.weight(1f),
                    choices = listOf("soft" to ("ソフトドリンク" to "カフェ・ジュース・モクテル"), "alcohol" to ("アルコールドリンク" to "ビール・焼酎・カクテル")),
                    onSelect = { drinkGroup = it },
                )
                category == "drink" && drinkCategory.isEmpty() -> DrinkChoicePanel(
                    Modifier.weight(1f),
                    choices = if (drinkGroup == "soft") listOf(
                        "soft-cafe" to ("カフェメニュー" to "コーヒー・ココア・ミルクティー"),
                        "soft-simple" to ("ジュース・炭酸・お茶" to "定番のソフトドリンク"),
                        "soft-mocktail" to ("モクテル" to "ノンアルコールカクテル"),
                    ) else listOf(
                        "alcohol-main" to ("ビール・焼酎など" to "定番のお酒から選ぶ"),
                        "alcohol-cocktail" to ("カクテル" to "完成品名や組み合わせから選ぶ"),
                    ),
                    onSelect = { drinkCategory = it },
                )
                category == "drink" && drinkCategory in setOf("alcohol-cocktail", "soft-mocktail") && cocktailBuilder -> CocktailBuilderPanel(
                    modifier = Modifier.weight(1f),
                    items = visibleItems,
                    isMocktail = drinkCategory == "soft-mocktail",
                    selectedBase = cocktailBase,
                    onBase = { cocktailBase = it },
                    onAdd = { change(it, 1); cocktailBuilder = false; cocktailBase = "" },
                    onBack = { if (cocktailBase.isNotEmpty()) cocktailBase = "" else cocktailBuilder = false },
                )
                category == "drink" && drinkCategory == "soft-cafe" -> CafeMenuPanel(
                    modifier = Modifier.weight(1f),
                    items = visibleItems,
                    selectedDrink = cafeSelection,
                    onSelectDrink = { cafeSelection = it },
                    onAdd = { change(it, 1); cafeSelection = "" },
                    onBack = { cafeSelection = "" },
                )
                category == "drink" -> Column(Modifier.weight(1f).fillMaxHeight()) {
                    if (drinkCategory in setOf("alcohol-cocktail", "soft-mocktail")) {
                        val mocktail = drinkCategory == "soft-mocktail"
                        Surface(
                            Modifier.fillMaxWidth().height(70.dp).clickable { cocktailBuilder = true },
                            shape = RoundedCornerShape(17.dp), color = if (mocktail) Color(0xFFFFF0D8) else Color(0xFFE5EFEA),
                            border = androidx.compose.foundation.BorderStroke(2.dp, if (mocktail) Gold else Forest),
                            shadowElevation = 2.dp,
                        ) {
                            Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(if (mocktail) "◇" else "♢", color = if (mocktail) Color(0xFF9A6414) else Forest, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                                Spacer(Modifier.width(15.dp))
                                Column {
                                    Text(if (mocktail) "割材からモクテルを選ぶ" else "割材からカクテルを選ぶ", color = Ink, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                                    Text("ベースを選び、次に割材を選択します", color = Muted, fontSize = 12.sp)
                                }
                                Spacer(Modifier.weight(1f))
                                Text("組み合わせて選ぶ  →", color = if (mocktail) Color(0xFF9A6414) else Forest, fontWeight = FontWeight.Bold)
                            }
                        }
                        Spacer(Modifier.height(9.dp))
                    }
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(3), modifier = Modifier.weight(1f).fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(9.dp), verticalArrangement = Arrangement.spacedBy(9.dp),
                        contentPadding = PaddingValues(bottom = 8.dp),
                    ) {
                        gridItems(visibleItems, key = { it.code }) { item ->
                            DrinkNameCard(item, cart[item.code] ?: 0, onAdd = { change(item, 1) }, onRemove = { change(item, -1) })
                        }
                    }
                }
                else -> LazyVerticalGrid(
                    columns = GridCells.Fixed(3), modifier = Modifier.weight(1f).fillMaxHeight(),
                    horizontalArrangement = Arrangement.spacedBy(9.dp), verticalArrangement = Arrangement.spacedBy(9.dp),
                    contentPadding = PaddingValues(bottom = 8.dp),
                ) {
                    gridItems(visibleItems, key = { it.code }) { item ->
                        KitchenProductCard(item, cart[item.code] ?: 0, onAdd = { change(item, 1) }, onRemove = { change(item, -1) })
                    }
                }
            }
            KitchenCart(
                modifier = Modifier.width(282.dp).fillMaxHeight(),
                items = cartItems,
                quantities = cart,
                customizations = customizations,
                onAdd = { change(it, 1) },
                onRemove = { change(it, -1) },
                onCustomize = { customizing = it },
            )
        }
        Row(Modifier.fillMaxWidth().height(58.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("選択 $count 品", color = Muted, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text("税込合計  ¥$total", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(16.dp))
            Button(
                onClick = {
                    onConfirm(cartItems.map { item ->
                        CartItem(item.code, item.name, cart[item.code] ?: 0, item.price, item.image, customizations[item.code].orEmpty())
                    })
                },
                enabled = count > 0,
                modifier = Modifier.width(280.dp).fillMaxHeight(),
                shape = RoundedCornerShape(16.dp),
            ) { Text(if (count > 0) "注文内容を確認する" else "商品を選んでください", fontWeight = FontWeight.Bold) }
        }
    }

    customizing?.let { item ->
        KitchenCustomizeDialog(
            item = item,
            initial = customizations[item.code].orEmpty(),
            onDismiss = { customizing = null },
            onSave = { customizations[item.code] = it; customizing = null },
        )
    }
}

private fun cafeDrinkName(name: String): String = name
    .replace("特製", "")
    .replace("(ホット)", "")
    .replace("（ホット）", "")
    .replace("(アイス)", "")
    .replace("（アイス）", "")
    .replace(Regex("^(ホット|アイス)"), "")
    .trim()

private fun cafeTemperature(name: String): String? = when {
    name.contains("ホット") -> "ホット"
    name.contains("アイス") -> "アイス"
    else -> null
}

@Composable
private fun CafeMenuPanel(
    modifier: Modifier,
    items: List<KitchenMenuItem>,
    selectedDrink: String,
    onSelectDrink: (String) -> Unit,
    onAdd: (KitchenMenuItem) -> Unit,
    onBack: () -> Unit,
) {
    val groups = items.groupBy { cafeDrinkName(it.name) }.toSortedMap()
    val choices = groups[selectedDrink].orEmpty().sortedBy { if (cafeTemperature(it.name) == "ホット") 0 else 1 }
    Column(modifier.fillMaxHeight()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (selectedDrink.isNotEmpty()) {
                OutlinedButton(onClick = onBack, shape = RoundedCornerShape(13.dp)) { Text("← 飲み物を選び直す") }
                Spacer(Modifier.width(12.dp))
            }
            Column {
                Text(if (selectedDrink.isEmpty()) "カフェメニューを選んでください" else "$selectedDrink はどちらにしますか？", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold)
                Text(if (selectedDrink.isEmpty()) "ホット／アイスは商品の選択後にお選びいただけます" else "温度を選ぶと注文内容へ追加されます", color = Muted, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        LazyVerticalGrid(columns = GridCells.Fixed(if (selectedDrink.isEmpty()) 3 else 2), modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (selectedDrink.isEmpty()) {
                gridItems(groups.entries.toList(), key = { it.key }) { entry ->
                    val hasTemperatureChoice = entry.value.mapNotNull { cafeTemperature(it.name) }.distinct().size > 1
                    val first = entry.value.first()
                    val selectable = entry.value.any { !it.soldOut && it.isAvailableAt(LocalDateTime.now(ZoneId.of("Asia/Tokyo"))) }
                    Surface(
                        Modifier.height(126.dp).clickable(enabled = selectable) { if (hasTemperatureChoice) onSelectDrink(entry.key) else onAdd(first) },
                        shape = RoundedCornerShape(17.dp), color = Color.White,
                        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA)), shadowElevation = 1.dp,
                    ) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.SpaceBetween) {
                            Text(entry.key, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                            if (!selectable) Text(if (entry.value.all { it.soldOut }) "品切れ中　大人気すぎてすみません。" else "販売時間外", color = Color(0xFFA43D30), fontSize = 10.sp)
                            if (hasTemperatureChoice) Text("ホット／アイスを選ぶ  →", color = Forest, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            else {
                                Text("税抜 ¥${first.priceExcludingTax}", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                Text("税込 ¥${first.price}", color = Muted, fontSize = 10.sp)
                            }
                        }
                    }
                }
            } else {
                gridItems(choices, key = { it.code }) { item ->
                    val temperature = cafeTemperature(item.name) ?: item.name
                    val selectable = !item.soldOut && item.isAvailableAt(LocalDateTime.now(ZoneId.of("Asia/Tokyo")))
                    Surface(
                        Modifier.height(170.dp).clickable(enabled = selectable) { onAdd(item) }, shape = RoundedCornerShape(20.dp),
                        color = if (temperature == "ホット") Color(0xFFFFE8D7) else Color(0xFFE1F1F7),
                        border = androidx.compose.foundation.BorderStroke(2.dp, if (temperature == "ホット") Color(0xFFC76B32) else Color(0xFF397D98)),
                    ) {
                        Column(Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                            Text(if (temperature == "ホット") "HOT" else "ICE", color = if (temperature == "ホット") Color(0xFFC05B26) else Color(0xFF26708E), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.height(8.dp))
                            Text(temperature, color = Ink, fontSize = 27.sp, fontWeight = FontWeight.Bold)
                            if (!selectable) Text(if (item.soldOut) "品切れ中\n大人気すぎてすみません。" else "販売時間外", color = Color(0xFFA43D30), fontSize = 11.sp, textAlign = TextAlign.Center)
                            Spacer(Modifier.height(10.dp))
                            Text("税抜 ¥${item.priceExcludingTax}　税込 ¥${item.price}", color = Muted, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CocktailBuilderPanel(
    modifier: Modifier,
    items: List<KitchenMenuItem>,
    isMocktail: Boolean,
    selectedBase: String,
    onBase: (String) -> Unit,
    onAdd: (KitchenMenuItem) -> Unit,
    onBack: () -> Unit,
) {
    val recipes = items.filter { it.cocktailBase.isNotBlank() && it.cocktailMixer.isNotBlank() }
    val bases = recipes.map { it.cocktailBase }.distinct().sorted()
    val mixers = recipes.filter { it.cocktailBase == selectedBase }.groupBy { it.cocktailMixer }.toSortedMap()
    Column(modifier.fillMaxHeight()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onBack, shape = RoundedCornerShape(13.dp)) { Text("← 戻る") }
            Spacer(Modifier.width(12.dp))
            Column {
                Text(if (selectedBase.isEmpty()) (if (isMocktail) "モクテルのベースを選んでください" else "お酒のベースを選んでください") else "$selectedBase の割材を選んでください", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold)
                Text("選んだ組み合わせに対応する完成品コードをレジへ送ります", color = Muted, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(12.dp))
        LazyVerticalGrid(columns = GridCells.Fixed(3), modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (selectedBase.isEmpty()) {
                gridItems(bases, key = { it }) { base ->
                    Surface(Modifier.height(92.dp).clickable { onBase(base) }, shape = RoundedCornerShape(15.dp), color = Color.White,
                        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA))) {
                        Box(Modifier.padding(12.dp), contentAlignment = Alignment.Center) { Text(base, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center) }
                    }
                }
            } else {
                gridItems(mixers.entries.toList(), key = { it.key }) { entry ->
                    val product = entry.value.first()
                    Surface(Modifier.height(104.dp).clickable { onAdd(product) }, shape = RoundedCornerShape(15.dp), color = Color.White,
                        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA))) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
                            Text(entry.key, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                            Text(product.name, color = Ink, fontSize = 12.sp, maxLines = 1)
                            Text("税抜 ¥${product.priceExcludingTax} ／ 税込 ¥${product.price}", color = Forest, fontSize = 11.sp, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun KitchenProductCard(item: KitchenMenuItem, quantity: Int, onAdd: () -> Unit, onRemove: () -> Unit) {
    val selectable = !item.soldOut && item.isAvailableAt(LocalDateTime.now(ZoneId.of("Asia/Tokyo")))
    Surface(
        Modifier.clickable(enabled = selectable, onClick = onAdd),
        shape = RoundedCornerShape(16.dp),
        color = if (quantity > 0) Color(0xFFE5F2EB) else Color.White,
        border = androidx.compose.foundation.BorderStroke(if (quantity > 0) 2.dp else 1.dp, if (quantity > 0) Forest else Color(0xFFD9D4CA)),
    ) {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(1f).background(Color(0xFFF0ECE4)), contentAlignment = Alignment.Center) {
                if (item.image != null) AsyncImage(item.image, item.name, Modifier.fillMaxSize().padding(4.dp), contentScale = ContentScale.Fit)
                else Text(if (item.category.startsWith("alcohol")) "🍸" else "🥤", fontSize = 34.sp)
                if (quantity > 0) Surface(Modifier.align(Alignment.TopEnd).padding(7.dp), shape = RoundedCornerShape(20.dp), color = Forest) {
                    Text("${quantity}点", Modifier.padding(horizontal = 9.dp, vertical = 4.dp), color = Color.White, fontWeight = FontWeight.Bold)
                }
                if (!selectable) Surface(Modifier.matchParentSize(), color = Color(0xCCFFFDF8)) {
                    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (item.soldOut) "品切れ中" else "販売時間外", color = Color(0xFFA43D30), fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        if (item.soldOut) Text("想定以上に売れちゃいました。\n大人気すぎてすみません。", color = Ink, fontSize = 11.sp, textAlign = TextAlign.Center)
                    }
                }
            }
            Column(Modifier.padding(10.dp)) {
                Text(item.name, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column {
                        Text("税抜 ¥${item.priceExcludingTax}", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Text("税込 ¥${item.price}", color = Muted, fontSize = 10.sp)
                    }
                    Spacer(Modifier.weight(1f))
                    if (quantity > 0) SmallQuantityButton("−", onRemove)
                    Spacer(Modifier.width(4.dp))
                    SmallQuantityButton("＋", onAdd)
                }
            }
        }
    }
}

@Composable
private fun DrinkChoicePanel(modifier: Modifier, choices: List<Pair<String, Pair<String, String>>>, onSelect: (String) -> Unit) {
    Row(modifier.fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        choices.forEach { (key, copy) ->
            Surface(
                Modifier.weight(1f).fillMaxHeight().clickable { onSelect(key) },
                shape = RoundedCornerShape(20.dp), color = if (key == "soft") Color(0xFFE6F2EE) else Color(0xFFEDE6F5),
                border = androidx.compose.foundation.BorderStroke(1.dp, Color.White), shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (key.startsWith("soft")) "🥤" else if (key.startsWith("alcohol")) "🍸" else "☕", fontSize = 42.sp)
                    Spacer(Modifier.height(14.dp))
                    Text(copy.first, color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(7.dp))
                    Text(copy.second, color = Muted, fontSize = 14.sp, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(18.dp))
                    Text("こちらを選ぶ  →", color = Forest, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun DrinkNameCard(item: KitchenMenuItem, quantity: Int, onAdd: () -> Unit, onRemove: () -> Unit) {
    val selectable = !item.soldOut && item.isAvailableAt(LocalDateTime.now(ZoneId.of("Asia/Tokyo")))
    Surface(
        Modifier.height(112.dp).clickable(enabled = selectable, onClick = onAdd), shape = RoundedCornerShape(15.dp),
        color = if (quantity > 0) Color(0xFFE5F2EB) else Color.White,
        border = androidx.compose.foundation.BorderStroke(if (quantity > 0) 2.dp else 1.dp, if (quantity > 0) Forest else Color(0xFFD9D4CA)),
    ) {
        Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Text(item.name, color = if (selectable) Ink else Muted, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 2)
            if (!selectable) Text(if (item.soldOut) "品切れ中　想定以上に売れちゃいました。大人気すぎてすみません。" else "販売時間外 ${item.scheduleStart}〜${item.scheduleEnd}", color = Color(0xFFA43D30), fontSize = 10.sp, maxLines = 2)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("税抜 ¥${item.priceExcludingTax}", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Text("税込 ¥${item.price}", color = Muted, fontSize = 10.sp)
                }
                Spacer(Modifier.weight(1f))
                if (quantity > 0) { SmallQuantityButton("−", onRemove); Text("$quantity", Modifier.padding(horizontal = 5.dp), fontWeight = FontWeight.Bold) }
                SmallQuantityButton("＋", onAdd)
            }
        }
    }
}

@Composable
private fun SmallQuantityButton(label: String, onClick: () -> Unit) {
    Surface(Modifier.size(30.dp).clickable(onClick = onClick), shape = RoundedCornerShape(9.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD3CEC4))) {
        Box(contentAlignment = Alignment.Center) { Text(label, color = Forest, fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun KitchenCart(
    modifier: Modifier,
    items: List<KitchenMenuItem>,
    quantities: Map<String, Int>,
    customizations: Map<String, Map<String, String>>,
    onAdd: (KitchenMenuItem) -> Unit,
    onRemove: (KitchenMenuItem) -> Unit,
    onCustomize: (KitchenMenuItem) -> Unit,
) {
    Surface(modifier, shape = RoundedCornerShape(16.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8D3CA))) {
        Column {
            Text("選択した商品", Modifier.padding(14.dp), color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            HorizontalDivider(color = Color(0xFFE5E0D7))
            if (items.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("商品を選ぶと\nここに表示されます", color = Muted, textAlign = TextAlign.Center) }
            else LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                items(items, key = { it.code }) { item ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Row {
                            Column(Modifier.weight(1f)) {
                                Text(item.name, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                                val qty = quantities[item.code] ?: 0
                                Text("税抜 ¥${item.priceExcludingTax * qty}", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                Text("税込 ¥${item.price * qty}", color = Muted, fontSize = 10.sp)
                                customizations[item.code]?.takeIf { it.isNotEmpty() }?.let { values ->
                                    Text(values.values.joinToString("・"), color = Color(0xFF654580), fontSize = 11.sp)
                                }
                            }
                            SmallQuantityButton("−") { onRemove(item) }
                            Text("${quantities[item.code] ?: 0}", Modifier.padding(horizontal = 7.dp, vertical = 5.dp), fontWeight = FontWeight.Bold)
                            SmallQuantityButton("＋") { onAdd(item) }
                        }
                        if (item.customizable) TextButton(onClick = { onCustomize(item) }, contentPadding = PaddingValues(0.dp)) { Text("カスタマイズ", fontSize = 12.sp) }
                        HorizontalDivider(color = Color(0xFFEEEAE3))
                    }
                }
            }
        }
    }
}

@Composable
private fun KitchenCustomizeDialog(item: KitchenMenuItem, initial: Map<String, String>, onDismiss: () -> Unit, onSave: (Map<String, String>) -> Unit) {
    val values = remember(item.code) { mutableStateMapOf<String, String>().apply { putAll(initial) } }
    val groups = if (item.category.startsWith("food")) listOf("ご飯・麺の量" to listOf("少なめ", "普通", "大盛り"), "ねぎ" to listOf("なし", "普通", "多め"))
    else listOf("サイズ" to listOf("S", "M", "L"), "氷" to listOf("なし", "普通", "多め"))
    Box(Modifier.fillMaxSize().background(Color(0xAA102019)), contentAlignment = Alignment.Center) {
        Surface(
            Modifier.width(480.dp),
            shape = RoundedCornerShape(22.dp),
            color = Color(0xFFFAF7FF),
            shadowElevation = 12.dp,
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("${item.name}をカスタマイズ", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold)
                groups.forEach { (label, options) ->
                    Column {
                        Text(label, color = Ink, fontWeight = FontWeight.Bold)
                        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            options.forEach { option -> FilterChip(selected = values[label] == option, onClick = { values[label] = option }, label = { Text(option) }) }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("キャンセル") }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = { onSave(values.toMap()) }) { Text("この内容にする") }
                }
            }
        }
    }
}

@Composable
private fun ReviewScreen(state: CheckoutState, onConfirm: () -> Unit) {
    val count = state.cart.sumOf { it.quantity }
    val unit = if (state.service == ServiceType.AOZORA_KITCHEN) "品" else "点"
    val title = when (state.service) {
        ServiceType.AOZORA_KITCHEN -> "$count 品で ${state.totalIncludingTax}円でございます。"
        ServiceType.FEBBRAIO -> "本日は${state.cart.firstOrNull()?.customizations?.get("利用時間") ?: "—"}時間のご利用で ${state.totalIncludingTax}円でございます。"
        else -> "$count 点で ${state.totalIncludingTax}円でございます。"
    }
    val message = when (state.service) {
        ServiceType.AOZORA_KITCHEN -> "ご注文内容をお確かめの上、注文確定ボタンを押してください。"
        ServiceType.FEBBRAIO -> "ご利用内容をお確かめの上、チェックアウトボタンを押してください。"
        else -> "お買い忘れなどはございませんか？ お買い上げ点数をお確かめください。"
    }
    val button = when (state.service) {
        ServiceType.AOZORA_KITCHEN -> "注文を確定する"
        ServiceType.FEBBRAIO -> "チェックアウトする"
        else -> "確認して支払い方法へ"
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("ご注文内容の確認", color = Muted, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text(title, color = Ink, fontSize = 32.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(12.dp))
        Text(message, color = Muted, fontSize = 18.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        Surface(color = Color(0xFFE8F2ED), shape = RoundedCornerShape(16.dp)) {
            Text(if (state.productRegistrationComplete) "✓ レジへの商品登録準備ができました" else "レジへ商品情報を送信しています…", Modifier.padding(22.dp, 12.dp), color = Forest)
        }
        Spacer(Modifier.height(22.dp))
        Button(onClick = onConfirm, Modifier.width(520.dp).height(68.dp), enabled = state.productRegistrationComplete, shape = RoundedCornerShape(18.dp)) {
            Text(button, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun PaymentScreen(state: CheckoutState, onSelect: (PaymentType) -> Unit) {
    var electronicMenu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.Bottom) {
            Column {
                Text("お支払い方法を選んでください", color = Ink, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text("商品登録は裏側で完了しています", color = Muted)
            }
            Spacer(Modifier.weight(1f))
            Text("小計  税込 ${state.totalIncludingTax}円", color = Ink, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(24.dp))
        if (!electronicMenu) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            PaymentCard(Modifier.weight(1f), "現", "現金", "紙幣・硬貨でお支払い") { onSelect(PaymentType.CASH) }
            PaymentCard(Modifier.weight(1f), "C", "クレジットカード", "カードを端末へ") { onSelect(PaymentType.CREDIT) }
            PaymentCard(Modifier.weight(1f), "IC", "電子マネー", "交通系IC・QUICPay・iD") { electronicMenu = true }
            PaymentCard(Modifier.weight(1f), "▦", "バーコード決済", "スマートフォンでお支払い") { onSelect(PaymentType.BARCODE) }
        } else Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            PaymentCard(Modifier.weight(1f), "←", "戻る", "支払い方法へ戻ります") { electronicMenu = false }
            PaymentCard(Modifier.weight(1f), "IC", "交通系IC", "Suica・PASMOなど") { onSelect(PaymentType.TRANSPORT_IC) }
            PaymentCard(Modifier.weight(1f), "Q", "QUICPay", "QUICPayでお支払い") { onSelect(PaymentType.QUICPAY) }
            PaymentCard(Modifier.weight(1f), "iD", "iD", "iDでお支払い") { onSelect(PaymentType.ID) }
        }
    }
}

@Composable
private fun PaymentCard(modifier: Modifier, icon: String, title: String, subtitle: String, onClick: () -> Unit) {
    Surface(modifier.fillMaxHeight().clickable(onClick = onClick), shape = RoundedCornerShape(20.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD9D4C9)), shadowElevation = 2.dp) {
        Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Box(Modifier.size(64.dp).background(Color(0xFFE7F2EC), RoundedCornerShape(20.dp)), contentAlignment = Alignment.Center) { Text(icon, color = Forest, fontSize = 24.sp, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.height(16.dp))
            Text(title, color = Ink, fontSize = 19.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            Text(subtitle, color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun PaymentStartingScreen() {
    LoadingPanel("決済端末を起動しています", "そのまま少しお待ちください")
}

@Composable
private fun SaleConfirmingScreen() {
    LoadingPanel("お支払いを確認しています", "画面は自動で切り替わります")
}

private fun paymentActions(paymentType: PaymentType): Triple<String, String, String> = when (paymentType) {
    PaymentType.CASH -> Triple("現金精算ボタン", "", "")
    PaymentType.CREDIT -> Triple("キャッシュレス決済ボタン", "クレジットカード決済ボタン", "")
    PaymentType.TRANSPORT_IC -> Triple("キャッシュレス決済ボタン", "電子マネー決済ボタン", "交通系電子マネー決済ボタン")
    PaymentType.QUICPAY -> Triple("キャッシュレス決済ボタン", "電子マネー決済ボタン", "QUICPay決済ボタン")
    PaymentType.ID -> Triple("キャッシュレス決済ボタン", "電子マネー決済ボタン", "iD決済ボタン")
    PaymentType.BARCODE -> Triple("キャッシュレス決済ボタン", "バーコード決済ボタン", "")
}

private fun customerErrorMessage(error: Throwable): String {
    val source = error.message.orEmpty()
    return when {
        source.contains("NO_ACTIVE_USAGE") || source.contains("SESSION_NOT_FOUND") -> "精算できるスタジオ利用記録が見つかりませんでした。"
        source.contains("AMOUNT") || source.contains("商品価格") -> "受付料金とレジ料金を確認できませんでした。"
        source.contains("SMAREGI_TRANSACTIONS_HTTP_403") -> "スマレジの売上確認権限が不足しています。"
        source.contains("ANDROID_DEVICE_AUTH_REQUIRED") -> "左上のロゴを5回押し、従業員画面でこの端末を認証してください。"
        source.contains("会員情報") -> source
        else -> "処理を完了できませんでした。もう一度お試しください。"
    }
}

@Composable
private fun LoadingPanel(title: String, subtitle: String) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(title, color = Ink, fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text(subtitle, color = Muted, fontSize = 17.sp)
        Spacer(Modifier.height(30.dp))
        LinearProgressIndicator(Modifier.width(520.dp).height(9.dp), color = Forest, trackColor = Color(0xFFDDE9E2))
        Spacer(Modifier.height(24.dp))
        Surface(color = Color(0xFFFFF2D8), shape = RoundedCornerShape(16.dp)) {
            Text("待ち時間におすすめ情報を表示できる領域", Modifier.padding(horizontal = 28.dp, vertical = 14.dp), color = Color(0xFF7A5A18))
        }
    }
}

@Composable
private fun CompletedScreen(onReset: () -> Unit) {
    LaunchedEffect(Unit) { delay(5_000); onReset() }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("✓", color = Forest, fontSize = 58.sp, fontWeight = FontWeight.Bold)
        Text("ありがとうございました", color = Ink, fontSize = 36.sp, fontWeight = FontWeight.Bold)
        Text("お支払いが完了しました。5秒後に最初の画面へ戻ります。", color = Muted, fontSize = 17.sp)
    }
}

@Composable
private fun ErrorScreen(message: String, onReset: () -> Unit) {
    LaunchedEffect(Unit) { delay(5_000); onReset() }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("もう一度お試しください", color = Ink, fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Text(message, color = Muted, fontSize = 17.sp)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onReset, Modifier.width(440.dp).height(62.dp)) { Text("最初に戻る") }
    }
}
