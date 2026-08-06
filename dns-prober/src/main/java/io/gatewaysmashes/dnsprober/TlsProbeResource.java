package io.gatewaysmashes.dnsprober;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.stream.Collectors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.OPTIONS;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

/**
 * Live HTTPS handshake probe used by the plugin's TLS Troubleshooting
 * page. The plugin sends a hostname (+ optional port), we perform an
 * actual TLS handshake against it and return the negotiated
 * version / cipher, the leaf certificate metadata, and a follow-up
 * HTTP HEAD status if the handshake succeeded.
 *
 * Runs in the same Quarkus app as the DNS prober — one companion
 * container, two endpoints, same ConsolePlugin proxy alias. The plugin
 * calls this via
 * {@code /api/proxy/plugin/kuadrant-console/dns-prober/api/tls/probe}
 * so no changes to the console operator's proxy config are needed to
 * pick it up.
 *
 * Two probes: a permissive trust manager pass (records the cert
 * details even when the chain is invalid — expired, wrong SAN, unknown
 * CA — so the operator sees the actual reason instead of a generic
 * failure), followed by a default-trust HTTPS HEAD to answer the
 * "does a real client succeed?" question.
 */
@Path("/api/tls/probe")
public class TlsProbeResource {

    /** Handshake times out fast — the plugin polls this on user
     *  action, we don't want the UI hanging on an unreachable host. */
    private static final int HANDSHAKE_TIMEOUT_MS = 8_000;
    /** HTTP HEAD after handshake — separate ceiling. */
    private static final int HTTP_TIMEOUT_MS = 8_000;

    public static final class Request {
        public String hostname;
        public Integer port; // default 443
        public String path;  // default "/"
    }

    public static final class CertInfo {
        public String subject;
        public String issuer;
        public List<String> sans;
        public String notBefore;
        public String notAfter;
        public String serialNumber;
        public String signatureAlgorithm;
        public Boolean expired;
        public Boolean notYetValid;
    }

    public static final class Response_ {
        public String hostname;
        public int port;
        /** "ok" | "failed" — did the handshake complete? */
        public String handshake;
        public String tlsVersion;
        public String cipherSuite;
        public Integer chainDepth;
        public CertInfo cert;
        /** Result of the follow-up trusted HTTPS HEAD. Null when the
         *  handshake failed. */
        public Integer httpStatus;
        public String httpStatusReason;
        /** True when the JDK default trust store validates the chain —
         *  a valid cert on an untrusted root would show handshake=ok,
         *  trusted=false. */
        public Boolean trusted;
        public Long latencyMs;
        public String probedAt;
        public String error;
    }

    /**
     * Trust-anything manager for the "info gathering" pass. This does
     * NOT get used by the follow-up trusted probe — that one uses the
     * JDK default trust store — so an "insecure" TLS setup on a
     * customer cluster is still called out via `trusted=false`.
     */
    private static SSLContext insecureSslContext() throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(new javax.net.ssl.KeyManager[0], new TrustManager[] {
            new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] c, String a) {}
                public void checkServerTrusted(X509Certificate[] c, String a) {}
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            }
        }, new java.security.SecureRandom());
        return ctx;
    }

    private static CertInfo describeCert(X509Certificate leaf) {
        CertInfo out = new CertInfo();
        out.subject = leaf.getSubjectX500Principal().getName();
        out.issuer = leaf.getIssuerX500Principal().getName();
        out.notBefore = leaf.getNotBefore().toInstant().toString();
        out.notAfter = leaf.getNotAfter().toInstant().toString();
        out.serialNumber = leaf.getSerialNumber().toString(16);
        out.signatureAlgorithm = leaf.getSigAlgName();
        try {
            Collection<List<?>> alt = leaf.getSubjectAlternativeNames();
            out.sans = alt == null ? List.of() : alt.stream()
                .filter(e -> e != null && e.size() >= 2)
                // Extension general-name types: 2 == dNSName, 7 == iPAddress.
                .map(e -> String.valueOf(e.get(1)))
                .collect(Collectors.toList());
        } catch (Exception ignored) {
            out.sans = List.of();
        }
        try {
            leaf.checkValidity();
            out.expired = false;
            out.notYetValid = false;
        } catch (CertificateExpiredException e) {
            out.expired = true;
            out.notYetValid = false;
        } catch (CertificateNotYetValidException e) {
            out.expired = false;
            out.notYetValid = true;
        }
        return out;
    }

    @OPTIONS
    public Response preflight() {
        return Response.ok()
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            .header("Access-Control-Allow-Headers", "content-type,accept,authorization")
            .build();
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response probe(Request req) {
        Response_ result = new Response_();
        result.probedAt = Instant.now().toString();
        if (req == null || req.hostname == null || req.hostname.isBlank()) {
            result.handshake = "failed";
            result.error = "hostname is required";
            return Response.status(400).entity(result).build();
        }
        result.hostname = req.hostname;
        result.port = req.port != null ? req.port : 443;
        String path = req.path != null && !req.path.isBlank() ? req.path : "/";

        long start = System.nanoTime();
        // -- pass 1: permissive handshake to collect cert regardless of
        //    trust. If the cert is expired / wrong SAN / unknown CA we
        //    still want to display why — the trusted pass below then
        //    tells us whether a browser would accept it.
        SSLSocket sock = null;
        try {
            SSLSocketFactory factory = insecureSslContext().getSocketFactory();
            sock = (SSLSocket) factory.createSocket();
            sock.connect(new InetSocketAddress(req.hostname, result.port), HANDSHAKE_TIMEOUT_MS);
            sock.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            // SNI — set the hostname on the SNIHostName extension so
            // vhost'd endpoints (like OpenShift routers) return the
            // right cert.
            javax.net.ssl.SNIHostName sni = new javax.net.ssl.SNIHostName(req.hostname);
            javax.net.ssl.SSLParameters p = sock.getSSLParameters();
            p.setServerNames(List.of(sni));
            sock.setSSLParameters(p);

            sock.startHandshake();
            SSLSession session = sock.getSession();
            result.handshake = "ok";
            result.tlsVersion = session.getProtocol();
            result.cipherSuite = session.getCipherSuite();
            X509Certificate[] chain = (X509Certificate[]) session.getPeerCertificates();
            result.chainDepth = chain != null ? chain.length : 0;
            if (chain != null && chain.length > 0) {
                result.cert = describeCert(chain[0]);
            }
        } catch (Exception e) {
            result.handshake = "failed";
            result.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            result.latencyMs = Duration.ofNanos(System.nanoTime() - start).toMillis();
            return Response.ok(result)
                .header("Access-Control-Allow-Origin", "*")
                .build();
        } finally {
            if (sock != null) try { sock.close(); } catch (IOException ignored) {}
        }

        // -- pass 2: trusted HTTPS HEAD. Answers the "would a real
        //    browser accept this?" question. Uses the JDK default
        //    trust store, so Let's Encrypt / any CA in the JVM trust
        //    bundle validates transparently.
        try {
            URI uri = URI.create("https://" + req.hostname + ":" + result.port + path);
            HttpsURLConnection conn = (HttpsURLConnection) uri.toURL().openConnection();
            conn.setRequestMethod("HEAD");
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            // Reuse the standard SNI-aware socket factory here; we do
            // not want to insert the permissive one.
            conn.setHostnameVerifier((HostnameVerifier)
                HttpsURLConnection.getDefaultHostnameVerifier());
            int code = conn.getResponseCode();
            result.httpStatus = code;
            result.httpStatusReason = conn.getResponseMessage();
            result.trusted = true;
        } catch (Exception e) {
            // Chain validation error, self-signed cert, or unreachable
            // — record the reason but keep handshake=ok since pass 1
            // did complete.
            result.trusted = false;
            if (result.error == null) {
                result.error = "trusted HTTPS check: " + e.getClass().getSimpleName()
                    + ": " + e.getMessage();
            }
        }
        result.latencyMs = Duration.ofNanos(System.nanoTime() - start).toMillis();
        return Response.ok(result)
            .header("Access-Control-Allow-Origin", "*")
            .build();
    }
}
