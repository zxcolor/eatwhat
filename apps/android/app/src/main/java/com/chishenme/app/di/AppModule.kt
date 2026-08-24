package com.chishenme.app.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.chishenme.app.BuildConfig
import com.chishenme.app.data.AccountAuthActions
import com.chishenme.app.data.AccountExportActions
import com.chishenme.app.data.AccountExportRepository
import com.chishenme.app.data.AuthRepository
import com.chishenme.app.data.SupportFeedbackActions
import com.chishenme.app.data.SupportFeedbackRepository
import com.chishenme.app.data.remote.ApiContractInterceptor
import com.chishenme.app.data.remote.AccountExportApi
import com.chishenme.app.data.remote.AccountExportContentApi
import com.chishenme.app.data.remote.AuthApi
import com.chishenme.app.data.remote.LocationSearchApi
import com.chishenme.app.data.remote.RecommendationApi
import com.chishenme.app.data.remote.RuntimeAppVersionInterceptor
import com.chishenme.app.data.remote.SavedResourcesApi
import com.chishenme.app.data.remote.SupportFeedbackApi
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import okhttp3.MediaType.Companion.toMediaType
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import retrofit2.Retrofit

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    fun providePreferencesDataStore(
        @ApplicationContext context: Context,
    ): DataStore<Preferences> = PreferenceDataStoreFactory.create(
        produceFile = { context.preferencesDataStoreFile("app_preferences.preferences_pb") },
    )

    @Provides
    @Singleton
    @OptIn(ExperimentalSerializationApi::class)
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        // Optional request fields must be omitted rather than encoded as JSON null.
        explicitNulls = false
        encodeDefaults = true
        isLenient = false
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(
        runtimeAppVersionInterceptor: RuntimeAppVersionInterceptor,
    ): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .addInterceptor(runtimeAppVersionInterceptor)
        .addInterceptor(ApiContractInterceptor())
        // Deliberately no body logger: recommendation bodies contain short-lived coordinates.
        .build()

    @Provides
    @Singleton
    fun provideRetrofit(json: Json, client: OkHttpClient): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides
    @Singleton
    fun provideRecommendationApi(retrofit: Retrofit): RecommendationApi =
        retrofit.create(RecommendationApi::class.java)

    @Provides
    @Singleton
    fun provideLocationSearchApi(retrofit: Retrofit): LocationSearchApi =
        retrofit.create(LocationSearchApi::class.java)

    @Provides
    @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)

    @Provides
    @Singleton
    fun provideAccountAuthActions(repository: AuthRepository): AccountAuthActions = repository

    @Provides
    @Singleton
    fun provideAccountExportApi(retrofit: Retrofit): AccountExportApi =
        retrofit.create(AccountExportApi::class.java)

    @Provides
    @Singleton
    fun provideAccountExportActions(repository: AccountExportRepository): AccountExportActions = repository

    @Provides
    @Singleton
    fun provideAccountExportContentApi(
        retrofit: Retrofit,
        client: OkHttpClient,
    ): AccountExportContentApi {
        // Export content is streamed and may legitimately exceed the ordinary
        // 10-second API call budget on a weak connection. Connect/header stalls
        // remain bounded while the user-initiated transfer gets its own cap.
        val exportClient = client.newBuilder()
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.MINUTES)
            .build()
        return retrofit.newBuilder()
            .client(exportClient)
            .build()
            .create(AccountExportContentApi::class.java)
    }

    @Provides
    @Singleton
    fun provideSavedResourcesApi(retrofit: Retrofit): SavedResourcesApi =
        retrofit.create(SavedResourcesApi::class.java)

    @Provides
    @Singleton
    fun provideSupportFeedbackApi(retrofit: Retrofit): SupportFeedbackApi =
        retrofit.create(SupportFeedbackApi::class.java)

    @Provides
    @Singleton
    fun provideSupportFeedbackActions(
        repository: SupportFeedbackRepository,
    ): SupportFeedbackActions = repository
}
