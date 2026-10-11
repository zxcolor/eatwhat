package com.chishenme.app.data.local

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*

/** Maintenance only: never locates a user or requests restaurant data in background. */
@AndroidEntryPoint
class NearbyCacheCleanupService : JobService() {
    @Inject lateinit var cache: NearbyRestaurantCache
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var work: Job? = null
    override fun onStartJob(params: JobParameters): Boolean {
        work = scope.launch {
            val failed = runCatching { cache.prune() }.isFailure
            jobFinished(params, failed)
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean { work?.cancel(); return true }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    companion object {
        private const val JobId = 350090
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (scheduler.getPendingJob(JobId) != null) return
            scheduler.schedule(JobInfo.Builder(JobId, ComponentName(context, NearbyCacheCleanupService::class.java))
                .setPeriodic(24 * 60 * 60 * 1000L)
                .setPersisted(true)
                .build())
        }
    }
}
