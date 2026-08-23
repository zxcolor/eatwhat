package com.chishenme.buildlogic;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Pure, DNS-free validation for the endpoint embedded in release builds. */
public final class ReleaseApiUrlPolicy {
    private static final Pattern DNS_LABEL = Pattern.compile(
        "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    );
    private static final Set<String> RESERVED_SUFFIXES = Set.of(
        "localhost",
        "local",
        "localdomain",
        "invalid",
        "test",
        "example",
        "internal",
        "onion",
        "arpa"
    );
    private static final Set<String> RESERVED_PUBLIC_EXAMPLES = Set.of(
        "example.com",
        "example.net",
        "example.org"
    );

    private ReleaseApiUrlPolicy() {}

    public static boolean isAllowed(String value) {
        if (value == null) return false;
        String raw = value.trim();
        if (raw.isEmpty() || !raw.endsWith("/")) return false;

        final URI uri;
        try {
            uri = new URI(raw);
        } catch (Exception ignored) {
            return false;
        }
        if (uri.isOpaque() || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            return false;
        }
        if (uri.getPort() == 0 || uri.getPort() > 65_535) return false;

        String host = uri.getHost();
        if (host == null || host.isBlank()) return false;
        host = normalizeHost(host);
        if (host.isEmpty()) return false;

        if (host.indexOf(':') >= 0) return isPublicIpv6Literal(host);
        if (host.chars().allMatch(character -> Character.isDigit(character) || character == '.')) {
            int[] address = parseCanonicalIpv4(host);
            return address != null && isPublicIpv4(address);
        }
        return isPublicDnsName(host);
    }

    private static String normalizeHost(String value) {
        String host = value.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1);
        }
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        return host;
    }

    private static boolean isPublicDnsName(String host) {
        if (host.length() > 253 || !host.contains(".")) return false;
        String[] labels = host.split("\\.", -1);
        if (labels.length < 2) return false;
        for (String label : labels) {
            if (label.length() > 63 || !DNS_LABEL.matcher(label).matches()) return false;
        }
        if (labels[labels.length - 1].chars().allMatch(Character::isDigit)) return false;

        for (String suffix : RESERVED_SUFFIXES) {
            if (host.equals(suffix) || host.endsWith("." + suffix)) return false;
        }
        for (String example : RESERVED_PUBLIC_EXAMPLES) {
            if (host.equals(example) || host.endsWith("." + example)) return false;
        }
        return true;
    }

    private static int[] parseCanonicalIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] result = new int[4];
        for (int index = 0; index < parts.length; index += 1) {
            String part = parts[index];
            if (part.isEmpty() || (part.length() > 1 && part.startsWith("0"))) return null;
            try {
                result[index] = Integer.parseInt(part);
            } catch (NumberFormatException ignored) {
                return null;
            }
            if (result[index] < 0 || result[index] > 255) return null;
        }
        return result;
    }

    private static boolean isPublicIpv4(int[] address) {
        int first = address[0];
        int second = address[1];
        int third = address[2];
        if (first == 0 || first == 10 || first == 127 || first >= 224) return false;
        if (first == 100 && second >= 64 && second <= 127) return false;
        if (first == 169 && second == 254) return false;
        if (first == 172 && second >= 16 && second <= 31) return false;
        if (first == 192 && second == 168) return false;
        if (first == 192 && second == 0 && (third == 0 || third == 2)) return false;
        if (first == 192 && second == 88 && third == 99) return false;
        if (first == 198 && (second == 18 || second == 19)) return false;
        if (first == 198 && second == 51 && third == 100) return false;
        if (first == 203 && second == 0 && third == 113) return false;
        return true;
    }

    private static boolean isPublicIpv6Literal(String host) {
        if (host.contains("%")) return false;
        final InetAddress parsed;
        try {
            // A colon is required before this method is called, so this parses a
            // numeric literal and never performs a DNS lookup.
            parsed = InetAddress.getByName(host);
        } catch (Exception ignored) {
            return false;
        }
        if (parsed instanceof Inet4Address) {
            byte[] bytes = parsed.getAddress();
            return isPublicIpv4(new int[] {
                bytes[0] & 0xff,
                bytes[1] & 0xff,
                bytes[2] & 0xff,
                bytes[3] & 0xff,
            });
        }
        if (!(parsed instanceof Inet6Address)) return false;
        if (
            parsed.isAnyLocalAddress() ||
            parsed.isLoopbackAddress() ||
            parsed.isLinkLocalAddress() ||
            parsed.isSiteLocalAddress() ||
            parsed.isMulticastAddress()
        ) return false;

        byte[] bytes = parsed.getAddress();
        // Release endpoints may use global unicast literals only (2000::/3).
        if ((bytes[0] & 0xe0) != 0x20) return false;
        if (hasPrefix(bytes, new int[] { 0x20, 0x01, 0x0d, 0xb8 }, 32)) return false; // documentation
        if (hasPrefix(bytes, new int[] { 0x20, 0x01, 0x00, 0x02, 0x00, 0x00 }, 48)) return false; // benchmark
        if (hasPrefix(bytes, new int[] { 0x20, 0x01, 0x00, 0x10 }, 28)) return false; // ORCHID
        if (hasPrefix(bytes, new int[] { 0x20, 0x01, 0x00, 0x20 }, 28)) return false; // ORCHIDv2
        if (hasPrefix(bytes, new int[] { 0x3f, 0xff, 0x00 }, 20)) return false; // documentation
        return true;
    }

    private static boolean hasPrefix(byte[] address, int[] prefix, int bitCount) {
        for (int bit = 0; bit < bitCount; bit += 1) {
            int byteIndex = bit / 8;
            int mask = 1 << (7 - (bit % 8));
            int addressBit = (address[byteIndex] & 0xff) & mask;
            int prefixBit = prefix[byteIndex] & mask;
            if (addressBit != prefixBit) return false;
        }
        return true;
    }
}
