package io.gatewaysmashes.dnsprober;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import org.xbill.DNS.ARecord;
import org.xbill.DNS.Lookup;
import org.xbill.DNS.Name;
import org.xbill.DNS.Rcode;
import org.xbill.DNS.Record;
import org.xbill.DNS.Resolver;
import org.xbill.DNS.SimpleResolver;
import org.xbill.DNS.Type;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.OPTIONS;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

/**
 * DNS probe endpoint used by the kuadrant-console plugin's DNS
 * Troubleshooting page. The plugin sends a hostname + a list of public
 * resolvers, and we return one row per resolver telling the operator
 * whether that resolver returned an A record, an NXDOMAIN, a SERVFAIL,
 * or timed out.
 *
 * The service intentionally does NOT use the JVM's built-in resolver
 * (that only queries whatever the pod's /etc/resolv.conf says). We
 * build a {@link SimpleResolver} pointed at each requested address so
 * the answer is what THAT resolver would return to a browser sitting
 * in the same network — which is the whole point of the "why does the
 * hostname work in this browser but not that one" story.
 *
 * CORS: `@OPTIONS` is handled explicitly so the browser preflight
 * succeeds. Quarkus' CORS extension can do this globally, but we skip
 * it to keep the deploy trivial — the operator points a route at the
 * service and the plugin calls it directly.
 */
@Path("/api/probe")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class ProbeResource {

    /** UDP query budget per resolver. Keep it tight — an unreachable
     *  resolver otherwise blocks the plugin's spinner for 30 s (Java's
     *  default). 3 s is roughly two RTT + jitter, plenty for the
     *  1.1.1.1/8.8.8.8 class of anycasted resolvers. */
    private static final Duration TIMEOUT = Duration.ofSeconds(3);

    /** Default resolvers when the request omits the field. Same list
     *  the plugin ships hardcoded so the two views match by default. */
    private static final List<ResolverInput> DEFAULTS = List.of(
        new ResolverInput("Cloudflare", "1.1.1.1"),
        new ResolverInput("Google", "8.8.8.8"),
        new ResolverInput("Quad9", "9.9.9.9"),
        new ResolverInput("OpenDNS", "208.67.222.222"),
        new ResolverInput("Verisign", "64.6.64.6"),
        new ResolverInput("Cisco OpenDNS", "208.67.220.220"),
        new ResolverInput("AdGuard", "94.140.14.14"),
        new ResolverInput("Yandex", "77.88.8.8")
    );

    @POST
    public Response probe(ProbeRequest req) {
        if (req == null || req.hostname == null || req.hostname.isBlank()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(new ErrorBody("hostname is required")).build();
        }
        List<ResolverInput> resolvers = (req.resolvers == null || req.resolvers.isEmpty())
                ? DEFAULTS
                : req.resolvers;

        List<ProbeResult> results = new ArrayList<>(resolvers.size());
        for (ResolverInput r : resolvers) {
            results.add(probeOne(req.hostname, r));
        }
        return Response.ok(new ProbeResponse(req.hostname, results))
                .header("Access-Control-Allow-Origin", "*")
                .build();
    }

    /** Browser preflight — accept any origin so a Console-hosted plugin
     *  can call us without extra config. Locked-down deploys can front
     *  this service with an Istio AuthorizationPolicy that constrains
     *  callers per-tenant. */
    @OPTIONS
    public Response preflight() {
        return Response.ok()
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .build();
    }

    private ProbeResult probeOne(String hostname, ResolverInput r) {
        Instant start = Instant.now();
        try {
            Resolver resolver = new SimpleResolver(r.ip);
            resolver.setTimeout(TIMEOUT);
            // Force UDP → TCP fallback via dnsjava's Lookup helper; keep
            // to A records — AAAA/CNAME chains would double the round
            // trips per resolver for a value the plugin doesn't render.
            Lookup lookup = new Lookup(Name.fromString(hostname, Name.root), Type.A);
            lookup.setResolver(resolver);
            Record[] answers = lookup.run();
            long ms = Duration.between(start, Instant.now()).toMillis();
            switch (lookup.getResult()) {
                case Lookup.SUCCESSFUL:
                    String answer = answers != null && answers.length > 0
                            ? formatAnswer(answers)
                            : "no A record";
                    return new ProbeResult(r.name, "healthy", answer, ms, Instant.now().toString());
                case Lookup.HOST_NOT_FOUND:
                    return new ProbeResult(r.name, "failing", "NXDOMAIN", ms, Instant.now().toString());
                case Lookup.TRY_AGAIN:
                    return new ProbeResult(r.name, "pending", "SERVFAIL / timeout", ms, Instant.now().toString());
                case Lookup.TYPE_NOT_FOUND:
                    return new ProbeResult(r.name, "pending", "no A record", ms, Instant.now().toString());
                default:
                    return new ProbeResult(r.name, "unknown", Rcode.string(lookup.getResult()), ms, Instant.now().toString());
            }
        } catch (Exception e) {
            long ms = Duration.between(start, Instant.now()).toMillis();
            return new ProbeResult(r.name, "failing", "error: " + e.getMessage(), ms, Instant.now().toString());
        }
    }

    private String formatAnswer(Record[] records) {
        // Take the first A record — matches how a browser would pick.
        // Extras become discoverable via `dig` if the operator wants
        // the full picture.
        for (Record rec : records) {
            if (rec instanceof ARecord a) {
                return "A " + a.getAddress().getHostAddress();
            }
        }
        return "A record present but not parseable";
    }

    // ----- DTOs -----

    public static class ResolverInput {
        public String name;
        public String ip;
        public ResolverInput() {}
        public ResolverInput(String name, String ip) {
            this.name = name;
            this.ip = ip;
        }
    }

    public static class ProbeRequest {
        public String hostname;
        public List<ResolverInput> resolvers;
    }

    public static class ProbeResult {
        public String resolver;
        public String status;
        public String answer;
        public long latencyMs;
        public String probedAt;
        public ProbeResult() {}
        public ProbeResult(String resolver, String status, String answer, long latencyMs, String probedAt) {
            this.resolver = resolver;
            this.status = status;
            this.answer = answer;
            this.latencyMs = latencyMs;
            this.probedAt = probedAt;
        }
    }

    public static class ProbeResponse {
        public String hostname;
        public List<ProbeResult> results;
        public ProbeResponse() {}
        public ProbeResponse(String hostname, List<ProbeResult> results) {
            this.hostname = hostname;
            this.results = results;
        }
    }

    public static class ErrorBody {
        public String message;
        public ErrorBody() {}
        public ErrorBody(String message) { this.message = message; }
    }

}
