package org.endo.floot;

import java.net.URI;
import java.net.URISyntaxException;

/** URL fragments are connection credentials; preserve them, never log them. */
final class ConnectionUrl {
    static String origin(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getPort() < -1 || uri.getPort() > 65535)
                throw new IllegalArgumentException("Expected an HTTPS web UI URL");
            return new URI("https", null, uri.getHost().toLowerCase(java.util.Locale.ROOT),
                uri.getPort() == 443 ? -1 : uri.getPort(), null, null, null).toString();
        } catch (URISyntaxException error) { throw new IllegalArgumentException("Invalid URL", error); }
    }
    static boolean matchesOrigin(String value, String expected) {
        try { return origin(value).equals(expected); }
        catch (IllegalArgumentException error) { return false; }
    }
    private ConnectionUrl() {}
}
