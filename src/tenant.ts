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

const SHELL_SUFFIX = ".cyberark.cloud";
// Known environment suffixes on the first hostname label, checked in order and
// anchored to the END of that label so a tenant name that merely contains one
// of these strings mid-name (e.g. "foo-pcloud-test") is left untouched.
const ENV_LABEL_SUFFIXES = ["-marketplace", "-managespace", "-pcloud"];

export function deriveOrigins(currentUrl: string): TenantOrigins {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    throw new InvalidTenantUrlError(`Not a valid URL: ${currentUrl}`);
  }

  const host = url.hostname;

  if (!host.endsWith(SHELL_SUFFIX)) {
    throw new InvalidTenantUrlError(`Host is not a cyberark.cloud host: ${host}`);
  }

  let tenant = host.slice(0, -SHELL_SUFFIX.length);

  for (const suffix of ENV_LABEL_SUFFIXES) {
    if (tenant.endsWith(suffix)) {
      tenant = tenant.slice(0, -suffix.length);
      break;
    }
  }

  if (tenant.length === 0) {
    throw new InvalidTenantUrlError(`No tenant segment found in host: ${host}`);
  }

  return {
    tenant,
    shellOrigin: `https://${tenant}.cyberark.cloud`,
    marketplaceOrigin: `https://${tenant}-marketplace.cyberark.cloud`,
    pcloudOrigin: `https://${tenant}-pcloud.cyberark.cloud`,
    pcloudApiBase: `https://${tenant}-pcloud.cyberark.cloud/PasswordVault/API`,
  };
}
