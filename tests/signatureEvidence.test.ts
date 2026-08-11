/**
 * Signature Evidence — pure function unit tests
 * Tests hashDocument and extractClientMetadata helpers.
 */
import { describe, it, expect } from "vitest";
import { hashDocument, extractClientMetadata } from "../server/services/signatureEvidence";

describe("hashDocument", () => {
  it("produces a 64-character hex string", () => {
    const hash = hashDocument("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input always yields same hash", () => {
    const input = "rental:42|customer:Alice|total:1234.00";
    expect(hashDocument(input)).toBe(hashDocument(input));
  });

  it("different string inputs produce different hashes", () => {
    expect(hashDocument("foo")).not.toBe(hashDocument("bar"));
  });

  it("accepts a Buffer and hashes correctly", () => {
    const str = "buffer content";
    const buf = Buffer.from(str, "utf8");
    // Buffer and string with same bytes should give the same SHA-256
    expect(hashDocument(buf)).toBe(hashDocument(str));
  });

  it("empty string produces a known SHA-256 hash", () => {
    // SHA-256 of "" is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashDocument("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("long JSON document produces a consistent hash", () => {
    const doc = JSON.stringify({ rentalId: 1, totalAmount: "999.99", customerName: "Bob", signedAt: "2026-04-18T00:00:00.000Z" });
    const h1 = hashDocument(doc);
    const h2 = hashDocument(doc);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});

describe("extractClientMetadata", () => {
  it("returns null for both fields when req is empty", () => {
    const result = extractClientMetadata({});
    expect(result.ip).toBeNull();
    expect(result.userAgent).toBeNull();
  });

  it("falls back to req.ip when no x-forwarded-for header", () => {
    const result = extractClientMetadata({ ip: "192.168.1.1", headers: {} });
    expect(result.ip).toBe("192.168.1.1");
  });

  it("extracts user agent from headers", () => {
    const result = extractClientMetadata({
      headers: { "user-agent": "Mozilla/5.0 TestBrowser" },
    });
    expect(result.userAgent).toBe("Mozilla/5.0 TestBrowser");
  });

  it("honors x-forwarded-for over req.ip", () => {
    const result = extractClientMetadata({
      ip: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(result.ip).toBe("203.0.113.5");
  });

  it("takes the first IP from a comma-separated x-forwarded-for list", () => {
    const result = extractClientMetadata({
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" },
    });
    expect(result.ip).toBe("1.2.3.4");
  });

  it("handles x-forwarded-for with extra whitespace", () => {
    const result = extractClientMetadata({
      headers: { "x-forwarded-for": "  203.0.113.99 , 10.0.0.2" },
    });
    expect(result.ip).toBe("203.0.113.99");
  });

  it("returns null ip when req.ip is undefined and no forwarded header", () => {
    const result = extractClientMetadata({ headers: { "user-agent": "curl/7.0" } });
    expect(result.ip).toBeNull();
    expect(result.userAgent).toBe("curl/7.0");
  });

  it("handles IPv6 addresses in x-forwarded-for", () => {
    const result = extractClientMetadata({
      headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" },
    });
    expect(result.ip).toBe("2001:db8::1");
  });

  it("returns null when user-agent header is missing entirely", () => {
    const result = extractClientMetadata({ ip: "1.2.3.4", headers: {} });
    expect(result.userAgent).toBeNull();
  });

  it("handles x-forwarded-for as an array (multi-value headers)", () => {
    const result = extractClientMetadata({
      headers: { "x-forwarded-for": ["203.0.113.1, 10.0.0.1", "192.168.0.1"] as unknown as string },
    });
    // Should take the first element of the array, then the first IP in the list
    expect(result.ip).toBe("203.0.113.1");
  });
});
