package com.chishenme.app.auth.fusion

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
internal object FusionAuthSdkModule {
    @Provides
    @Singleton
    fun provideFusionAuthSdkFactory(
        factory: PlatformFusionAuthSdkFactory,
    ): FusionAuthSdkFactory = factory
}
