export class InvalidTenantUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantUrlError";
  }
}

export interface TenantOrigins {
  tenant: string;
  shellOrigin: string;
  marketplaceOrigin: string;
  pcloudOrigin: string;
  pcloudApiBase: string;
}

const MANAGESPACE_SUFFIX = "-managespace.cyberark.cloud";
const PCLOUD_SUFFIX = "-pcloud.cyberark.cloud";
const SHELL_SUFFIX = ".cyberark.cloud";

export function deriveOrigins(currentUrl: string): TenantOrigins {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    throw new InvalidTenantUrlError(`Not a valid URL: ${currentUrl}`);
  }

  const host = url.hostname;
  let tenant: string;

  if (host.endsWith(MANAGESPACE_SUFFIX)) {
    tenant = host.slice(0, -MANAGESPACE_SUFFIX.length);
  } else if (host.endsWith(PCLOUD_SUFFIX)) {
    tenant = host.slice(0, -PCLOUD_SUFFIX.length);
  } else if (host.endsWith(SHELL_SUFFIX)) {
    tenant = host.slice(0, -SHELL_SUFFIX.length);
  } else {
    throw new InvalidTenantUrlError(`Host is not a cyberark.cloud host: ${host}`);
  }

  if (tenant.length === 0) {
    throw new InvalidTenantUrlError(`No tenant segment found in host: ${host}`);
  }

  return {
    tenant,
    shellOrigin: `https://${tenant}.cyberark.cloud`,
    marketplaceOrigin: `https://${tenant}-managespace.cyberark.cloud`,
    pcloudOrigin: `https://${tenant}-pcloud.cyberark.cloud`,
    pcloudApiBase: `https://${tenant}-pcloud.cyberark.cloud/PasswordVault/API`,
  };
}
