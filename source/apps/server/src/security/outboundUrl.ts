import dns from "node:dns/promises";
import net from "node:net";

export interface OutboundUrlOptions {
  /** Built-in local-model providers are intentionally allowed on loopback. */
  allowLocalLoopback?: boolean;
  /** Reject public/private/link-local targets; used for local inference engines. */
  requireLoopback?: boolean;
  /** @deprecated compatibility alias */
  allowOllamaLoopback?: boolean;
}

export async function validateOutboundUrl(
  raw: string,
  options: OutboundUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid endpoint URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("endpoint must use http or https");
  }
  if (url.username || url.password) throw new Error("endpoint credentials are not allowed in URLs");

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error("endpoint hostname did not resolve");

  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (options.requireLoopback) {
      if (classification === "loopback") continue;
      throw new Error(`local endpoint must resolve only to loopback (got ${classification})`);
    }
    if (classification === "public") continue;
    if ((options.allowLocalLoopback || options.allowOllamaLoopback) && classification === "loopback") continue;
    throw new Error(`endpoint resolves to a blocked ${classification} address`);
  }
  return url;
}

type AddressClass = "public" | "loopback" | "private" | "link-local" | "reserved";

function classifyAddress(address: string): AddressClass {
  if (address.includes(":")) return classifyIpv6(address);
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "reserved";
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (
    a === 0 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113)
  ) return "reserved";
  return "public";
}

function classifyIpv6(address: string): AddressClass {
  const normalized = address.toLowerCase().split("%")[0]!;
  const words = expandIpv6(normalized);
  if (!words) return "reserved";
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "loopback";
  if (words.every((word) => word === 0) || (words[0]! & 0xff00) === 0xff00) return "reserved";
  if ((words[0]! & 0xfe00) === 0xfc00) return "private";
  if ((words[0]! & 0xffc0) === 0xfe80) return "link-local";

  // IPv4-mapped/compatible forms must inherit the embedded address class.
  // URL parsers commonly normalize ::ffff:127.0.0.1 to ::ffff:7f00:1, so a
  // dotted-suffix regex alone lets loopback/private addresses bypass the gate.
  if (words.slice(0, 5).every((word) => word === 0) &&
      (words[5] === 0xffff || words[5] === 0)) {
    return classifyAddress(`${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`);
  }

  // Translation/tunnelling/documentation ranges can conceal an IPv4 target or
  // are never appropriate provider endpoints; fail closed rather than rely on
  // host network routing policy.
  if (
    (words[0] === 0x64 && words[1] === 0xff9b) || // NAT64 well-known/local-use
    words[0] === 0x2002 || // 6to4
    (words[0] === 0x2001 && (words[1] === 0 || words[1] === 0x0db8))
  ) return "reserved";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return classifyAddress(mapped[1]!);
  return "public";
}

function expandIpv6(address: string): number[] | undefined {
  // Convert a dotted suffix before expanding the :: compression.
  let source = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(source);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) return undefined;
    const tail = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    source = source.slice(0, -dotted[1]!.length) + tail;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves[1] ? halves[1]!.split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return undefined;
  const parts = [...left, ...Array(omitted).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.map((part) => Number.parseInt(part, 16));
}
