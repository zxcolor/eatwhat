package com.chishenme.app.data

import com.chishenme.app.data.remote.CreatePrivateFeedbackRequest
import com.chishenme.app.data.remote.FavoriteGroup
import com.chishenme.app.data.remote.FavoriteMutationRequest
import com.chishenme.app.data.remote.FavoriteRecord
import com.chishenme.app.data.remote.FavoritesPage
import com.chishenme.app.data.remote.PrivateFeedbackPage
import com.chishenme.app.data.remote.PrivateFeedbackRecord
import com.chishenme.app.data.remote.PrivateFeedbackType
import com.chishenme.app.data.remote.RecommendationHistoryAction
import com.chishenme.app.data.remote.RecommendationHistoryPage
import com.chishenme.app.data.remote.RecommendationResultReferenceInput
import com.chishenme.app.data.remote.ResultTokenValidator
import com.chishenme.app.data.remote.SavedResourcesApi
import com.chishenme.app.data.remote.SavedResourcesResponseValidator
import com.chishenme.app.data.remote.UpdateFavoriteGroupRequest
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import retrofit2.Response

enum class SavedResourcesFailureKind {
    INPUT,
    LOGIN_REQUIRED,
    RIGHTS_UNAVAILABLE,
    RESULT_EXPIRED,
    CONFLICT,
    RATE_LIMITED,
    NETWORK,
    TIMEOUT,
    UNAVAILABLE,
    INVALID_RESPONSE,
    INCOMPATIBLE_API,
    UNKNOWN,
}

sealed interface SavedResourcesOutcome<out Value> {
    data class Success<Value>(val value: Value) : SavedResourcesOutcome<Value>
    data class Failure(
        val kind: SavedResourcesFailureKind,
        val message: String,
    ) : SavedResourcesOutcome<Nothing>
}

/**
 * Account-scoped persistence client. No returned record is written to disk by this repository.
 */
@Singleton
class SavedResourcesRepository private constructor(
    private val api: SavedResourcesApi,
    private val auth: AuthenticatedRequestExecutor,
    private val idempotencyKeyFactory: () -> String,
) {
    @Inject
    constructor(
        api: SavedResourcesApi,
        authRepository: AuthRepository,
    ) : this(
        api,
        AuthRepositoryRequestExecutor(authRepository),
        { UUID.randomUUID().toString() },
    )

    internal constructor(
        api: SavedResourcesApi,
        auth: AuthenticatedRequestExecutor,
        idempotencyKeyFactory: () -> String,
        @Suppress("UNUSED_PARAMETER") testOnly: Unit = Unit,
    ) : this(api, auth, idempotencyKeyFactory)

    suspend fun listFavorites(
        cursor: String? = null,
        group: FavoriteGroup? = null,
    ): SavedResourcesOutcome<FavoritesPage> {
        if (!cursor.isValidCursorOrNull()) return invalidInput("收藏分页凭据无效，请重新加载")
        return authorizedBody(
            expectedCode = 200,
            validate = SavedResourcesResponseValidator::validFavoritesPage,
        ) { header -> api.listFavorites(header, cursor = cursor, group = group) }
    }

    suspend fun createFavorite(
        requestId: String,
        resultToken: String,
        group: FavoriteGroup,
    ): SavedResourcesOutcome<FavoriteRecord> {
        val request = resultMutationRequest(requestId, resultToken) { idempotencyKey, result ->
            FavoriteMutationRequest(idempotencyKey, result, group)
        } ?: return invalidInput("本次餐厅结果凭据无效，请重新搜索或获取推荐")
        return authorizedBody(
            expectedCode = 201,
            validate = SavedResourcesResponseValidator::validFavorite,
        ) { header -> api.createFavorite(header, request) }
    }

    suspend fun updateFavoriteGroup(
        favoriteId: String,
        group: FavoriteGroup,
    ): SavedResourcesOutcome<FavoriteRecord> {
        if (!SavedResourcesResponseValidator.run { favoriteId.isContractUuid() }) {
            return invalidInput("收藏记录无效，请重新加载")
        }
        val idempotencyKey = idempotencyKeyFactory().takeIf(::isValidGeneratedUuid)
            ?: return invalidInput("暂时无法创建安全操作凭据")
        return authorizedBody(
            expectedCode = 200,
            validate = SavedResourcesResponseValidator::validFavorite,
        ) { header ->
            api.updateFavoriteGroup(
                header,
                favoriteId,
                UpdateFavoriteGroupRequest(idempotencyKey, group),
            )
        }
    }

    suspend fun deleteFavorite(favoriteId: String): SavedResourcesOutcome<Unit> {
        if (!SavedResourcesResponseValidator.run { favoriteId.isContractUuid() }) {
            return invalidInput("收藏记录无效，请重新加载")
        }
        return authorizedNoContent { header -> api.deleteFavorite(header, favoriteId) }
    }

    suspend fun listHistory(
        cursor: String? = null,
        action: RecommendationHistoryAction? = null,
    ): SavedResourcesOutcome<RecommendationHistoryPage> {
        if (!cursor.isValidCursorOrNull()) return invalidInput("历史分页凭据无效，请重新加载")
        return authorizedBody(
            expectedCode = 200,
            validate = SavedResourcesResponseValidator::validHistoryPage,
        ) { header -> api.listHistory(header, cursor = cursor, action = action) }
    }

    suspend fun clearHistory(): SavedResourcesOutcome<Unit> =
        authorizedNoContent(api::clearHistory)

    suspend fun listPrivateFeedback(
        cursor: String? = null,
        type: PrivateFeedbackType? = null,
    ): SavedResourcesOutcome<PrivateFeedbackPage> {
        if (!cursor.isValidCursorOrNull()) return invalidInput("反馈分页凭据无效，请重新加载")
        return authorizedBody(
            expectedCode = 200,
            validate = SavedResourcesResponseValidator::validPrivateFeedbackPage,
        ) { header -> api.listPrivateFeedback(header, cursor = cursor, type = type) }
    }

    suspend fun createPrivateFeedback(
        requestId: String,
        resultToken: String,
        type: PrivateFeedbackType,
    ): SavedResourcesOutcome<PrivateFeedbackRecord> {
        val request = resultMutationRequest(requestId, resultToken) { idempotencyKey, result ->
            CreatePrivateFeedbackRequest(idempotencyKey, result, type)
        } ?: return invalidInput("本次餐厅结果凭据无效，请重新搜索或获取推荐")
        return authorizedBody(
            expectedCode = 201,
            validate = SavedResourcesResponseValidator::validPrivateFeedback,
        ) { header -> api.createPrivateFeedback(header, request) }
    }

    suspend fun deletePrivateFeedback(feedbackId: String): SavedResourcesOutcome<Unit> {
        if (!SavedResourcesResponseValidator.run { feedbackId.isContractUuid() }) {
            return invalidInput("反馈记录无效，请重新加载")
        }
        return authorizedNoContent { header -> api.deletePrivateFeedback(header, feedbackId) }
    }

    suspend fun clearPrivateFeedback(): SavedResourcesOutcome<Unit> =
        authorizedNoContent(api::clearPrivateFeedback)

    private suspend fun <Value> authorizedBody(
        expectedCode: Int,
        validate: (Value) -> Boolean,
        call: suspend (String) -> Response<Value>,
    ): SavedResourcesOutcome<Value> {
        return when (val outcome = auth.executeAuthenticated(call)) {
            is AuthOutcome.Failure -> mapAuthFailure(outcome)
            is AuthOutcome.Success -> {
                val response = outcome.value
                if (response.code() != expectedCode) return mapHttpFailure(response.code())
                val body = response.body() ?: return invalidResponse()
                if (!validate(body)) invalidResponse() else SavedResourcesOutcome.Success(body)
            }
        }
    }

    private suspend fun authorizedNoContent(
        call: suspend (String) -> Response<Unit>,
    ): SavedResourcesOutcome<Unit> = when (val outcome = auth.executeAuthenticated(call)) {
        is AuthOutcome.Failure -> mapAuthFailure(outcome)
        is AuthOutcome.Success -> if (outcome.value.code() == 204) {
            SavedResourcesOutcome.Success(Unit)
        } else {
            mapHttpFailure(outcome.value.code())
        }
    }

    private fun mapAuthFailure(failure: AuthOutcome.Failure): SavedResourcesOutcome.Failure = when (
        failure.kind
    ) {
        AuthFailureKind.INPUT -> failure(SavedResourcesFailureKind.INPUT, "提交的信息不符合要求")
        AuthFailureKind.NETWORK -> failure(SavedResourcesFailureKind.NETWORK, "网络不可用，请检查连接后重试")
        AuthFailureKind.TIMEOUT -> failure(SavedResourcesFailureKind.TIMEOUT, "保存服务响应较慢，请稍后重试")
        AuthFailureKind.UNAUTHORIZED -> loginRequired()
        AuthFailureKind.FORBIDDEN -> rightsUnavailable()
        AuthFailureKind.CONFLICT -> conflict()
        AuthFailureKind.RATE_LIMITED -> rateLimited()
        AuthFailureKind.UNAVAILABLE -> unavailable()
        AuthFailureKind.INVALID_RESPONSE -> invalidResponse()
        AuthFailureKind.INCOMPATIBLE_API -> incompatible()
        AuthFailureKind.LOCAL_SECURITY -> failure(
            SavedResourcesFailureKind.LOGIN_REQUIRED,
            "本机登录状态无法安全读取，请重新登录；游客推荐不受影响",
        )
        AuthFailureKind.UNKNOWN -> failure(SavedResourcesFailureKind.UNKNOWN, "账号数据操作暂时失败，请重试")
    }

    private suspend fun mapHttpFailure(code: Int): SavedResourcesOutcome.Failure = when (code) {
        400 -> failure(SavedResourcesFailureKind.INPUT, "请求内容无效，请重新打开本页")
        401 -> {
            invalidateAuthenticationAfterUnauthorized()
            loginRequired()
        }
        403 -> rightsUnavailable()
        404 -> failure(SavedResourcesFailureKind.INPUT, "记录不存在或已删除，请刷新后重试")
        409 -> conflict()
        410 -> failure(
            SavedResourcesFailureKind.RESULT_EXPIRED,
            "本次餐厅结果凭据已过期，请重新搜索或获取推荐后再保存",
        )
        413, 415 -> incompatible()
        429 -> rateLimited()
        500, 503 -> unavailable()
        in 200..299 -> invalidResponse()
        else -> failure(SavedResourcesFailureKind.UNKNOWN, "账号数据服务暂时不可用，请稍后重试")
    }

    private fun loginRequired() = failure(
        SavedResourcesFailureKind.LOGIN_REQUIRED,
        "请先登录后收藏或记录私有反馈；游客核心推荐仍可继续使用",
    )

    private fun rightsUnavailable() = failure(
        SavedResourcesFailureKind.RIGHTS_UNAVAILABLE,
        "当前账号、数据授权或功能开关不允许此操作；未新增或改写账号数据",
    )

    private fun conflict() = failure(
        SavedResourcesFailureKind.CONFLICT,
        "保存状态发生冲突，请刷新后重试；现有数据未被自动覆盖",
    )

    private fun rateLimited() = failure(
        SavedResourcesFailureKind.RATE_LIMITED,
        "操作过于频繁，请稍后再试",
    )

    private fun unavailable() = failure(
        SavedResourcesFailureKind.UNAVAILABLE,
        "账号数据服务暂时不可用，请稍后重试",
    )

    private fun invalidResponse() = failure(
        SavedResourcesFailureKind.INVALID_RESPONSE,
        "账号数据未通过安全校验，未展示或缓存餐厅信息",
    )

    private fun incompatible() = failure(
        SavedResourcesFailureKind.INCOMPATIBLE_API,
        "当前 App 与账号数据服务版本不兼容，请更新 App",
    )

    private fun invalidInput(message: String) = failure(SavedResourcesFailureKind.INPUT, message)

    private suspend fun invalidateAuthenticationAfterUnauthorized() {
        try {
            auth.invalidateAuthentication()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // The authoritative 401 remains actionable even if local secure
            // storage cleanup is temporarily unavailable. Never surface details.
        }
    }

    private fun failure(kind: SavedResourcesFailureKind, message: String) =
        SavedResourcesOutcome.Failure(kind, message)

    private inline fun <Request> resultMutationRequest(
        requestId: String,
        resultToken: String,
        create: (String, RecommendationResultReferenceInput) -> Request,
    ): Request? {
        if (!SavedResourcesResponseValidator.run { requestId.isContractUuid() } ||
            !ResultTokenValidator.isValid(resultToken)
        ) {
            return null
        }
        val idempotencyKey = idempotencyKeyFactory().takeIf(::isValidGeneratedUuid) ?: return null
        return create(
            idempotencyKey,
            RecommendationResultReferenceInput(requestId, resultToken),
        )
    }

    private fun isValidGeneratedUuid(value: String): Boolean =
        SavedResourcesResponseValidator.run { value.isContractUuid() }

    private fun String?.isValidCursorOrNull(): Boolean =
        SavedResourcesResponseValidator.run { this@isValidCursorOrNull.isPageCursorOrNull() }
}

private class AuthRepositoryRequestExecutor(
    private val repository: AuthRepository,
) : AuthenticatedRequestExecutor {
    override suspend fun <Value> executeAuthenticated(
        call: suspend (authorizationHeader: String) -> Value,
    ): AuthOutcome<Value> = repository.executeAuthenticated(call)

    override suspend fun invalidateAuthentication() {
        repository.clearLocalSession()
    }
}
