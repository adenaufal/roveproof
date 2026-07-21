import { describe, expect, it } from "vitest";
import {
  findSensitiveData,
  redactHeaders,
  redactText,
  redactUrl,
  sanitizeHar,
} from "../src/redaction";

describe("evidence redaction", () => {
  it("removes fake bearer tokens, cookies, signed URLs, and request bodies from HAR", () => {
    const fakeBearer = "fake-bearer-value-123";
    const fakeCookie = "session=fake-cookie-value-456";
    const fakeSignature = "fake-signed-url-value-789";
    const fakeBody = "password=fake-body-password-000";
    const input = {
      log: {
        entries: [{
          request: {
            url: `https://target.test/checkout?X-Amz-Signature=${fakeSignature}&view=mobile`,
            headers: [
              { name: "Authorization", value: `Bearer ${fakeBearer}` },
              { name: "Cookie", value: fakeCookie },
              { name: "X-Visible", value: "kept" },
            ],
            cookies: [{ name: "session", value: "fake-cookie-value-456" }],
            queryString: [
              { name: "X-Amz-Signature", value: fakeSignature },
              { name: "view", value: "mobile" },
            ],
            postData: { mimeType: "application/json", text: fakeBody },
          },
          response: {
            headers: [{ name: "Set-Cookie", value: fakeCookie }],
            content: { size: 10, text: "secret response content" },
          },
        }],
      },
    };

    const serialized = JSON.stringify(sanitizeHar(input));
    for (const secret of [fakeBearer, fakeCookie, fakeSignature, fakeBody, "secret response content"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("kept");
    expect(serialized).toContain("mobile");
    expect(findSensitiveData(serialized)).toBeNull();
  });

  it("redacts structured headers, free text, and sensitive query parameters", () => {
    expect(redactHeaders({ Authorization: "Bearer abc123", Cookie: "sid=abc", Accept: "text/html" })).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      accept: "text/html",
    });
    expect(redactText("Authorization: Bearer abc123")).not.toContain("abc123");
    expect(redactUrl("https://example.test/a?token=abc123&lang=id")).not.toContain("abc123");
    expect(redactUrl("https://example.test/a?token=abc123&lang=id")).toContain("lang=id");
    expect(findSensitiveData('{"name":"Cookie","value":"fake-cookie"}')).toBe("structured sensitive header");
    expect(findSensitiveData('{"password":"fake-password"}')).toBe("structured sensitive value");
    expect(findSensitiveData("email=naufal@example.test")).toBe("unexpected email address");
    expect(findSensitiveData("phone=+62 899-1111-2222")).toBe("unexpected Indonesian phone number");
    expect(findSensitiveData("phone=+62 812-3456-7890; Jl. Asia Afrika No. 8")).toBeNull();
  });
});
