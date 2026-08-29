package com.chishenme.buildlogic;

import java.util.List;
import java.util.Set;

/** Exact allow-list for the one release task that does not consume signing material. */
public final class ReleaseTaskRequestPolicy {
    private static final Set<String> MANIFEST_TASKS = Set.of(
            "processReleaseMainManifest",
            ":app:processReleaseMainManifest");

    public static boolean isManifestOnlyVerification(List<String> requestedTasks) {
        if (requestedTasks == null || requestedTasks.size() != 1) {
            return false;
        }
        String requestedTask = requestedTasks.get(0);
        return requestedTask != null && MANIFEST_TASKS.contains(requestedTask);
    }

    private ReleaseTaskRequestPolicy() {}
}
