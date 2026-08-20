export type ExactPackageSpec = Readonly<{
  name: string;
  version: string;
}>;

export type PackageSpecValidation =
  | Readonly<{ ok: true; value: ExactPackageSpec }>
  | Readonly<{ ok: false; code: "invalid_package_spec" }>;

const MAX_PUBLIC_PACKAGE_NAME_LENGTH = 214;
const PACKAGE_PART_CHARACTERS = /^[a-z0-9._-]+$/;
const ALPHANUMERIC = /^[a-z0-9]$/;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isBoundedPackagePart(value: string): boolean {
  if (value.length === 0 || !PACKAGE_PART_CHARACTERS.test(value)) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return first !== undefined && last !== undefined && ALPHANUMERIC.test(first) && ALPHANUMERIC.test(last);
}

/** Returns whether a package name has conservative bounded public-registry syntax. */
export function isPublicPackageName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PUBLIC_PACKAGE_NAME_LENGTH) return false;
  if (!value.startsWith("@")) return isBoundedPackagePart(value);

  const slash = value.indexOf("/");
  if (slash <= 1 || slash !== value.lastIndexOf("/")) return false;
  return isBoundedPackagePart(value.slice(1, slash)) && isBoundedPackagePart(value.slice(slash + 1));
}

/**
 * Accepts only stable, exact public-registry specs. This intentionally does not
 * parse semver ranges or source protocols: every unsupported form is rejected.
 */
export function validatePackageSpec(value: string): PackageSpecValidation {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    return { ok: false, code: "invalid_package_spec" };
  }

  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!isPublicPackageName(name) || !STABLE_VERSION.test(version)) {
    return { ok: false, code: "invalid_package_spec" };
  }

  return { ok: true, value: { name, version } };
}
