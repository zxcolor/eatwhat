package com.chishenme.buildlogic;

import java.util.regex.Pattern;

/** Build-time fail-closed syntax gate for the optional public QQ AppID. */
public final class QqAppIdPolicy {
    private static final Pattern APP_ID = Pattern.compile("^[1-9][0-9]{4,15}$");

    private QqAppIdPolicy() {}

    public static boolean isAllowedOrDisabled(String raw) {
        if (raw == null) return true;
        String value = raw.trim();
        return value.isEmpty() || APP_ID.matcher(value).matches();
    }
}
