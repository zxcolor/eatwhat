package com.chishenme.app.di

import com.chishenme.app.data.local.AndroidKeystoreRefreshTokenCipher
import com.chishenme.app.data.local.RefreshTokenCipher
import com.chishenme.app.feature.consent.AppPrivacyAuthorizationGate
import com.chishenme.app.feature.consent.PrivacyAuthorizationGate
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
internal abstract class AuthStorageModule {
    @Binds
    @Singleton
    abstract fun bindRefreshTokenCipher(
        implementation: AndroidKeystoreRefreshTokenCipher,
    ): RefreshTokenCipher

    @Binds
    @Singleton
    abstract fun bindPrivacyAuthorizationGate(
        implementation: AppPrivacyAuthorizationGate,
    ): PrivacyAuthorizationGate
}
