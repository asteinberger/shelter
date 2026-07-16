import type { Database } from "../lib/database.js";
import type { CloudflareService } from "./cloudflare.js";

/**
 * Runs in the API control plane, never in the Docker-socket worker. It is the
 * only preview component that handles Cloudflare credentials.
 */
export class PreviewDnsReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly cloudflare: CloudflareService
  ) {}

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    const tick = (): void => {
      if (this.running) return;
      this.running = true;
      void this.processNext()
        .catch(() => undefined)
        .finally(() => { this.running = false; });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async processNext(): Promise<boolean> {
    const cleanup = this.database.nextPullRequestPreviewDnsCleanup();
    if (cleanup) {
      try {
        await this.cloudflare.deleteDnsRecord(cleanup.zone_id, cleanup.dns_record_id, cleanup.hostname);
        this.database.clearPullRequestPreviewDns(cleanup.id, cleanup.dns_record_id);
      } catch (error) {
        this.database.recordPullRequestPreviewDnsFailure(
          cleanup.id,
          `Cloudflare DNS cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
      return true;
    }

    const preview = this.database.nextPullRequestPreviewDnsProvisioning();
    if (!preview || !preview.deployment_id) return false;
    const project = this.database.getMutableProject(preview.project_id);
    const domain = project?.preview_domain_id
      ? this.database.getDomain(project.preview_domain_id)
      : undefined;
    if (!project || project.preview_deployments_enabled !== 1 || !domain?.zone_id || domain.status !== "active") {
      this.database.recordPullRequestPreviewDnsFailure(preview.id, "Selected preview domain is no longer active");
      return true;
    }

    let provisioned: { zoneId: string; recordId: string } | undefined;
    try {
      const availability = await this.cloudflare.checkHostname(preview.hostname, { zoneId: domain.zone_id });
      if (!availability.availability && availability.reason !== "CLOUDFLARE_DNS_RECORD_EXISTS") {
        throw new Error(`Preview hostname collision: ${availability.reason}`);
      }
      // ensureDnsRecord adopts only a CNAME to this exact Shelter tunnel and
      // refuses any foreign record. This makes retries after a crash safe.
      provisioned = await this.cloudflare.ensureDnsRecord(preview.hostname, domain.zone_id);
      if (!this.database.updatePullRequestPreviewDns(
        preview.id,
        preview.deployment_id,
        provisioned.zoneId,
        provisioned.recordId
      )) {
        await this.cloudflare.deleteDnsRecord(provisioned.zoneId, provisioned.recordId, preview.hostname);
      }
    } catch (error) {
      this.database.recordPullRequestPreviewDnsFailure(
        preview.id,
        `Cloudflare DNS provisioning failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
    return true;
  }
}
