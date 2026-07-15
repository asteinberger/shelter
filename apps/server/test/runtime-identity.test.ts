import { describe, expect, it } from "vitest";
import {
  candidateContainerName,
  deploymentContainerName,
  deploymentContainerNames,
  isDockerDnsLabel,
  isManagedVersionedRuntimeName,
  legacyDeploymentContainerName
} from "../src/services/runtime-identity.js";

describe("versioned runtime container identity", () => {
  it("keeps a long project slug within one Docker DNS label", () => {
    const deploymentId = "dep_0123456789abcdef0123456789abcdef";
    const name = deploymentContainerName("a-very-long-project-slug-that-used-to-overflow-docker-dns-labels", deploymentId);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(isDockerDnsLabel(name)).toBe(true);
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    expect(name.endsWith("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("normalizes hostile label characters and keeps non-canonical deployment ids collision resistant", () => {
    const first = deploymentContainerName("___ÜPPER...Project___", "dep_A.B");
    const second = deploymentContainerName("___ÜPPER...Project___", "dep_a_b");

    expect(isDockerDnsLabel(first)).toBe(true);
    expect(isDockerDnsLabel(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("bounds candidate aliases and retains persisted pre-fix names as cleanup candidates", () => {
    const slug = "x".repeat(80);
    const deploymentId = "dep_abcdefabcdefabcdefabcdefabcdefab";
    const legacy = legacyDeploymentContainerName(slug, deploymentId);
    const current = deploymentContainerName(slug, deploymentId);
    const candidate = candidateContainerName(deploymentId);

    expect(legacy.length).toBeGreaterThan(63);
    expect(isManagedVersionedRuntimeName(legacy)).toBe(true);
    expect(isDockerDnsLabel(legacy)).toBe(false);
    expect(isDockerDnsLabel(current)).toBe(true);
    expect(isDockerDnsLabel(candidate)).toBe(true);
    expect(deploymentContainerNames(slug, deploymentId, legacy)).toEqual([legacy, current]);
  });
});
