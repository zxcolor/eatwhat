package com.chishenme.app.di

import com.chishenme.app.location.AndroidForegroundLocationClient
import com.chishenme.app.location.ForegroundLocationClient
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
abstract class LocationModule {
    @Binds
    abstract fun bindForegroundLocationClient(
        implementation: AndroidForegroundLocationClient,
    ): ForegroundLocationClient
}
