package com.chishenme.buildlogic;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.List;
import org.junit.Test;

public final class ReleaseTaskRequestPolicyTest {
    @Test
    public void acceptsOnlyTheExactManifestTask() {
        assertTrue(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifest")));
        assertTrue(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of(":app:processReleaseMainManifest")));
    }

    @Test
    public void rejectsMissingOrLookalikeTasks() {
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(null));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(Collections.emptyList()));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(List.of("")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifestExtra")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("ProcessReleaseMainManifest")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of(":other:processReleaseMainManifest")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of(" processReleaseMainManifest")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifest ")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("app:processReleaseMainManifest")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifest", "processReleaseMainManifest")));
    }

    @Test
    public void addingAnyReleaseBuildTaskRestoresTheSigningGate() {
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("assembleRelease")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("bundleRelease")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("packageRelease")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifest", "assembleRelease")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of(":app:processReleaseMainManifest", ":app:bundleRelease")));
        assertFalse(ReleaseTaskRequestPolicy.isManifestOnlyVerification(
                List.of("processReleaseMainManifest", "help")));
    }
}
